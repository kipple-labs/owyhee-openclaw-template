# Owyhee-hardened OpenClaw — single-agent deployment image.
#
# Design rules (each enforced by test/hardening-checks.sh):
#   * No credential of any kind is baked into this image or passed as
#     container ENV. Tool credentials live in Owyhee custody (server-side);
#     the model API key arrives as a mounted secret FILE; the agent's proxy
#     bearer is minted at first boot and stored on the data volume (0600).
#   * The gateway always runs with token auth ON, and the compose file only
#     publishes it on the host loopback.
#   * Everything mutable lives under /data (one volume = the whole install).

FROM node:22-slim

# Pin the OpenClaw release this template is built against. Bump deliberately —
# the first-boot provisioner writes config via the `openclaw` CLI, so config
# compatibility is tested per-version.
ARG OPENCLAW_VERSION=2026.7.1
RUN npm install -g openclaw@${OPENCLAW_VERSION} && npm cache clean --force

# Non-root. HOME=/data so OpenClaw's state (~/.openclaw) lands on the volume.
RUN useradd --create-home --uid 10001 claw \
    && mkdir -p /data && chown claw:claw /data
USER claw
ENV HOME=/data
WORKDIR /data

COPY --chown=claw:claw provision/ /opt/owyhee/

ENTRYPOINT ["node", "/opt/owyhee/first-boot.mjs"]
