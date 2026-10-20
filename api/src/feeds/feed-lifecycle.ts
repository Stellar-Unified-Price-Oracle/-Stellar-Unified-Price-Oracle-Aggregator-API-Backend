/**
 * Governed feed onboarding lifecycle (issue #672).
 *
 * A feed moves through a fixed set of states:
 *
 *   proposed -> validated -> canary -> active -> suspended -> retired
 *
 * Every transition is authorised (role + allowed transition), and every
 * transition appends a reviewable record to the feed's change log. The record
 * is the audit evidence for "who changed what, when and why".
 */

export type FeedLifecycleState =
  | 'proposed'
  | 'validated'
  | 'canary'
  | 'active'
  | 'suspended'
  | 'retired';

export const FEED_LIFECYCLE_STATES: readonly FeedLifecycleState[] = [
  'proposed',
  'validated',
  'canary',
  'active',
  'suspended',
  'retired',
];

export type FeedLifecycleRole = 'admin' | 'operator' | 'viewer';

export type FeedTransition =
  | 'validate'
  | 'promote-to-canary'
  | 'activate'
  | 'suspend'
  | 'resume'
  | 'retire'
  | 'reject';

/** Allowed transitions per state. */
export const FEED_TRANSITIONS: Record<FeedLifecycleState, FeedTransition[]> = {
  proposed: ['validate', 'reject'],
  validated: ['promote-to-canary', 'reject'],
  canary: ['activate', 'suspend', 'reject'],
  active: ['suspend', 'retire'],
  suspended: ['resume', 'retire'],
  retired: [],
};

/** Minimum role allowed to perform a transition. */
export const FEED_TRANSITION_ROLES: Record<FeedTransition, FeedLifecycleRole> = {
  validate: 'operator',
  'promote-to-canary': 'operator',
  activate: 'admin',
  suspend: 'operator',
  resume: 'operator',
  retire: 'admin',
  reject: 'operator',
};

export interface FeedChangeRecord {
  sequence: number;
  from: FeedLifecycleState | null;
  to: FeedLifecycleState;
  transition: FeedTransition | null;
  actor: string;
  role: FeedLifecycleRole;
  at: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface FeedLifecycleEntry {
  feedId: string;
  state: FeedLifecycleState;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  /** Append-only review record of every lifecycle change. */
  changeLog: FeedChangeRecord[];
}

export type FeedLifecycleErrorCode =
  | 'FEED_NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'TRANSITION_NOT_ALLOWED'
  | 'INSUFFICIENT_ROLE'
  | 'TERMINAL_STATE';

export interface FeedLifecycleError {
  code: FeedLifecycleErrorCode;
  message: string;
}

export type FeedLifecycleResult =
  | { ok: true; entry: FeedLifecycleEntry; record: FeedChangeRecord }
  | { ok: false; error: FeedLifecycleError };

export interface FeedLifecycleStore {
  get(feedId: string): FeedLifecycleEntry | undefined;
  save(entry: FeedLifecycleEntry): void;
  list(): FeedLifecycleEntry[];
}

export function createFeedLifecycleStore(): FeedLifecycleStore {
  const entries = new Map<string, FeedLifecycleEntry>();
  return {
    get: (feedId) => entries.get(feedId),
    save: (entry) => {
      entries.set(entry.feedId, entry);
    },
    list: () => [...entries.values()],
  };
}

export interface RegisterFeedInput {
  feedId: string;
  actor: string;
  role: FeedLifecycleRole;
  reason?: string;
  metadata?: Record<string, unknown>;
  at?: string;
}

const ROLE_LEVEL: Record<FeedLifecycleRole, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
};

export function roleLevel(role: FeedLifecycleRole): number {
  return ROLE_LEVEL[role] ?? 0;
}

export function isFeedLifecycleState(value: unknown): value is FeedLifecycleState {
  return typeof value === 'string' && (FEED_LIFECYCLE_STATES as readonly string[]).includes(value);
}

/**
 * Register a new feed in the `proposed` state. A feed may only be registered
 * once; re-registering an existing feed id is a conflict, not an update.
 */
