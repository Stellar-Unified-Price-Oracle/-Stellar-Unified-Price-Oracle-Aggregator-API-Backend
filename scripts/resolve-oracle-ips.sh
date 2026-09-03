#!/usr/bin/env bash
# scripts/resolve-oracle-ips.sh
#
# Resolves the current IP addresses for every oracle source FQDN and prints
# the CIDR blocks suitable for use in Terraform and NetworkPolicy manifests.
#
# Run this before every mainnet release and update:
#   infrastructure/terraform/modules/egress-allowlist/main.tf
#   k8s/overlays/prod/networkpolicy-egress-patch.yaml
#
# Dependencies: dig (bind-utils), jq
set -euo pipefail

FQDNS=(
  "min-api.cryptocompare.com"
  "api.redstone.finance"
  "laozi1.bandchain.org"
  "api.reflector.xyz"
  "soroban-testnet.stellar.org"
  "soroban-mainnet.stellar.org"
  "horizon.stellar.org"
)

log() { echo "[$(date -u +%H:%M:%S)] $*" >&2; }

resolve_fqdn() {
  local fqdn="$1"
  # Collect unique /32 CIDRs from A records; collapse if they share a /24
  local ips
  ips=$(dig +short A "$fqdn" 2>/dev/null | grep -E '^[0-9]+\.' | sort -u)

  if [[ -z "$ips" ]]; then
    log "WARNING: no A records for ${fqdn}"
    echo "# ${fqdn}: UNRESOLVED"
    return
  fi

  echo "# ${fqdn}"
  while IFS= read -r ip; do
    echo "  ${ip}/32"
  done <<< "$ips"
}

echo "# Oracle FQDN → IP resolution"
echo "# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# Usage: update Terraform egress-allowlist module and prod NetworkPolicy patch"
echo ""

for fqdn in "${FQDNS[@]}"; do
  resolve_fqdn "$fqdn"
  echo ""
done
