export type ReleaseNoteType = 'feat' | 'fix' | 'docs' | 'refactor' | 'perf' | 'chore' | 'ci' | 'breaking';

export interface ReleaseNoteEntry {
  type?: ReleaseNoteType | string;
  scope?: string;
  summary: string;
  breaking?: boolean;
}

export interface ReleaseNotesResult {
  version: string;
  generatedAt: string;
  highlights: string[];
  breakingChanges: string[];
  markdown: string;
}

function normalizeEntry(entry: ReleaseNoteEntry | string): ReleaseNoteEntry {
  if (typeof entry === 'string') {
    const match = /^([a-z]+)(\([^)]+\))?!?:\s*(.+)$/.exec(entry.trim());
    if (!match) {
      return { type: 'chore', summary: entry.trim() };
    }

    const [, rawType, rawScope, rawSummary] = match;
    return {
      type: rawType === 'breaking' ? 'breaking' : rawType as ReleaseNoteType,
      scope: rawScope ? rawScope.slice(1, -1) : undefined,
      summary: rawSummary.trim(),
      breaking: entry.includes('!') || rawType === 'breaking',
    };
  }

  return entry;
}

export function generateReleaseNotes(entries: Array<ReleaseNoteEntry | string>, version = 'unreleased'): ReleaseNotesResult {
  const data = entries.map(normalizeEntry).filter((entry) => entry.summary.length > 0);
  const highlights: string[] = [];
  const breakingChanges: string[] = [];
  const groups = new Map<string, string[]>();

  for (const entry of data) {
    const type = entry.breaking ? 'breaking' : (entry.type || 'chore');
    const label = type === 'breaking' ? 'Breaking changes' : type.toUpperCase();
    const scope = entry.scope ? `(${entry.scope})` : '';
    const item = `- ${label}${scope}: ${entry.summary}`;

    if (entry.breaking) {
      breakingChanges.push(item);
    } else {
      highlights.push(item);
    }

    const bucket = entry.breaking ? 'Breaking changes' : (entry.type || 'chore');
    const next = groups.get(bucket) || [];
    next.push(item);
    groups.set(bucket, next);
  }

  const sections = Array.from(groups.entries()).map(([bucket, items]) => {
    const title = bucket === 'Breaking changes' ? '## Breaking changes' : `## ${bucket.toUpperCase()}`;
    return `${title}\n${items.join('\n')}`;
  });

  const markdown = [
    `# ${version}`,
    '',
    '## Highlights',
    highlights.length ? highlights.join('\n') : '- No user-facing changes in this release.',
    '',
    ...sections.filter((section) => !section.includes('## Highlights')),
    '',
    ...(breakingChanges.length ? ['## Upgrade guidance', 'Review the breaking changes before upgrading.'] : []),
  ].join('\n');

  return {
    version,
    generatedAt: new Date().toISOString(),
    highlights,
    breakingChanges,
    markdown,
  };
}
