#!/usr/bin/env bash
# Turn the app on (the VM stops itself after ~30 idle minutes). Prints the URL when it is answering.
#   bash deploy/start.sh
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
source .deploy.env
export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"

IP=$(gcloud compute addresses describe chitchat-ip --region="$REGION" --format='value(address)')
SITE="${IP//./-}.sslip.io"

gcloud compute instances start "$VM" --zone="$ZONE" >/dev/null
echo "VM starting - waiting for https://$SITE ..."
for _ in $(seq 1 40); do
	if curl -fsS -m 10 "https://$SITE/healthz" >/dev/null 2>&1; then
		echo "Live:  https://$SITE   (stops itself after ~30 minutes without connections)"
		exit 0
	fi
	sleep 6
done
echo "Started, but not answering yet - give it another minute and try https://$SITE" >&2
