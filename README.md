# Owyhee-hardened OpenClaw

A Docker template that boots [OpenClaw](https://www.npmjs.com/package/openclaw) **pre-plumbed into [Owyhee](https://console.kipplelabs.com)**: every tool call your agent makes goes through a governed proxy — permission-gated, budgeted, kill-switchable, and receipted — and the credentials for your tools live in Owyhee custody, not on this box.

**Why:** the default self-hosted agent install pattern is an open gateway with API keys in env vars. This template inverts every one of those defaults:

| Exposed-instance default | This template |
| --- | --- |
| Gateway on 0.0.0.0, no auth | Loopback-only publish, token auth always on |
| Tool API keys in env / config files | Keys held server-side in Owyhee custody; the box holds one revocable agent credential |
| No record of what the agent did | Every governed call lands an audit receipt |
| No off switch | Suspend in the console kills the agent's next call |

## Deploy into your cloud (one click)

Don't want to run Docker yourself? Stand this up in your own cloud provider —
the agent provisions a claimable Owyhee account keyed to your email, and you
claim it from the link that lands in your inbox. Landing page with all three
paths: `deploy/landing/index.html`.

| Provider | How | Notes |
| --- | --- | --- |
| **Railway** | [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/owyhee-governed-openclaw-agent) | True one-click. Set `OWYHEE_DEPLOY_EMAIL` + `ANTHROPIC_API_KEY` when prompted; add a volume at `/data` for idempotent re-deploys. |
| **DigitalOcean** | Paste [`deploy/cloud-init-digitalocean.yml`](deploy/cloud-init-digitalocean.yml) into the droplet's **user data** box | Native 1-Click Marketplace listing in review; the script is the same thing, today. |
| **Hetzner** | `hcloud server create … --user-data-from-file deploy/cloud-init-hetzner.yml` | No native button; cloud-init works on every create surface. |

All three pass your deploy email through to Owyhee provisioning and pull the
public image `ghcr.io/machinesofdesire/owyhee-openclaw:latest` (built by
`.github/workflows/publish-image.yml`). Tool traffic is Owyhee-governed and the
gateway is never exposed publicly. See [`deploy/MARKETPLACE.md`](deploy/MARKETPLACE.md)
for the DigitalOcean Marketplace submission checklist and the one-time Railway
template publish step.

## Quickstart

```sh
git clone <this-repo> && cd <this-repo>
printf '%s' 'sk-ant-...' > anthropic_api_key.secret && chmod 600 anthropic_api_key.secret
OWYHEE_DEPLOY_EMAIL=you@example.com docker compose up -d --build
./test/hardening-checks.sh
```

First boot:
1. Provisions a **claimable Owyhee account** for your email — **check your inbox** and claim it (unclaimed accounts expire).
2. Mints the agent's proxy credential into the data volume (`0600`, never in env or the image).
3. Points OpenClaw's MCP config at the Owyhee proxy for each server named in `OWYHEE_MCP_SERVERS`.
4. Starts the gateway: token auth on, loopback-only.

After claiming, open the console → **Connected Services** to add tool servers (their credentials go straight into custody), and the agent page to grant tools, set budgets, or hit the kill switch. The **Activity** view is "what your agent did overnight."

## Configuration

| Env | Required | Meaning |
| --- | --- | --- |
| `OWYHEE_DEPLOY_EMAIL` | yes | Receives the claim link; owns the account. |
| `OWYHEE_BASE_URL` | no | Owyhee deployment (default `https://console.kipplelabs.com`). |
| `OWYHEE_MCP_SERVERS` | no | Comma-separated server *names* from your console — names only, never credentials. |
| `OWYHEE_DEPLOY_TOKEN` | no | Deploy gate token, if the Owyhee deployment requires one. |
| `OWYHEE_DEPLOY_REF` | no | Label for this deploy (audit + credential labels). |
| `OPENCLAW_GATEWAY_PORT` | no | Gateway port (default 18789). |

The model API key rides a **docker secret file** (`anthropic_api_key.secret`), never env. Brokering the model key through Owyhee custody as well (so the box holds *zero* provider keys) is on the roadmap.

## Operational notes

- **Re-boots are idempotent.** Same email → same account; the credential persists on the `openclaw-data` volume. A fresh volume re-provisions and mints a new (individually revocable) credential.
- **Kill switch:** suspend the agent (or a whole server) in the console; the next proxied call is refused with a reason. Revoking the proxy token cuts access immediately.
- **Spend caps:** set hourly/daily token budgets on the agent page after claiming. (Default-on caps at provision time are a roadmap item.)
- **The gateway is yours; the governance is Owyhee's.** Direct outbound traffic from the box (curl, npm, the model API) is *not* governed — the proxy governs tool/MCP traffic. Keep tool credentials out of this box and that boundary holds.

## License

TBD — not yet licensed for redistribution.
