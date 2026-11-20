#!/usr/bin/env bash
# Stops this VM when nobody has been connected for IDLE_MINUTES, so it stops costing money on its own.
# Runs every minute from a systemd timer (see chitchat-idle.timer). A stopped GCE VM is not billed for compute.
#
# "Connected" = open WebSockets, read from each API instance's /healthz. A browser tab that is logged in keeps
# a socket open, so the VM stays up while anyone is using it.
set -u

IDLE_MINUTES="${IDLE_MINUTES:-30}"    # shut down after this long with no connections
GRACE_MINUTES="${GRACE_MINUTES:-15}"  # never shut down this soon after boot (gives you time to log in)
STATE_FILE=/run/chitchat-idle-since
COMPOSE="docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml"

cd /opt/chitchat || exit 0

uptime_s=$(cut -d. -f1 /proc/uptime)
connections=0
for svc in app1 app2; do
	# an instance we can't reach counts as 0 connections: a crashed app must not keep the VM (and the bill) alive
	out=$($COMPOSE exec -T "$svc" wget -qO- http://localhost:5000/healthz 2>/dev/null) || continue
	n=$(printf '%s' "$out" | sed -n 's/.*"connections":\([0-9]*\).*/\1/p')
	connections=$((connections + ${n:-0}))
done

if [ "$connections" -gt 0 ] || [ "$uptime_s" -lt $((GRACE_MINUTES * 60)) ]; then
	rm -f "$STATE_FILE"
	exit 0
fi

now=$(date +%s)
[ -f "$STATE_FILE" ] || echo "$now" > "$STATE_FILE"
idle_since=$(cat "$STATE_FILE")

if [ $((now - idle_since)) -ge $((IDLE_MINUTES * 60)) ]; then
	logger -t chitchat-idle "no connections for ${IDLE_MINUTES} minutes - shutting down"
	shutdown -h now
fi
