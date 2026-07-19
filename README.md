# Owyhee-hardened OpenClaw

A Docker template that boots [OpenClaw](https://www.npmjs.com/package/openclaw) **pre-plumbed into [Owyhee](https://console.kipplelabs.com)**: every tool call your agent makes goes through a governed proxy — permission-gated, budgeted, kill-switchable, and receipted — and the credentials for your tools live in Owyhee custody, not on this box.

**Why:** the default self-hosted agent install pattern is an open gateway with API keys in env vars. This template inverts every one of those defaults:

| Exposed-instance default | This template |
| --- | --- |
| Gateway on 0.0.0.0, no auth | Loopback-only publish, token auth always on |
| Tool + model API keys in env / config files | All keys held server-side in Owyhee custody; the box holds one revocable agent credential |
| No record of what the agent did | Every governed call lands an audit receipt |
| No off switch | Suspend in the console kills the agent's next call |

## Deploy into your cloud (one click)

Don't want to run Docker yourself? Stand this up in your own cloud provider —
the agent provisions a claimable Owyhee account keyed to your email, and you
claim it from the link that lands in your inbox. Landing page with all three
paths: `deploy/landing/index.html`.

| Provider | How | Notes |
| --- | --- | --- |
| **Railway** | [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/owyhee-governed-openclaw-agent) | True one-click. Set `OWYHEE_DEPLOY_EMAIL` when prompted (no model key needed); add a volume at `/data` for idempotent re-deploys. |
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
OWYHEE_DEPLOY_EMAIL=you@example.com docker compose up -d --build
./test/hardening-checks.sh
```

No model key on the box — after first boot, claim your account and connect an
LLM provider (OpenRouter recommended) in the console (see below).

First boot:
1. Provisions a **claimable Owyhee account** for your email — **check your inbox** and claim it (unclaimed accounts expire).
2. Mints the agent's proxy credential into the data volume (`0600`, never in env or the image).
3. Points OpenClaw's MCP config **and its model provider** at the Owyhee proxy — the box holds no provider key.
4. Starts the gateway: token auth on, loopback-only.

After claiming, open the console → **Connected Services** to connect an **LLM provider** (OpenRouter recommended — one key, hundreds of models) so the agent can think, plus any tool servers (all credentials go straight into custody). Use the agent page to grant tools, set budgets, or hit the kill switch. The **Activity** view is "what your agent did overnight" — model spend is receipted there too.

## Configuration

| Env | Required | Meaning |
| --- | --- | --- |
| `OWYHEE_DEPLOY_EMAIL` | yes | Receives the claim link; owns the account. |
| `OWYHEE_BASE_URL` | no | Owyhee deployment (default `https://console.kipplelabs.com`). |
| `OWYHEE_MCP_SERVERS` | no | Comma-separated server *names* from your console — names only, never credentials. |
| `OWYHEE_DEPLOY_TOKEN` | no | Deploy gate token, if the Owyhee deployment requires one. |
| `OWYHEE_DEPLOY_REF` | no | Label for this deploy (audit + credential labels). |
| `OPENCLAW_GATEWAY_PORT` | no | Gateway port (default 18789). |
| `OWYHEE_LLM_SERVER` | no | The `is_llm_provider` server (from your console) the model routes through (default `openrouter`). |
| `OWYHEE_MODEL` | no | Default model slug OpenClaw sends (default `openrouter/auto`); match it to your connected provider. |

The box holds **zero provider keys** — the agent's model routes through the Owyhee proxy, which injects the custodied upstream key (OpenRouter, Anthropic, …) and forwards. Connect your LLM provider once under **Connected Services**; the model call is then token-metered, budgeted, kill-switchable, and receipted like every other action.

## Operational notes

- **Re-boots are idempotent.** Same email → same account; the credential persists on the `openclaw-data` volume. A fresh volume re-provisions and mints a new (individually revocable) credential.
- **Kill switch:** suspend the agent (or a whole server) in the console; the next proxied call is refused with a reason. Revoking the proxy token cuts access immediately.
- **Spend caps:** set hourly/daily token budgets on the agent page after claiming. (Default-on caps at provision time are a roadmap item.)
- **The gateway is yours; the governance is Owyhee's.** The agent's tool/MCP calls **and its model calls** route through the Owyhee proxy, so both are governed and receipted. Other direct outbound traffic from the box (curl, npm) is not — keep all credentials in custody and that boundary holds.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT No Attribution License ([LICENSE-MIT-0](LICENSE-MIT-0))

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this work by you shall be dual-licensed as above, without any
additional terms or conditions.
