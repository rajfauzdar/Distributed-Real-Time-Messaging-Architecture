#!/usr/bin/env bash
# Turn the app off right now (stops compute billing; the disk and static IP stay).
#   bash deploy/stop.sh
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
source .deploy.env
export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"
gcloud compute instances stop "$VM" --zone="$ZONE"
echo "Stopped."
