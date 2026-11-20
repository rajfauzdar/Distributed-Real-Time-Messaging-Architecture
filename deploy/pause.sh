#!/usr/bin/env bash
# FULL PAUSE: saves the VM's disk as a snapshot, then deletes the VM, its disk and the static IP.
# Afterwards almost nothing is billed (just the snapshot: pennies). Your users and messages live in Atlas and are unaffected.
#   bash deploy/pause.sh          (asks for confirmation)
#   bash deploy/pause.sh --yes    (no question)
# Bring it back with:  bash deploy/resume.sh     (new IP => new URL, and the new IP must be added in Atlas)
set -euo pipefail
cd "$(dirname "$0")"

[ -f .deploy.env ] || { echo "No deploy/.deploy.env - nothing to pause." >&2; exit 1; }
# shellcheck disable=SC1091
source .deploy.env
export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"

set_var() { { grep -v "^$1=" .deploy.env || true; echo "$1=$2"; } > .deploy.env.tmp && mv .deploy.env.tmp .deploy.env; }
vm_status() { gcloud compute instances describe "$VM" --zone="$ZONE" --format='value(status)' 2>/dev/null || true; }

STATUS=$(vm_status)
if [ -z "$STATUS" ]; then
	echo "Already paused (no VM exists). Resume with: bash deploy/resume.sh"
	exit 0
fi

if [ "${1:-}" != "--yes" ]; then
	echo "This will DELETE the VM, its disk and the static IP (a snapshot is kept so you can resume)."
	read -r -p "Type 'pause' to continue: " answer
	[ "$answer" = "pause" ] || { echo "Cancelled."; exit 1; }
fi

if [ "$STATUS" = "RUNNING" ]; then
	echo "Stopping the containers cleanly (so Kafka and the consumer flush) and then the VM..."
	gcloud compute ssh "$VM" --zone="$ZONE" --quiet --command \
		"cd /opt/chitchat && sudo docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml stop -t 20" || true
	gcloud compute instances stop "$VM" --zone="$ZONE"
fi

SNAP="chitchat-snap-$(date +%Y%m%d-%H%M%S)"
echo "Creating snapshot $SNAP ..."
gcloud compute snapshots create "$SNAP" --source-disk="$VM" --source-disk-zone="$ZONE" --storage-location="$REGION"
if [ "$(gcloud compute snapshots describe "$SNAP" --format='value(status)')" != "READY" ]; then
	echo "Snapshot is not READY - NOT deleting anything." >&2
	exit 1
fi
set_var SNAPSHOT "$SNAP"

echo "Deleting the VM and its disk..."
gcloud compute instances delete "$VM" --zone="$ZONE" --delete-disks=all --quiet
echo "Releasing the static IP..."
gcloud compute addresses delete chitchat-ip --region="$REGION" --quiet 2>/dev/null || true

# keep only the newest snapshot (snapshots are incremental, so deleting older ones is safe)
gcloud compute snapshots list --filter="name~^chitchat-snap- AND name!=$SNAP" --format='value(name)' |
	xargs -r -n1 gcloud compute snapshots delete --quiet

cat <<EOF

============================================================
 Paused. Nothing is running; only the snapshot ($SNAP) is kept.
 Resume any time with:   bash deploy/resume.sh
 (it gets a NEW IP -> you add that IP in Atlas -> Network Access, and the URL changes)
 You can delete the old IP's entry from Atlas now.
============================================================
EOF
