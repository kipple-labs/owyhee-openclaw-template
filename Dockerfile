# Owyhee-hardened OpenClaw — single-agent deployment image.
#
# Design rules (each enforced by test/hardening-checks.sh):
#   * No credential of any kind is baked into this image or passed as
#     container ENV. Tool credentials AND the model key live in Owyhee custody
#     (server-side); the agent holds only its proxy bearer, minted at first boot
#     and stored on the data volume (0600). The model routes through the Owyhee
#     proxy, so no provider key ever touches this box.
#   * The gateway always runs with token auth ON, and the compose file only
#     publishes it on the host loopback.
#   * Everything mutable lives under /data (one volume = the whole install).

FROM node:22-slim

# Pin the OpenClaw release this template is built against. Bump deliberately —
# the first-boot provisioner writes config via the `openclaw` CLI, so config
# compatibility is tested per-version.
ARG OPENCLAW_VERSION=2026.7.1
RUN npm install -g openclaw@${OPENCLAW_VERSION} && npm cache clean --force

# Non-root runtime. HOME=/data so OpenClaw's state (~/.openclaw) lands on the
# volume. The entrypoint starts as root ONLY to fix data-volume ownership, then
# drops to uid 10001 via setpriv before any app code runs.
RUN useradd --create-home --uid 10001 claw \
    && mkdir -p /data && chown claw:claw /data
ENV HOME=/data
WORKDIR /data

COPY provision/ /opt/owyhee/
RUN chmod +x /opt/owyhee/entrypoint.sh

ENTRYPOINT ["/opt/owyhee/entrypoint.sh"]
