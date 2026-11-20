#!/usr/bin/env bash
# GCE startup script: runs as root on EVERY boot. Installs Docker the first time; afterwards makes sure the app is up.
# (Containers also carry `restart: unless-stopped`, so after a boot they normally come back by themselves.)
set -eu

if ! command -v docker >/dev/null 2>&1; then
	apt-get update -y
	apt-get install -y ca-certificates curl git
	curl -fsSL https://get.docker.com | sh
	systemctl enable --now docker
fi

if [ -f /opt/chitchat/.env ]; then
	cd /opt/chitchat
	docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d
fi
