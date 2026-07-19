#!/bin/sh
# Entrypoint: no provider key is ever staged here — the agent's model routes
# through the Owyhee proxy, so the box holds zero model credentials. We start as
# root ONLY to fix data-volume ownership (fresh named volumes may mount
# root-owned), then IMMEDIATELY drop privileges. No app code runs as root.
set -e

mkdir -p /data/owyhee
chown claw:claw /data /data/owyhee 2>/dev/null || true

exec setpriv --reuid=claw --regid=claw --init-groups node /opt/owyhee/first-boot.mjs