export function registerFeed(
  store: FeedLifecycleStore,
  input: RegisterFeedInput,
): FeedLifecycleResult {
  if (!input.feedId || input.feedId.trim().length === 0) {
    return { ok: false, error: { code: 'FEED_NOT_FOUND', message: 'feedId is required' } };
  }
  if (ROLE_LEVEL[input.role] < ROLE_LEVEL.operator) {
    return {
      ok: false,
      error: { code: 'INSUFFICIENT_ROLE', message: 'registering a feed requires the operator role' },
    };
  }
  if (store.get(input.feedId)) {
    return {
      ok: false,
      error: { code: 'INVALID_TRANSITION', message: `feed ${input.feedId} is already registered` },
    };
  }

  const at = input.at ?? new Date().toISOString();
  const record: FeedChangeRecord = {
    sequence: 1,
    from: null,
    to: 'proposed',
    transition: null,
    actor: input.actor,
    role: input.role,
    at,
    reason: input.reason ?? 'feed proposed',
    metadata: input.metadata,
  };

  const entry: FeedLifecycleEntry = {
    feedId: input.feedId,
    state: 'proposed',
    version: 1,
    createdAt: at,
    updatedAt: at,
    createdBy: input.actor,
    changeLog: [record],
  };
  store.save(entry);
  return { ok: true, entry, record };
}

export interface TransitionFeedInput {
  feedId: string;
  transition: FeedTransition;
  actor: string;
  role: FeedLifecycleRole;
  reason: string;
  metadata?: Record<string, unknown>;
  at?: string;
}

function nextStateFor(transition: FeedTransition): FeedLifecycleState {
  switch (transition) {
    case 'validate':
      return 'validated';
    case 'promote-to-canary':
      return 'canary';
    case 'activate':
      return 'active';
    case 'suspend':
      return 'suspended';
    case 'resume':
      return 'active';
    case 'retire':
      return 'retired';
    case 'reject':
      return 'retired';
  }
}

/**
 * Apply a lifecycle transition.
 *
 * A transition is refused when it does not exist for the current state, when
 * the actor's role is below the role the transition requires, or when the
 * feed is already in a terminal state.
 */
export function transitionFeed(
  store: FeedLifecycleStore,
  input: TransitionFeedInput,
): FeedLifecycleResult {
  const entry = store.get(input.feedId);
  if (!entry) {
    return { ok: false, error: { code: 'FEED_NOT_FOUND', message: `unknown feed ${input.feedId}` } };
  }

  if (entry.state === 'retired') {
    return {
      ok: false,
      error: { code: 'TERMINAL_STATE', message: `feed ${input.feedId} is retired and cannot change state` },
    };
  }

  const allowed = FEED_TRANSITIONS[entry.state];
  if (!allowed.includes(input.transition)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_TRANSITION',
        message: `transition ${input.transition} is not allowed from state ${entry.state}`,
      },
    };
  }

  const requiredRole = FEED_TRANSITION_ROLES[input.transition];
  if (ROLE_LEVEL[input.role] < ROLE_LEVEL[requiredRole]) {
    return {
      ok: false,
      error: {
        code: 'INSUFFICIENT_ROLE',
        message: `transition ${input.transition} requires the ${requiredRole} role`,
      },
    };
  }

  const reason = (input.reason ?? '').trim();
  if (reason.length === 0) {
    return {
      ok: false,
      error: { code: 'INVALID_TRANSITION', message: 'a reason is required for every transition' },
    };
  }

  const at = input.at ?? new Date().toISOString();
  const to = nextStateFor(input.transition);
  const record: FeedChangeRecord = {
    sequence: entry.changeLog.length + 1,
    from: entry.state,
    to,
    transition: input.transition,
    actor: input.actor,
    role: input.role,
    at,
    reason,
    metadata: input.metadata,
  };

  const updated: FeedLifecycleEntry = {
    ...entry,
    state: to,
    version: entry.version + 1,
    updatedAt: at,
    changeLog: [...entry.changeLog, record],
  };
  store.save(updated);
  return { ok: true, entry: updated, record };
}

/** States in which a feed may serve prices to consumers. */
export function isPublishableState(state: FeedLifecycleState): boolean {
  return state === 'active';
}

/** States in which a feed may serve prices to a limited canary audience. */
export function isCanaryState(state: FeedLifecycleState): boolean {
  return state === 'canary';
}
