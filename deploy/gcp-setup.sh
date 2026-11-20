#!/usr/bin/env bash
# One-time infrastructure setup: new project, billing, firewall, static IP and the VM.
#   bash deploy/gcp-setup.sh
# Re-running is safe: existing resources are reused. Your global `gcloud config` is never changed (everything uses --project).
set -euo pipefail
cd "$(dirname "$0")"

REGION="${REGION:-asia-south1}"
ZONE="${ZONE:-asia-south1-b}"
VM="${VM:-chitchat}"
MACHINE="${MACHINE:-e2-medium}"      # 2 vCPU / 4 GB: API x2, Redis, Kafka, consumer, Caddy
DISK_GB="${DISK_GB:-30}"
STATE_FILE=".deploy.env"

# ---- project (id is remembered in deploy/.deploy.env, which is git-ignored)
if [ -f "$STATE_FILE" ]; then
	# shellcheck disable=SC1090
	source "$STATE_FILE"
fi
PROJECT_ID="${PROJECT_ID:-chitchat-$(date +%s | tail -c 7)}"

echo "Project: $PROJECT_ID   Region/zone: $REGION / $ZONE   VM: $VM ($MACHINE)"

if ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
	gcloud projects create "$PROJECT_ID" --name="ChitChat"
fi

BILLING_ACCOUNT="${BILLING_ACCOUNT:-$(gcloud billing accounts list --filter=open=true --format='value(name)' | head -n1)}"
if [ -z "$BILLING_ACCOUNT" ]; then
	echo "No open billing account found. Set up billing (with your credits) first." >&2
	exit 1
fi
gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT" >/dev/null
echo "Billing account $BILLING_ACCOUNT linked"

cat > "$STATE_FILE" <<EOF
PROJECT_ID=$PROJECT_ID
REGION=$REGION
ZONE=$ZONE
VM=$VM
EOF

export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"
gcloud services enable compute.googleapis.com

# ---- network + firewall (only 22, 80, 443 are reachable; Kafka/Redis/Mongo ports stay internal)
if ! gcloud compute networks describe default >/dev/null 2>&1; then
	gcloud compute networks create default --subnet-mode=auto
fi
gcloud compute firewall-rules describe chitchat-allow-ssh >/dev/null 2>&1 ||
	gcloud compute firewall-rules create chitchat-allow-ssh --network=default --allow=tcp:22 --target-tags=chitchat
gcloud compute firewall-rules describe chitchat-allow-web >/dev/null 2>&1 ||
	gcloud compute firewall-rules create chitchat-allow-web --network=default --allow=tcp:80,tcp:443,udp:443 --target-tags=chitchat

# ---- static IP: keeps the https URL stable across stop/start (a reserved IP is billed a little even while the VM is off)
gcloud compute addresses describe chitchat-ip --region="$REGION" >/dev/null 2>&1 ||
	gcloud compute addresses create chitchat-ip --region="$REGION"
IP=$(gcloud compute addresses describe chitchat-ip --region="$REGION" --format='value(address)')

# ---- the VM
if ! gcloud compute instances describe "$VM" --zone="$ZONE" >/dev/null 2>&1; then
	gcloud compute instances create "$VM" \
		--zone="$ZONE" \
		--machine-type="$MACHINE" \
		--image-family=debian-12 --image-project=debian-cloud \
		--boot-disk-size="${DISK_GB}GB" --boot-disk-type=pd-balanced \
		--address=chitchat-ip \
		--tags=chitchat \
		--metadata-from-file=startup-script=vm-startup.sh
fi

SITE="${IP//./-}.sslip.io"
cat <<EOF

============================================================
 Infrastructure is ready.
   Static IP : $IP
   App URL   : https://$SITE      (after the first deploy)

 BEFORE deploying: in MongoDB Atlas -> Network Access, add this IP:  $IP
 (otherwise the VM cannot reach your database)

 Then:  bash deploy/deploy.sh
============================================================
EOF
