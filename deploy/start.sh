#!/usr/bin/env bash
# Kept for convenience - resume.sh handles every case (stopped VM, fully paused, already running).
exec bash "$(dirname "$0")/resume.sh" "$@"
