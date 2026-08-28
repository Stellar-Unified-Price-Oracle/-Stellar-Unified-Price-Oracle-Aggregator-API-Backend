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
