#!/bin/sh
# Root-for-one-job entrypoint: compose mounts secrets root-owned (uid/gid in
# the long syntax are not honored for file secrets), so as root we hand the
# model key to the runtime user, then IMMEDIATELY drop privileges. No app
# code runs as root.
set -e

mkdir -p /data/owyhee
chown claw:claw /data /data/owyhee 2>/dev/null || true

if [ -r /run/secrets/anthropic_api_key ]; then
  install -o claw -g claw -m 0400 /run/secrets/anthropic_api_key /data/owyhee/model-key
fi

exec setpriv --reuid=claw --regid=claw --init-groups node /opt/owyhee/first-boot.mjs
