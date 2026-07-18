// First-boot provisioner — the template's entrypoint.
//
// Order of operations (idempotent; every step safe to re-run on restart):
//   1. Load the agent's Owyhee credential from the data volume, or provision
//      a CLAIMABLE account (POST /provision/claimable with the deploy email)
//      and persist the minted agent proxy token (0600, volume-only — never
//      env, never image).
//   2. Read the model API key from the mounted docker secret FILE (if any).
//   3. Write OpenClaw config via the `openclaw` CLI + a guarded JSON merge:
//      gateway token auth ON (generated token, 0600 on the volume), pinned
//      gateway port, and one MCP entry per declared Owyhee server name
//      pointed at <base>/mcp/<name> with the agent bearer.
//   4. exec the gateway in the foreground.
//
// Failure posture: a provisioning failure (network, gates, flag off) does NOT
// crash-loop the container — the gateway still starts, un-provisioned, and a
// loud banner explains what to fix. Receipts begin the moment the proxy
// credential exists and an MCP call flows.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const HOME = process.env.HOME || '/data';
const OWYHEE_DIR = join(HOME, 'owyhee');
const CREDS_PATH = join(OWYHEE_DIR, 'credentials.json');
const GATEWAY_TOKEN_PATH = join(OWYHEE_DIR, 'gateway-token');
const OPENCLAW_JSON = join(HOME, '.openclaw', 'openclaw.json');
const ANTHROPIC_SECRET_FILE = '/run/secrets/anthropic_api_key';

const BASE = (process.env.OWYHEE_BASE_URL || 'https://console.kipplelabs.com').replace(/\/$/, '');
const EMAIL = process.env.OWYHEE_DEPLOY_EMAIL || '';
const DEPLOY_TOKEN = process.env.OWYHEE_DEPLOY_TOKEN || '';
const DEPLOY_REF = process.env.OWYHEE_DEPLOY_REF || 'template';
const SERVER_NAMES = (process.env.OWYHEE_MCP_SERVERS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const GATEWAY_PORT = Number(process.env.OPENCLAW_GATEWAY_PORT || 18789);

const log = (msg) => console.log(`[owyhee-boot] ${msg}`);
const warn = (msg) => console.error(`[owyhee-boot] !! ${msg}`);

mkdirSync(OWYHEE_DIR, { recursive: true });

// ---------- 1. credential: load or provision ----------

let creds = null;
if (existsSync(CREDS_PATH)) {
  try {
    creds = JSON.parse(readFileSync(CREDS_PATH, 'utf8'));
    log(`existing credential found (${creds.token_prefix ?? 'token'}…) — provisioning skipped`);
  } catch {
    warn(`credentials file at ${CREDS_PATH} is unreadable; re-provisioning`);
  }
}

if (!creds && EMAIL) {
  try {
    const headers = { 'content-type': 'application/json' };
    if (DEPLOY_TOKEN) headers['authorization'] = `Bearer ${DEPLOY_TOKEN}`;
    const resp = await fetch(`${BASE}/provision/claimable`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: EMAIL, deploy_ref: DEPLOY_REF }),
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.ok && body.status === 'unclaimed' && body.agent_proxy_token?.token) {
      creds = {
        token: body.agent_proxy_token.token,
        token_prefix: body.agent_proxy_token.token_prefix,
        label: body.agent_proxy_token.label,
        org_id: body.org_id,
        agent_axis_id: body.agent_axis_id,
        proxy_base_url: body.proxy_base_url || BASE,
        claim_expires_at: body.claim_expires_at,
        provisioned_at: Date.now(),
      };
      writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
      chmodSync(CREDS_PATH, 0o600);
      log(`provisioned claimable Owyhee account (org ${body.org_id})`);
      log(`>>> CLAIM YOUR ACCOUNT: a claim link was ${body.claim_email_sent ? 'emailed to ' + EMAIL : 'NOT emailed (rate-capped) — re-boot later to resend'} <<<`);
      log(`unclaimed accounts expire ${body.claim_expires_at ? new Date(body.claim_expires_at).toISOString() : 'after the claim TTL'}`);
    } else if (body.status === 'already_active') {
      warn(`an Owyhee account already exists for ${EMAIL}. Sign in at ${BASE}, mint an agent proxy token on the agent page, and place it at ${CREDS_PATH} as {"token":"kga_...","proxy_base_url":"${BASE}"}.`);
    } else if (resp.status === 403 && body.error === 'not_enabled') {
      warn(`claimable provisioning is not enabled on ${BASE} — the agent will run WITHOUT Owyhee governance until provisioned. (Operator: enable it, or mint a token in the console.)`);
    } else if (resp.status === 429) {
      warn(`provisioning velocity cap hit — restart later (retry_after_seconds=${body.retry_after_seconds ?? '?'})`);
    } else if (resp.ok && body.status === 'unclaimed') {
      warn('provisioned, but the response carried no agent proxy token (older Owyhee deployment?). Mint one in the console post-claim.');
    } else {
      warn(`provisioning failed: HTTP ${resp.status} ${JSON.stringify(body).slice(0, 300)}`);
    }
  } catch (e) {
    warn(`provisioning unreachable: ${e?.message ?? e}`);
  }
} else if (!creds && !EMAIL) {
  warn('OWYHEE_DEPLOY_EMAIL is not set — skipping provisioning entirely.');
}

