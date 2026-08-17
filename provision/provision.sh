#!/usr/bin/env bash
# provision.sh, create a fleet VPS on Hetzner Cloud (port layout §9/§11).
#
# Runs on the LAPTOP. Default is DRY: prints the exact commands it would run and exits
# (first-execution-dry-run doctrine). Pass --apply to execute them.
#
# Requires: hcloud CLI; HCLOUD_TOKEN in ~/.config/cockpit/env (never on the command line);
# a per-target ed25519 public key (one keypair per box, generated on the laptop, no master
# key, layout §9), e.g.: ssh-keygen -t ed25519 -f ~/.ssh/cockpit-<name> -C cockpit-<name>
#
# Usage:
#   provision.sh --name <server> --ssh-key <path/to/key.pub> [--user cockpit] [--type cx33] [--location nbg1] [--apply]
#
# The existing `cockpit` server (CX33, nbg1) was provisioned 2026-07-24 with an equivalent
# config; running this against a name that already exists will fail at hcloud, by design.

set -euo pipefail

NAME=""
SSH_PUB=""
USERNAME="cockpit"
SERVER_TYPE="cx33"
LOCATION="nbg1"
IMAGE="ubuntu-24.04"
FIREWALL="cockpit-fw"
APPLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --ssh-key) SSH_PUB="$2"; shift 2 ;;
    --user) USERNAME="$2"; shift 2 ;;
    --type) SERVER_TYPE="$2"; shift 2 ;;
    --location) LOCATION="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

[ -n "$NAME" ] || { echo "provision.sh: --name is required" >&2; exit 1; }
[ -n "$SSH_PUB" ] && [ -f "$SSH_PUB" ] || { echo "provision.sh: --ssh-key <path.pub> is required and must exist" >&2; exit 1; }

ENV_FILE="$HOME/.config/cockpit/env"
if [ -z "${HCLOUD_TOKEN:-}" ] && [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi
[ -n "${HCLOUD_TOKEN:-}" ] || { echo "provision.sh: HCLOUD_TOKEN not set (expected in $ENV_FILE)" >&2; exit 1; }
export HCLOUD_TOKEN

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
TEMPLATE="$SCRIPT_DIR/cloud-init.yaml"
[ -f "$TEMPLATE" ] || { echo "provision.sh: missing $TEMPLATE" >&2; exit 1; }

# Render user-data: substitute the per-target public key and account name into the template.
PUBKEY="$(cat "$SSH_PUB")"
USER_DATA="$(mktemp)"
trap 'rm -f "$USER_DATA"' EXIT
sed -e "s|__SSH_PUBLIC_KEY__|$PUBKEY|" -e "s|__USERNAME__|$USERNAME|g" "$TEMPLATE" > "$USER_DATA"

# hcloud also wants the key registered so console access works; idempotent by name.
KEY_NAME="cockpit-$NAME"

run() {
  if [ "$APPLY" -eq 1 ]; then
    echo "+ $*"
    "$@"
  else
    echo "DRY: $*"
  fi
}

echo "provision.sh: target=$NAME user=$USERNAME type=$SERVER_TYPE location=$LOCATION image=$IMAGE firewall=$FIREWALL"
[ "$APPLY" -eq 1 ] || echo "provision.sh: DRY RUN, pass --apply to execute. Commands:"

if [ "$APPLY" -eq 1 ] && hcloud ssh-key describe "$KEY_NAME" >/dev/null 2>&1; then
  echo "provision.sh: ssh-key $KEY_NAME already registered, skipping"
else
  run hcloud ssh-key create --name "$KEY_NAME" --public-key-from-file "$SSH_PUB"
fi

# Firewall, convergent: create cockpit-fw if absent, then add only the missing rules on
# every apply (a half-created firewall from an interrupted run converges instead of being
# skipped). Default deny is implicit, hcloud firewalls only allow what rules permit, so
# SSH + mosh (UDP 60000-61000) + ICMP inbound matches the live box's cockpit-fw exactly.
has_rule() {
  # $1 = protocol (tcp|icmp), $2 = port ("" for icmp); reads the firewall's rule list.
  hcloud firewall describe "$FIREWALL" -o json 2>/dev/null | python3 -c '
import json, sys
proto, port = sys.argv[1], sys.argv[2]
fw = json.load(sys.stdin)
for r in fw.get("rules", []):
    if r.get("direction") == "in" and r.get("protocol") == proto and (not port or r.get("port") == port):
        sys.exit(0)
sys.exit(1)' "$1" "$2"
}
if [ "$APPLY" -eq 1 ]; then
  if hcloud firewall describe "$FIREWALL" >/dev/null 2>&1; then
    echo "provision.sh: firewall $FIREWALL exists"
  else
    run hcloud firewall create --name "$FIREWALL"
  fi
  if has_rule tcp 22; then
    echo "provision.sh: inbound tcp/22 rule present"
  else
    run hcloud firewall add-rule "$FIREWALL" --direction in --protocol tcp --port 22 --source-ips 0.0.0.0/0 --source-ips ::/0
  fi
  if has_rule udp 60000-61000; then
    echo "provision.sh: inbound udp/60000-61000 (mosh) rule present"
  else
    run hcloud firewall add-rule "$FIREWALL" --direction in --protocol udp --port 60000-61000 --source-ips 0.0.0.0/0 --source-ips ::/0 --description mosh
  fi
  if has_rule icmp ""; then
    echo "provision.sh: inbound icmp rule present"
  else
    run hcloud firewall add-rule "$FIREWALL" --direction in --protocol icmp --source-ips 0.0.0.0/0 --source-ips ::/0
  fi
else
  run hcloud firewall create --name "$FIREWALL"
  run hcloud firewall add-rule "$FIREWALL" --direction in --protocol tcp --port 22 --source-ips 0.0.0.0/0 --source-ips ::/0
  run hcloud firewall add-rule "$FIREWALL" --direction in --protocol udp --port 60000-61000 --source-ips 0.0.0.0/0 --source-ips ::/0 --description mosh
  run hcloud firewall add-rule "$FIREWALL" --direction in --protocol icmp --source-ips 0.0.0.0/0 --source-ips ::/0
fi

run hcloud server create \
  --name "$NAME" \
  --type "$SERVER_TYPE" \
  --location "$LOCATION" \
  --image "$IMAGE" \
  --firewall "$FIREWALL" \
  --ssh-key "$KEY_NAME" \
  --user-data-from-file "$USER_DATA"

if [ "$APPLY" -eq 0 ]; then
  echo "DRY: (user-data rendered from $TEMPLATE with key $SSH_PUB; temp file not kept)"
  echo "After apply: add an ~/.ssh/config Host entry with the per-target IdentityFile, then"
  echo "run provision/install.sh ON the box (layout §11)."
fi
