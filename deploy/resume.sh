#!/usr/bin/env bash
# ONE command to bring the app back, whatever state it is in:
#   - fully paused (after pause.sh)  -> rebuilds the VM from the snapshot (~4 min), new IP + new URL
#   - VM stopped                     -> starts it (~1 min), same URL
#   - already running                -> just prints the URL
#   bash deploy/resume.sh
set -euo pipefail
cd "$(dirname "$0")"

[ -f .deploy.env ] || { echo "No deploy/.deploy.env - run deploy/gcp-setup.sh and deploy/deploy.sh first." >&2; exit 1; }
# shellcheck disable=SC1091
source .deploy.env
export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"

# gcloud on Windows ends lines with , which would silently corrupt values - always strip it
vm_status() { gcloud compute instances describe "$VM" --zone="$ZONE" --format='value(status)' 2>/dev/null | tr -d '\r' || true; }
get_ip() { gcloud compute addresses describe chitchat-ip --region="$REGION" --format='value(address)' | tr -d '\r'; }
STATUS=$(vm_status)
REBUILT=0

if [ -z "$STATUS" ]; then
	[ -n "${SNAPSHOT:-}" ] || { echo "No VM and no snapshot to resume from. Run deploy/gcp-setup.sh + deploy/deploy.sh." >&2; exit 1; }
	echo "Resuming from snapshot $SNAPSHOT ..."

	gcloud compute disks describe "$VM" --zone="$ZONE" >/dev/null 2>&1 ||
		gcloud compute disks create "$VM" --zone="$ZONE" --source-snapshot="$SNAPSHOT" --type=pd-balanced
	gcloud compute addresses describe chitchat-ip --region="$REGION" >/dev/null 2>&1 ||
		gcloud compute addresses create chitchat-ip --region="$REGION"
	IP=$(get_ip)

	cat <<EOF

============================================================
 NEW IP ADDRESS:  $IP
 Add it now in MongoDB Atlas -> Network Access -> Add IP Address
 (the old IP can be removed). The app comes up by itself once it is Active.
============================================================
EOF
	# convenience on Windows: put the IP on the clipboard
	command -v clip.exe >/dev/null 2>&1 && printf '%s' "$IP" | clip.exe && echo "(IP copied to the clipboard)"

	gcloud compute instances create "$VM" \
		--zone="$ZONE" --machine-type="${MACHINE:-e2-medium}" \
		--disk="name=$VM,boot=yes,auto-delete=yes" \
		--address=chitchat-ip --tags=chitchat \
		--metadata-from-file=startup-script=vm-startup.sh
	REBUILT=1
elif [ "$STATUS" != "RUNNING" ]; then
	echo "Starting the VM..."
	gcloud compute instances start "$VM" --zone="$ZONE" >/dev/null
fi

IP=$(get_ip)
SITE="${IP//./-}.sslip.io"

if [ "$REBUILT" = 1 ]; then
	echo "Waiting for the VM to accept SSH..."
	for _ in $(seq 1 40); do
		gcloud compute ssh "$VM" --zone="$ZONE" --quiet --command "true" >/dev/null 2>&1 && break
		sleep 8
	done
	# the hostname is derived from the IP, so point the stack at the new one (Caddy then gets a certificate for it)
	gcloud compute ssh "$VM" --zone="$ZONE" --quiet --command \
		"cd /opt/chitchat && sudo sed -i 's|^SITE_ADDRESS=.*|SITE_ADDRESS=$SITE|' .env && sudo docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d"
fi

echo "Waiting for https://$SITE ..."
for i in $(seq 1 60); do
	if curl -fsS -m 10 "https://$SITE/healthz" >/dev/null 2>&1; then
		echo
		echo "Live:  https://$SITE    (stops itself after ~30 minutes without connections)"
		exit 0
	fi
	if [ "$REBUILT" = 1 ] && [ $((i % 6)) -eq 0 ]; then
		echo "  still waiting... did you add $IP in Atlas -> Network Access (and is it Active)?"
	fi
	sleep 10
done
echo "Not answering yet. Check Atlas Network Access for $IP, then open https://$SITE" >&2
exit 1
