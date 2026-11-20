#!/usr/bin/env bash
# Ships the last COMMITTED version of the code to the VM and (re)starts the stack there.
#   bash deploy/deploy.sh
# Needs: deploy/.deploy.env (created by gcp-setup.sh) and MONGO_DB_URI in your local .env.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f deploy/.deploy.env ] || { echo "Run deploy/gcp-setup.sh first." >&2; exit 1; }
# shellcheck disable=SC1091
source deploy/.deploy.env
export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"

if [ -n "$(git status --porcelain)" ]; then
	echo "Note: you have uncommitted changes - only the last commit is deployed." >&2
fi

MONGO_LINE=$(grep -E '^MONGO_DB_URI=' .env || true)
[ -n "$MONGO_LINE" ] || { echo "MONGO_DB_URI not found in .env" >&2; exit 1; }

IP=$(gcloud compute addresses describe chitchat-ip --region="$REGION" --format='value(address)')
SITE="${IP//./-}.sslip.io"

STATUS=$(gcloud compute instances describe "$VM" --zone="$ZONE" --format='value(status)')
if [ "$STATUS" != "RUNNING" ]; then
	echo "Starting VM..."
	gcloud compute instances start "$VM" --zone="$ZONE"
fi

SSH=(gcloud compute ssh "$VM" --zone="$ZONE" --quiet --command)
echo "Waiting for the VM to accept SSH and finish installing Docker (first boot takes a few minutes)..."
for _ in $(seq 1 60); do
	if "${SSH[@]}" "command -v docker >/dev/null && sudo docker info >/dev/null 2>&1" 2>/dev/null; then break; fi
	sleep 10
done

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git archive --format=tar.gz -o "$TMP/chitchat.tgz" HEAD
printf '%s\n' "$MONGO_LINE" > "$TMP/mongo.env"

echo "Uploading..."
gcloud compute scp --zone="$ZONE" --quiet "$TMP/chitchat.tgz" "$TMP/mongo.env" deploy/remote-install.sh "$VM:/tmp/"

echo "Installing and starting (builds the image on the VM - a few minutes the first time)..."
"${SSH[@]}" "bash /tmp/remote-install.sh '$SITE' && rm -f /tmp/remote-install.sh"

echo "Waiting for https://$SITE (certificate is issued on first start)..."
for _ in $(seq 1 30); do
	if curl -fsS -m 10 "https://$SITE/healthz" >/dev/null 2>&1; then
		echo
		echo "Live:  https://$SITE"
		exit 0
	fi
	sleep 10
done
echo "Deployed, but https://$SITE isn't answering yet. Check: gcloud compute ssh $VM --zone=$ZONE --command 'sudo docker compose -f /opt/chitchat/docker-compose.yml -f /opt/chitchat/deploy/docker-compose.prod.yml logs --tail=50'" >&2
exit 1
