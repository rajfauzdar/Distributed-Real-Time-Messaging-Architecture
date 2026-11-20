#!/usr/bin/env bash
# Runs ON the VM (uploaded and executed by deploy.sh). Unpacks the release, writes .env once, installs the
# idle-shutdown timer and starts the stack.   usage: remote-install.sh <site-address>
set -euo pipefail
SITE_ADDRESS="$1"
APP=/opt/chitchat

sudo mkdir -p "$APP"
sudo chown "$USER" "$APP"

# fresh code every deploy; .env and docker volumes (certificates, caches) are kept
find "$APP" -mindepth 1 -maxdepth 1 ! -name '.env' -exec rm -rf {} +
tar -xzf /tmp/chitchat.tgz -C "$APP"
rm -f /tmp/chitchat.tgz

# .env is created once: MONGO_DB_URI comes from your local .env, JWT_SECRET is generated here and never leaves the VM
if [ ! -f "$APP/.env" ]; then
	{
		cat /tmp/mongo.env
		echo "JWT_SECRET=$(openssl rand -hex 32)"
		echo "SITE_ADDRESS=$SITE_ADDRESS"
	} > "$APP/.env"
	chmod 600 "$APP/.env"
fi
rm -f /tmp/mongo.env
# keep SITE_ADDRESS correct if the IP/hostname changed
sed -i "s|^SITE_ADDRESS=.*|SITE_ADDRESS=$SITE_ADDRESS|" "$APP/.env"

sudo install -m 755 "$APP/deploy/idle-shutdown.sh" /usr/local/bin/chitchat-idle-shutdown.sh
sudo install -m 644 "$APP/deploy/chitchat-idle.service" /etc/systemd/system/chitchat-idle.service
sudo install -m 644 "$APP/deploy/chitchat-idle.timer" /etc/systemd/system/chitchat-idle.timer
sudo systemctl daemon-reload
sudo systemctl enable --now chitchat-idle.timer

cd "$APP"
sudo docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
sudo docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml ps --format '{{.Name}} {{.Status}}'
