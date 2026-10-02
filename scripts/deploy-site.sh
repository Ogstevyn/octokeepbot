#!/usr/bin/env bash
# Deploys site/ to Walrus Sites, or updates the existing site if
# site/ws-resources.json already holds an object_id.
#
#   scripts/deploy-site.sh            asks before spending tokens
#   scripts/deploy-site.sh --yes      no prompt (for CI)
#
# Settings, from the environment or .env:
#   WALRUS_SITE_NETWORK   mainnet (default) or testnet
#   WALRUS_SITE_EPOCHS    number of epochs, or max (default). 1 epoch is
#                         14 days on mainnet and 1 day on testnet; max is 53.
#   SITES_CONFIG          optional path to sites-config.yaml if it is not in
#                         one of the default locations
set -euo pipefail

cd "$(dirname "$0")/.."

# Read only the keys this script needs. Sourcing .env would execute it, and
# values such as a Postgres URL contain characters the shell interprets.
env_value() {
  [ -f .env ] || return 0
  { grep -E "^$1=" .env || true; } | tail -n 1 | cut -d= -f2- | tr -d '\r' | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

NETWORK="${WALRUS_SITE_NETWORK:-$(env_value WALRUS_SITE_NETWORK)}"
NETWORK="${NETWORK:-mainnet}"
EPOCHS="${WALRUS_SITE_EPOCHS:-$(env_value WALRUS_SITE_EPOCHS)}"
EPOCHS="${EPOCHS:-max}"
SITES_CONFIG="${SITES_CONFIG:-$(env_value SITES_CONFIG)}"
ASSUME_YES=false
[ "${1:-}" = "--yes" ] && ASSUME_YES=true

fail() { echo "error: $*" >&2; exit 1; }

case "$NETWORK" in
  mainnet|testnet) ;;
  *) fail "WALRUS_SITE_NETWORK must be mainnet or testnet, got '$NETWORK'" ;;
esac

for tool in site-builder walrus sui node; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed. See docs/WALRUS_SITES.md, step 1."
done

[ -f site/index.html ] || fail "site/index.html not found"

# The deployed headers and links must match site.config.json.
if ! node scripts/sync-site.mjs --check >/dev/null; then
  echo "site/ is out of date with site.config.json, syncing first."
  node scripts/sync-site.mjs
fi

OBJECT_ID="$(node -e 'const w=require("./site/ws-resources.json");process.stdout.write(w.object_id||"")')"

echo
echo "Network:       $NETWORK"
echo "Epochs:        $EPOCHS"
echo "Sui address:   $(sui client active-address 2>/dev/null || echo 'none, run: sui client new-address ed25519')"
echo "Sui env:       $(sui client active-env 2>/dev/null || echo unknown)"
if [ -n "$OBJECT_ID" ]; then
  echo "Action:        update the existing site $OBJECT_ID"
else
  echo "Action:        create a NEW site object"
fi
echo
echo "Balance (needs SUI for gas and WAL for storage):"
sui client balance 2>/dev/null || echo "  could not read the balance"
echo

if [ "$ASSUME_YES" != true ]; then
  read -r -p "Deploy now? This spends SUI and WAL. [y/N] " answer
  case "$answer" in y|Y|yes|YES) ;; *) echo "Cancelled."; exit 0 ;; esac
fi

args=(--context="$NETWORK")
[ -n "$SITES_CONFIG" ] && args+=(--config "$SITES_CONFIG")

site-builder "${args[@]}" deploy --epochs "$EPOCHS" ./site

NEW_ID="$(node -e 'const w=require("./site/ws-resources.json");process.stdout.write(w.object_id||"")')"
echo
if [ -n "$NEW_ID" ]; then
  echo "Site object ID: $NEW_ID"
  echo "Base36 form (for a local portal): $(site-builder convert "$NEW_ID" 2>/dev/null || echo 'run: site-builder convert '"$NEW_ID")"
fi
echo
echo "Next:"
echo "  1. Commit site/ws-resources.json so the next deploy updates this site instead of creating a new one:"
echo "       git add site/ws-resources.json"
echo "       git commit -m \"chore(site): record walrus site object id\""
if [ "$NETWORK" = mainnet ]; then
  echo "  2. Link your SuiNS name to the object ID at suins.io (docs/WALRUS_SITES.md, step 5)."
else
  echo "  2. Testnet has no public portal. View it with a local portal (docs/WALRUS_SITES.md, testnet section)."
fi
