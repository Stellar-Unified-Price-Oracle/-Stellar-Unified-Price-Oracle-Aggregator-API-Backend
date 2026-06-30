# Rollback quick reference

See [rollback.md](rollback.md) for full abort and recovery procedures.

```bash
export CHAOS_TARGET_ENV=staging
kubectl -n stellar-oracle delete podchaos,networkchaos,stresschaos,dnschaos,workflows --all
kubectl -n stellar-oracle patch schedule weekly-chaos-schedule --type merge -p '{"spec":{"suspend":true}}'
```
