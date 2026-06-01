#!/usr/bin/env bash
# Persistent OCI launcher for VM.Standard.A1.Flex when AP-Hyderabad capacity is scarce.
# Hyderabad has a single AD; each attempt rotates placement: no fault-domain (scheduler picks),
# then FAULT-DOMAIN-{1,2,3}. Oracle docs sometimes suggest omitting --fault-domain when pinned FD fails.
#
# Tips: run overnight (e.g. 02:00–05:00 IST); OCI Cloud Shell can reduce API latency vs home ISP.
# Env: MAX_ATTEMPTS — unset defaults to 500; set to 0 for no ceiling. NTFY_TOPIC — if set, notifies via https://ntfy.sh/$NTFY_TOPIC on success.
# Usage: tmux new -s oci-a1 ./poll_a1_hyderabad.sh
#
# No -e: launch failures are handled explicitly in-loop (|| true on capture).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGFILE="${SCRIPT_DIR}/oci_a1_poll.log"
META_JSON="/tmp/oci_instance_meta.json"
SSH_PUB="${HOME}/.ssh/id_ed25519.pub"

T="ocid1.tenancy.oc1..aaaaaaaaewvfhp2zsnrelgtosfrob63q24urtghb624ehgweteoowpmgt5xa"
SUBNET="ocid1.subnet.oc1.ap-hyderabad-1.aaaaaaaa75bdcux6r6dtnqs73un5fpjvhop6lauujtruznvd43ptdcudqd4a"
IMG="ocid1.image.oc1.ap-hyderabad-1.aaaaaaaa2wqlcxuupw54kk44airukquuf77qguikgm5vqf3bk6h4utbpnfqa"
AD="QfWX:AP-HYDERABAD-1-AD-1"

OCI_PROFILE="${OCI_PROFILE:-DEFAULT}"
# Default 500 tries only when unset; MAX_ATTEMPTS=0 means no ceiling (${VAR:-500} would wrongly replace 0).
MAX_ATTEMPTS="${MAX_ATTEMPTS-500}"
NTFY_TOPIC="${NTFY_TOPIC:-}"

export OCI_PYTHON_SDK_CONNECTION_TIMEOUT="${OCI_PYTHON_SDK_CONNECTION_TIMEOUT:-90}"
export OCI_PYTHON_SDK_READ_TIMEOUT="${OCI_PYTHON_SDK_READ_TIMEOUT:-90}"

write_metadata() {
  if [[ ! -r "$SSH_PUB" ]]; then
    echo "ERROR: SSH public key not found: $SSH_PUB" >&2
    exit 1
  fi
  python3 << PY
import json
from pathlib import Path
p = Path("${SSH_PUB}")
k = p.read_text().strip()
Path("${META_JSON}").write_text(json.dumps({"ssh_authorized_keys": k}))
print(f"SSH metadata written ({len(k)} chars) -> ${META_JSON}")
PY
}

extract_instance_id() {
  python3 << 'PY'
import json, sys
try:
    d = json.load(sys.stdin)
except json.JSONDecodeError:
    sys.exit(1)
data = d.get("data") if isinstance(d, dict) else None
if not isinstance(data, dict):
    sys.exit(1)
iid = data.get("id") or ""
if not iid.startswith("ocid1.instance."):
    sys.exit(1)
print(iid)
PY
}

# Cycle placement so each batch of tries hits scheduler-auto + all three FDs.
placement_label_for_attempt() {
  local attempt="$1"
  local phase=$(( (attempt - 1) % 4 ))
  case "$phase" in
    0) echo "auto" ;;       # omit --fault-domain
    1) echo "fd1" ;;
    2) echo "fd2" ;;
    3) echo "fd3" ;;
  esac
}

fault_domain_for_label() {
  case "$1" in
    fd1) echo "FAULT-DOMAIN-1" ;;
    fd2) echo "FAULT-DOMAIN-2" ;;
    fd3) echo "FAULT-DOMAIN-3" ;;
    *) echo "" ;;
  esac
}

attempt_launch() {
  local placement_label="$1"
  local fd_name
  fd_name="$(fault_domain_for_label "$placement_label")"

  local -a fd_args=()
  if [[ -n "$fd_name" ]]; then
    fd_args=( --fault-domain "$fd_name" )
  fi

  timeout 120 oci compute instance launch \
    --profile "$OCI_PROFILE" \
    --availability-domain "$AD" \
    "${fd_args[@]}" \
    --compartment-id "$T" \
    --display-name "a1-3x24-${placement_label}-$(date +%s)-${RANDOM}" \
    --shape "VM.Standard.A1.Flex" \
    --shape-config '{"ocpus": 3.0, "memoryInGBs": 24.0}' \
    --image-id "$IMG" \
    --subnet-id "$SUBNET" \
    --assign-public-ip true \
    --boot-volume-size-in-gbs 200 \
    --metadata "file://${META_JSON}" \
    2>&1
}

