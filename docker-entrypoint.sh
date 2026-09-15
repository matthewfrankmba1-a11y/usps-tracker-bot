#!/bin/sh
set -e

# Mounted volumes (Fly, Docker, Kubernetes) arrive owned by root, so a container
# running as an unprivileged user cannot write its data file. Fix the ownership
# while we still have root, then drop privileges for the app itself.
DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$@"
fi

exec "$@"