// ---------- 2. model key from the secret FILE (never env) ----------

let anthropicKey = null;
if (existsSync(ANTHROPIC_SECRET_FILE)) {
  anthropicKey = readFileSync(ANTHROPIC_SECRET_FILE, 'utf8').trim() || null;
  if (anthropicKey) log('model API key loaded from mounted secret file');
}
if (!anthropicKey) {
  warn('no model API key secret mounted (anthropic_api_key) — the agent cannot think until one is provided.');
}

// ---------- 3. OpenClaw config: hardening + MCP entries ----------

// Gateway token: generated once, volume-persisted, 0600. Auth is ALWAYS on —
// even if someone later re-publishes the port beyond loopback, the gateway
// still refuses unauthenticated callers.
let gatewayToken;
if (existsSync(GATEWAY_TOKEN_PATH)) {
  gatewayToken = readFileSync(GATEWAY_TOKEN_PATH, 'utf8').trim();
} else {
  gatewayToken = randomBytes(24).toString('base64url');
  writeFileSync(GATEWAY_TOKEN_PATH, gatewayToken, { mode: 0o600 });
  chmodSync(GATEWAY_TOKEN_PATH, 0o600);
  log(`gateway token generated → ${GATEWAY_TOKEN_PATH}`);
}

// Guarded merge into openclaw.json (created if absent). Only the keys this
// template owns are touched; anything an operator adds later survives.
mkdirSync(join(HOME, '.openclaw'), { recursive: true });
let cfg = {};
if (existsSync(OPENCLAW_JSON)) {
  try { cfg = JSON.parse(readFileSync(OPENCLAW_JSON, 'utf8')); } catch { cfg = {}; }
}
cfg.gateway = {
  ...(cfg.gateway ?? {}),
  port: GATEWAY_PORT,
  // In-container the gateway must accept the docker-proxied connection; the
  // compose file's 127.0.0.1 publish is what keeps it host-loopback-only.
  bind: process.env.OPENCLAW_GATEWAY_BIND || '0.0.0.0',
  auth: { ...(cfg.gateway?.auth ?? {}), mode: 'token', token: gatewayToken },
};
writeFileSync(OPENCLAW_JSON, JSON.stringify(cfg, null, 2), { mode: 0o600 });
chmodSync(OPENCLAW_JSON, 0o600);
log(`gateway hardened: port ${GATEWAY_PORT}, token auth ON`);

// MCP entries via the CLI (the version-stable config interface). Names only
// come from env; the credential comes from the volume.
if (creds?.token && SERVER_NAMES.length > 0) {
  const proxyBase = (creds.proxy_base_url || BASE).replace(/\/$/, '');
  for (const name of SERVER_NAMES) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
      warn(`skipping invalid server name '${name}'`);
      continue;
    }
    const entry = JSON.stringify({
      url: `${proxyBase}/mcp/${name}`,
      headers: { Authorization: `Bearer ${creds.token}` },
    });
    try {
      execFileSync('openclaw', ['mcp', 'set', name, entry], { stdio: ['ignore', 'ignore', 'inherit'] });
      log(`MCP server '${name}' → ${proxyBase}/mcp/${name} (governed by Owyhee)`);
    } catch (e) {
      warn(`openclaw mcp set ${name} failed: ${e?.message ?? e}`);
    }
  }
} else if (SERVER_NAMES.length > 0) {
  warn('OWYHEE_MCP_SERVERS declared but no proxy credential is available yet — MCP entries not written.');
}

log(`activity & receipts: ${BASE}/ui/ (every governed call lands in the audit trail — check "what your agent did overnight" there)`);

// ---------- 4. run the gateway (foreground) ----------

const child = spawn('openclaw', ['gateway', 'start'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    // The model key enters ONLY this process's env, read from the secret
    // file above — it is never visible in `docker inspect` or the image.
    ...(anthropicKey ? { ANTHROPIC_API_KEY: anthropicKey } : {}),
  },
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