main() {
  write_metadata
  echo "Logging to $LOGFILE"
  if [[ "$MAX_ATTEMPTS" == "0" ]]; then
    echo "Profile=$OCI_PROFILE AD=$AD MAX_ATTEMPTS=unlimited"
  else
    echo "Profile=$OCI_PROFILE AD=$AD MAX_ATTEMPTS=$MAX_ATTEMPTS"
  fi

  attempt=0
  while true; do
    attempt=$((attempt + 1))
    if [[ "$MAX_ATTEMPTS" =~ ^[0-9]+$ ]] && [[ "$MAX_ATTEMPTS" -gt 0 ]] && [[ "$attempt" -gt "$MAX_ATTEMPTS" ]]; then
      echo "Reached MAX_ATTEMPTS=$MAX_ATTEMPTS — exiting." | tee -a "$LOGFILE"
      exit 1
    fi

    PL="$(placement_label_for_attempt "$attempt")"
    TS="$(date '+%Y-%m-%d %H:%M:%S %z')"
    echo "" | tee -a "$LOGFILE"
    echo "[$TS] attempt $attempt placement=$PL" | tee -a "$LOGFILE"

    OUT=""
    OUT="$(attempt_launch "$PL")" || true

    if [[ -z "$OUT" ]]; then
      echo "  -> empty output (hard timeout/kill or no stderr); sleeping 90s" | tee -a "$LOGFILE"
      sleep 90
      continue
    fi

    echo "$OUT" >> "$LOGFILE"

    if INSTANCE_ID="$(echo "$OUT" | extract_instance_id)"; then
      STATE="$(echo "$OUT" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("data",{}).get("lifecycleState",""))' 2>/dev/null || true)"
      echo "SUCCESS instance_id=$INSTANCE_ID lifecycle-state=${STATE:-unknown}" | tee -a "$LOGFILE"
      echo "Poll until RUNNING:" | tee -a "$LOGFILE"
      echo "  oci compute instance get --instance-id \"$INSTANCE_ID\" --profile \"$OCI_PROFILE\"" | tee -a "$LOGFILE"
      if [[ -n "$NTFY_TOPIC" ]]; then
        curl -sS -o /dev/null "https://ntfy.sh/${NTFY_TOPIC}" \
          -H "Title: OCI A1 ready" \
          -d "OCI A1 created: ${INSTANCE_ID} (${STATE:-unknown})" &
      fi
      exit 0
    fi

    if echo "$OUT" | grep -qi "Out of host capacity\\|InsufficientServiceCapacity"; then
      SLEEP=300
      echo "  -> no A1 capacity; sleeping ${SLEEP}s" | tee -a "$LOGFILE"

    elif echo "$OUT" | grep -qiE "TooManyRequests|Too many requests for the tenant"; then
      # gentle backoff after rate-limiting
      if [[ "$attempt" -lt 5 ]]; then
        SLEEP=$((60 * attempt))
      else
        SLEEP=300
      fi
      echo "  -> rate-limited; sleeping ${SLEEP}s" | tee -a "$LOGFILE"

    elif echo "$OUT" | grep -qi "timed out\\|connection.*timeout\\|ReadTimeout"; then
      SLEEP=90
      echo "  -> API timeout; sleeping ${SLEEP}s" | tee -a "$LOGFILE"

    elif echo "$OUT" | grep -qi "LimitExceeded\\|QuotaExceeded"; then
      echo "  -> quota/limit — fix tenancy limits then restart." | tee -a "$LOGFILE"
      exit 2

    elif echo "$OUT" | grep -qi "NotAuthenticated\\|session has expired"; then
      echo "  -> auth/session expired — run: oci session authenticate (same profile)." | tee -a "$LOGFILE"
      exit 3

    else
      SLEEP=180
      echo "  -> unknown response; sleeping ${SLEEP}s (see tail of log)" | tee -a "$LOGFILE"
    fi

    sleep "$SLEEP"
  done
}

main "$@"



# defaults: 500 attempts max, no notify
# ./poll_a1_hyderabad.sh
# # run until success (no attempt ceiling)
# MAX_ATTEMPTS=0 ./poll_a1_hyderabad.sha