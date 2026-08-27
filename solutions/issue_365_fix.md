Below is a **complete, production‑ready starter kit** that satisfies the acceptance criteria:

1. **`SECURITY.md`** – Scope, out‑of‑scope, safe‑harbor, and bounty details.  
2. **`severity_tiers.json`** – A machine‑readable mapping of severity → reward.  
3. **GitHub Actions workflow** (`bounty_triage.yml`) – Automatically triages new vulnerability reports, assigns a severity, and posts a bounty comment.  
4. **Python triage helper** (`triage.py`) – The logic used by the workflow to parse the issue body and determine the reward.  

> **⚠️** Replace the placeholder values (e.g., `YOUR_BOUNTY_PLATFORM_URL`, `YOUR_BOUNTY_PLATFORM_API_KEY`) with your real data before committing.

---

## 1. `SECURITY.md`

```markdown
# Security

## Scope

- All public repositories in this organization.
- All public-facing services, APIs, and web applications.
- All code, configuration, and documentation that is publicly accessible.

## Out‑of‑Scope

- Private repositories or internal services.
- Non‑public infrastructure (e.g., internal CI/CD pipelines, private Docker registries).
- Any third‑party services that are not owned or operated by this organization.

## Safe Harbor

We welcome security research. If you discover a vulnerability, please follow the process below:

1. **Do not exploit** the vulnerability in a way that could cause harm to users or the system.
2. **Do not publish** the vulnerability publicly until we have had a chance to review it.
3. **Submit** a detailed report via the bounty platform or the dedicated intake email (`security@yourorg.com`).

We will respond within **90 days** of receipt. If you do not receive a response within that time, you may publish the vulnerability publicly.

## Bounty Program

We run a public bug bounty program on **[HackerOne](https://hackerone.com/yourorg)** (or your chosen platform).  
If you prefer to submit via email, please use `security@yourorg.com` and include the following:

- A concise title
- A detailed description
- Steps to reproduce
- Impact assessment
- Any relevant logs or screenshots

### Severity → Reward Tiers

| Severity | Reward (USD) | Example Impact |
|----------|--------------|----------------|
| Low | $50 | Minor UI glitch, non‑critical data exposure |
| Medium | $200 | Authentication bypass, moderate data exposure |
| High | $1,000 | Privilege escalation, critical data exposure |
| Critical | $5,000 | Remote code execution, full system compromise |

> **Note:** Rewards are subject to change. Please refer to the bounty platform for the most up-to-date information.

## Disclosure Policy

- **Private Disclosure**: We will keep the vulnerability confidential until it is publicly disclosed.
- **Public Disclosure**: If you choose to publish the vulnerability, you must provide us with a 90‑day notice so we can patch the issue.

Thank you for helping us keep our systems secure!
```

---

## 2. `severity_tiers.json`

```json
{
  "Low": {
    "reward": 50,
    "description": "Minor UI glitch, non‑critical data exposure"
  },
  "Medium": {
    "reward": 200,
    "description": "Authentication bypass, moderate data exposure"
  },
  "High": {
    "reward": 1000,
    "description": "Privilege escalation, critical data exposure"
  },
  "Critical": {
    "reward": 5000,
    "description": "Remote code execution, full system compromise"
  }
}
```

---

## 3. GitHub Actions Workflow – `bounty_triage.yml`

```yaml
name: Bounty Triage

on:
  issues:
    types: [opened]

jobs:
  triage:
    runs-on: ubuntu-latest
    if: contains(github.event.issue.labels.*.name, 'bug') && contains(github.event.issue.labels.*.