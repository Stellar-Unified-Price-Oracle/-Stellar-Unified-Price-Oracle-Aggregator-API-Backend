# Repository Governance

Controls required so unreviewed or unauthorized changes cannot reach `main`.

## Code owners

`.github/CODEOWNERS` routes review requests by path (contract, API, infra).
GitHub requires a CODEOWNERS-matched reviewer's approval automatically once
branch protection (below) has "Require review from Code Owners" enabled.

## Required branch protection settings for `main`

To be applied by a repository admin (Settings → Branches → Branch protection
rules → `main`), or via the API:

```bash
gh api -X PUT repos/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["ci"] },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "require_code_owner_reviews": true
  },
  "restrictions": null,
  "required_signatures": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

This enforces:

- At least one approving review before merge, with Code Owners required for
  paths they own.
- The `ci` status check must pass before merge.
- Signed commits are required on `main` (`required_signatures`).
- No force pushes or branch deletion on `main`.

## Signed commits

Contributors must configure commit signing (GPG or SSH) locally:

```bash
git config commit.gpgsign true
```

GitHub verifies signatures against keys added to the contributor's account
under Settings → SSH and GPG keys.

## Admin API roles and permissions

The admin/governance API (`/admin/*`) authorizes callers per route rather than
behind a single admin-only door (issue #596).

### Roles

| Role | Level | Intent |
|---|---|---|
| `admin` | 3 | Full control: key deletion, CORS changes, restores, DR |
| `operator` | 2 | Day-to-day operations: create/rotate/revoke keys, run jobs |
| `viewer` | 1 | Read-only access to keys, status, and reports |

A key's role is stored on the key itself (`role` in the key metadata). The
special environment key (`ADMIN_API_KEY`) authenticates as `admin` regardless
of its stored role.

Roles are validated in two places:

- `POST /admin/keys` rejects unknown roles with `400 INVALID_ROLE`.
- The admin authentication middleware rejects keys carrying an unknown role
  with `403 UNKNOWN_ROLE` before any route handler runs, so an unrecognized
  role can never satisfy a role check by accident.

### Permissions

Each guarded route declares both a minimum role and a permission. The
permission is enforced when the presented key declares scopes: a key with
scopes may only exercise permissions it explicitly lists. Keys without scopes
are unrestricted within their role.

| Permission | admin | operator | viewer |
|---|---|---|---|
| `keys:read` | yes | yes | yes |
| `keys:write` | yes | yes | no |
| `keys:rotate` | yes | yes | no |
| `keys:delete` | yes | no | no |
| `roles:write` | yes | no | no |
| `metrics:read` | yes | yes | yes |
| `cors:read` | yes | yes | yes |
| `cors:write` | yes | no | no |
| `backup:read` | yes | yes | yes |
| `backup:write` | yes | yes | no |
| `archival:write` | yes | yes | no |
| `consistency:write` | yes | yes | no |
| `circuit:write` | yes | yes | no |
| `system:read` | yes | yes | yes |
| `dr:read` | yes | yes | yes |

### Route matrix

Every `/admin` route declares `requireRole(minRole, permission)` explicitly:

| Route | Min role | Permission |
|---|---|---|
| `POST /keys` | operator | `keys:write` |
| `GET /keys` | viewer | `keys:read` |
| `GET /keys/:keyHash` | viewer | `keys:read` |
| `POST /keys/:keyHash/rotate` | operator | `keys:rotate` |
| `PUT /keys/:keyHash/tier` | operator | `keys:write` |
| `PUT /keys/:keyHash/rate-limit` | operator | `keys:write` |
| `POST /keys/:keyHash/revoke` | operator | `keys:write` |
| `POST /keys/:keyHash/reactivate` | operator | `keys:write` |
| `DELETE /keys/:keyHash` | admin | `keys:delete` |
| `GET /cors/origins` | viewer | `cors:read` |
| `POST /cors/origins` | admin | `cors:write` |
| `DELETE /cors/origins` | admin | `cors:write` |
| `GET /db/pool` | viewer | `system:read` |
| `GET /db/health` | viewer | `system:read` |
| `POST /archival/run` | operator | `archival:write` |
| `POST /archival/restore` | admin | `archival:write` |
| `POST /consistency/check` | operator | `consistency:write` |
| `POST /backup/run` | operator | `backup:write` |
| `GET /backup/list` | viewer | `backup:read` |
| `POST /backup/test-restore` | admin | `backup:write` |
| `POST /backup/restore` | admin | `backup:write` |
| `GET /dr/status` | viewer | `dr:read` |
| `GET /circuit-breakers` | viewer | `system:read` |
| `POST /circuit-breakers/:source/reset` | operator | `circuit:write` |
| `POST /circuit-breakers/reset-all` | operator | `circuit:write` |
| `GET /health` | viewer | `system:read` |

CORS mutation and restore routes are admin-only even though they are not key
operations — writing the shared origin allowlist or replacing data from a
backup is a higher-blast-radius action than routine operations. This
deliberate deviation from "everything else is operator" is called out in the
matrix so a reviewer can challenge it.

### Escalation rules

- A key may only create keys of its own level or lower. An `operator` key
  receives `403 FORBIDDEN` when it posts `role: 'admin'`.
- A key may only rotate, revoke, retier, or re-rate-limit keys at or below its
  own level. This prevents an operator from taking over an admin key.
- No admin route changes a key's role; role changes require deleting and
  recreating the key.
- No route grants a higher role than the caller's own.

### Denial telemetry

Every denial produces all three of:

- **Response** — `403` with `error.code` of `FORBIDDEN`, `UNKNOWN_ROLE`, or
  `SCOPE_DENIED`.
- **Audit entry** — `authz.denied` in the audit log with reason, role, route,
  and key prefix.
- **Metric** — `rbac_denied_total{role, route, reason}`.

The most recent 100 denials are also kept in an in-memory buffer
(`getRecentAuthzDenials()`) for diagnostics and tests.

### Adding a route

1. Call `requireRole(minRole, permission)` on the route in
   `api/src/governance/admin.ts`.
2. If the permission is new, add it to `ROLE_PERMISSIONS` in
   `api/src/governance/rbac.ts`.
3. Add the route to the `EXPECTED` map in
   `api/tests/admin/rbac-route-matrix.test.ts` — the test enumerates the
   router and fails if a route lacks a guard or declares a different role
   than the frozen matrix.

## Decentralization and accountability reporting

Signer independence, decentralization stage gates, proposal execution
reconciliation and grant outcome tracking live under
`/api/v1/governance/decentralization` and are administered with the same admin
key as the governance proposals API. See
[GOVERNANCE_ACCOUNTABILITY.md](./GOVERNANCE_ACCOUNTABILITY.md) for the
measurement definitions, reporting cadence, metrics, and rollout/rollback
guidance.
