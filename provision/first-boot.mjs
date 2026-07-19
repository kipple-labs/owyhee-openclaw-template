// First-boot provisioner — the template's entrypoint.
//
// Order of operations (idempotent; every step safe to re-run on restart):
//   1. Load the agent's Owyhee credential from the data volume, or provision
//      a CLAIMABLE account (POST /provision/claimable with the deploy email)
//      and persist the minted agent proxy token (0600, volume-only — never
//      env, never image).
//   2. Write OpenClaw config via the `openclaw` CLI + a guarded JSON merge:
//      gateway token auth ON (generated token, 0600 on the volume), pinned
//      gateway port, the MODEL provider pointed at the Owyhee proxy (so the
//      box holds NO provider key), and one MCP entry per declared Owyhee
//      server name pointed at <base>/mcp/<name> with the agent bearer.
//   3. exec the gateway in the foreground.
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

const BASE = (process.env.OWYHEE_BASE_URL || 'https://console.kipplelabs.com').replace(/\/$/, '');
const EMAIL = process.env.OWYHEE_DEPLOY_EMAIL || '';
const DEPLOY_TOKEN = process.env.OWYHEE_DEPLOY_TOKEN || '';
const DEPLOY_REF = process.env.OWYHEE_DEPLOY_REF || 'template';
const SERVER_NAMES = (process.env.OWYHEE_MCP_SERVERS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const GATEWAY_PORT = Number(process.env.OPENCLAW_GATEWAY_PORT || 18789);
// The LLM upstream to route the model through — the is_llm_provider server the
// operator connects in their Owyhee console. Which provider is a deployment /
// backend choice; the values below are just the fallback route + slug (kept in
// ONE place so the default can change centrally). Override to match whatever you
// connect.
const LLM_SERVER = (process.env.OWYHEE_LLM_SERVER || 'openrouter').trim();
const DEFAULT_MODEL = (process.env.OWYHEE_MODEL || 'openrouter/auto').trim();
// OpenClaw provider API shape for the upstream: 'openai-completions' (default —
// covers OpenRouter and most OpenAI-compatible proxies) or 'anthropic-messages'.
const LLM_API = (process.env.OWYHEE_LLM_API || 'openai-completions').trim();

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

// ---------- 2. OpenClaw config: hardening + model routing + MCP entries ----------

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
const proxyBase = (creds?.proxy_base_url || BASE).replace(/\/$/, '');
let cfg = {};
if (existsSync(OPENCLAW_JSON)) {
  try { cfg = JSON.parse(readFileSync(OPENCLAW_JSON, 'utf8')); } catch { cfg = {}; }
}
cfg.gateway = {
  ...(cfg.gateway ?? {}),
  // 'local' = this gateway is the local supervisor (the non-tailnet, single
  // box mode); without it the gateway refuses to start ("missing
  // gateway.mode ... treat as suspicious or clobbered config").
  mode: cfg.gateway?.mode || 'local',
  port: GATEWAY_PORT,
  // bind is a MODE enum in OpenClaw 2026.7.x (auto|lan|loopback|custom|
  // tailnet — host aliases like 0.0.0.0 are rejected as legacy). 'lan'
  // accepts the docker-proxied connection inside the container; the compose
  // file's 127.0.0.1 publish is what keeps it host-loopback-only.
  bind: process.env.OPENCLAW_GATEWAY_BIND || 'lan',
  auth: { ...(cfg.gateway?.auth ?? {}), mode: 'token', token: gatewayToken },
};
// Model routing: register the Owyhee proxy as a custom OpenClaw model provider.
// The box holds NO provider key — the proxy injects the custodied upstream key
// (OpenRouter, Anthropic, …) and forwards, so every model call is token-metered,
// budgeted, kill-switchable, and receipted, exactly like tool calls.
//
// Schema per OpenClaw 2026.7.1 (concepts/model-providers → "Local proxies"):
//   models.providers.<name> = { baseUrl, apiKey, api, models: [{ id }] }  (mode:merge)
//   agents.defaults.model.primary = "<name>/<model>"
// api='openai-completions' => OpenClaw POSTs <baseUrl>/chat/completions; the
// governor maps that onto the connected is_llm_provider upstream.
if (creds?.token) {
  const modelRef = DEFAULT_MODEL.includes('/') ? DEFAULT_MODEL : `${LLM_SERVER}/${DEFAULT_MODEL}`;
  const modelId = modelRef.slice(modelRef.indexOf('/') + 1);
  cfg.agents = {
    ...(cfg.agents ?? {}),
    defaults: {
      ...(cfg.agents?.defaults ?? {}),
      model: { ...(cfg.agents?.defaults?.model ?? {}), primary: modelRef },
    },
  };
  cfg.models = {
    ...(cfg.models ?? {}),
    mode: cfg.models?.mode ?? 'merge',
    providers: {
      ...(cfg.models?.providers ?? {}),
      [LLM_SERVER]: {
        ...(cfg.models?.providers?.[LLM_SERVER] ?? {}),
        baseUrl: `${proxyBase}/proxy/${LLM_SERVER}`,
        apiKey: creds.token,
        api: LLM_API,
        models: [{ id: modelId }],
      },
    },
  };
}

writeFileSync(OPENCLAW_JSON, JSON.stringify(cfg, null, 2), { mode: 0o600 });
chmodSync(OPENCLAW_JSON, 0o600);
log(`gateway hardened: port ${GATEWAY_PORT}, token auth ON`);
if (creds?.token) {
  log(`model routed through Owyhee → ${proxyBase}/proxy/${LLM_SERVER} (default model '${DEFAULT_MODEL}')`);
  log(`>>> CONNECT AN LLM: add the '${LLM_SERVER}' provider under Connected Services in the console and grant this agent access, or the agent cannot think <<<`);
} else {
  warn('model will route through Owyhee once provisioned — no proxy credential yet (the agent cannot think until provisioned AND an LLM provider is connected)');
}

// MCP entries via the CLI (the version-stable config interface). Names only
// come from env; the credential comes from the volume.
if (creds?.token && SERVER_NAMES.length > 0) {
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
      // stderr is swallowed too: on failure execFile errors embed the full
      // argv (which carries the bearer) — never let that reach the logs.
      execFileSync('openclaw', ['mcp', 'set', name, entry], { stdio: ['ignore', 'ignore', 'ignore'] });
      log(`MCP server '${name}' → ${proxyBase}/mcp/${name} (governed by Owyhee)`);
    } catch (e) {
      warn(`openclaw mcp set ${name} failed (exit ${e?.status ?? '?'}) — run 'openclaw config validate' inside the container`);
    }
  }
} else if (SERVER_NAMES.length > 0) {
  warn('OWYHEE_MCP_SERVERS declared but no proxy credential is available yet — MCP entries not written.');
}

log(`activity & receipts: ${BASE}/ui/ (every governed call lands in the audit trail — check "what your agent did overnight" there)`);

// ---------- 3. run the gateway (foreground) ----------

// Foreground, not `gateway start` — the latter is the systemd/service path
// and refuses inside a container (its own hint: run the gateway in the
// foreground instead).
const child = spawn('openclaw', ['gateway'], {
  stdio: 'inherit',
  // No provider key is injected — OpenClaw's model provider points at the Owyhee
  // proxy (config above) and the proxy holds the credential in custody.
  env: process.env,
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
