# Deploy-button setup + submissions

Owner steps to make the buttons live. The configs in this directory are ready;
these are the account-scoped actions only the repo/cloud owner can take.

## 1. Publish the public image (enabler for all three paths)

`.github/workflows/publish-image.yml` builds and pushes
`ghcr.io/machinesofdesire/owyhee-openclaw` on every push to `main`.

- After the first successful run, set the package to **public**: GitHub →
  your profile/org → Packages → `owyhee-openclaw` → Package settings → Change
  visibility → Public. Until then, cloud-init `docker run` pulls fail for
  anyone without a token.

## 2. Railway — publish the template (one-time)

Railway's one-click button needs a *published template* whose code the button
URL references.

1. Sign in to Railway → New → Deploy from GitHub repo → this repo (connect the
   private repo to your Railway account, or point at the public GHCR image).
2. Define the service variables the template exposes to the deployer:
   `OWYHEE_DEPLOY_EMAIL` (required — no model key: the model routes through the
   Owyhee proxy), `OWYHEE_BASE_URL` (default `https://console.kipplelabs.com`),
   `OWYHEE_MCP_SERVERS`, `OWYHEE_DEPLOY_TOKEN`,
   `OWYHEE_LLM_SERVER` (default `openrouter`), `OWYHEE_MODEL` (default
   `openrouter/auto`), `OWYHEE_DEPLOY_REF=railway`.
3. Add a **volume mounted at `/data`** so re-deploys reuse the claimable account.
4. Do NOT attach a public domain — the gateway stays private (governance is
   outbound to Owyhee).
5. Publish the template. Railway gives a URL like
   `https://railway.com/new/template/<code>`.
6. Replace the placeholder `owyhee-openclaw` in the README button link and in
   `deploy/landing/index.html` with `<code>`.

**Acceptance (Brief 4):** one live deploy from the published button on a clean
Railway account → the agent boots → a claim email arrives → claim the account.
Screenshot the running service + the claim email for the PR.

## 3. DigitalOcean — 1-Click Marketplace submission (start, don't block)

The cloud-init script (`cloud-init-digitalocean.yml`) works today. The native
Marketplace button is a vendor-review process:

1. DigitalOcean → Vendor Portal (`marketplace.digitalocean.com/vendor`) →
   apply as a vendor if not already.
2. Create a **1-Click App** built on a base Ubuntu 24.04 image with the Docker
   run baked into the image's first-boot (mirror the cloud-init `runcmd`).
3. Submit for review. Listings take days–weeks; the paste-in cloud-init covers
   users in the meantime.

## 4. Hetzner

No marketplace step — cloud-init is the whole path. Nothing owner-side needed.
