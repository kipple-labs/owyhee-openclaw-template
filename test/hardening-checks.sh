#!/usr/bin/env bash
# Secure-defaults checklist AS TESTS. Run on the DEPLOY HOST after
# `docker compose up -d` (container name defaults to the compose service).
#
#   ./test/hardening-checks.sh [container-name]
#
# Every check maps to a rule in the README's threat model. Exit non-zero on
# any failure; CI-friendly output.

set -u
C="${1:-$(docker compose ps -q openclaw 2>/dev/null || echo owyhee-openclaw-template-openclaw-1)}"
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
fails=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; fails=$((fails+1)); }

# 1. No credentials in container ENV (docker inspect view = what leaks to
#    anyone with docker access / misconfigured log shippers).
ENVS=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$C" 2>/dev/null)
if echo "$ENVS" | grep -qiE 'sk-ant|sk-[a-z0-9]{20}|kga_|api[_-]?key=|token=[^[:space:]]'; then
  # OWYHEE_DEPLOY_TOKEN is an allowed exception ONLY when the operator set a
  # deploy gate; flag anything else.
  if echo "$ENVS" | grep -viE '^OWYHEE_DEPLOY_TOKEN=' | grep -qiE 'sk-ant|sk-[a-z0-9]{20}|kga_|api[_-]?key='; then
    fail "credential-shaped value found in container ENV"
  else
    pass "container ENV clean (deploy-gate token only)"
  fi
else
  pass "no credential-shaped values in container ENV"
fi

# 2. Gateway published on host loopback ONLY.
BINDING=$(docker inspect -f '{{json .NetworkSettings.Ports}}' "$C" 2>/dev/null)
if echo "$BINDING" | grep -q '"HostIp":"127.0.0.1"' && ! echo "$BINDING" | grep -qE '"HostIp":"(0\.0\.0\.0|::)"'; then
  pass "gateway port published on 127.0.0.1 only"
else
  fail "gateway port is published beyond loopback: $BINDING"
fi

# 3. Host port scan agrees (the acceptance's literal check).
if command -v ss >/dev/null 2>&1; then
  if ss -tln | awk '{print $4}' | grep -E "[^0-9]${PORT}\$" | grep -vqE '^127\.0\.0\.1|^\[::1\]'; then
    fail "port ${PORT} is listening on a non-loopback host address"
  else
    pass "host listener for ${PORT} is loopback-only"
  fi
fi

# 4. Gateway auth is ON (token mode) in the effective config.
AUTHMODE=$(docker exec "$C" node -e "const c=require('/data/.openclaw/openclaw.json');console.log(c.gateway?.auth?.mode??'')" 2>/dev/null)
[ "$AUTHMODE" = "token" ] && pass "gateway auth.mode=token" || fail "gateway auth.mode is '$AUTHMODE' (want token)"

# 5. Unauthenticated CONTROL calls are refused; authenticated ones are not.
#    GET / serves the static UI shell (public by design) — the control
#    surface is /tools/invoke, which must demand the token.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/tools/invoke" \
  -H 'content-type: application/json' -d '{"tool":"sessions_list","action":"json"}' || echo 000)
case "$CODE" in
  401|403) pass "unauthenticated control call refused ($CODE)";;
  000) fail "gateway not reachable on loopback (is the container up?)";;
  *) fail "unauthenticated control call returned $CODE (want 401/403)";;
esac
GWTOK=$(docker exec "$C" cat /data/owyhee/gateway-token 2>/dev/null)
if [ -n "$GWTOK" ]; then
  ACODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/tools/invoke" \
    -H "authorization: Bearer $GWTOK" -H 'content-type: application/json' \
    -d '{"tool":"sessions_list","action":"json"}' || echo 000)
  case "$ACODE" in
    401|403|000) fail "AUTHENTICATED control call refused ($ACODE) — token wiring broken";;
    *) pass "authenticated control call accepted ($ACODE)";;
  esac
fi

# 6. Secrets on the volume are 0600.
for f in /data/owyhee/credentials.json /data/owyhee/gateway-token; do
  MODE=$(docker exec "$C" stat -c '%a' "$f" 2>/dev/null || echo missing)
  if [ "$MODE" = "600" ]; then pass "$f is 0600";
  elif [ "$MODE" = "missing" ]; then echo "SKIP  $f not present (unprovisioned boot?)";
  else fail "$f mode is $MODE (want 600)"; fi
done

# 7. No secrets baked into image layers.
IMG=$(docker inspect -f '{{.Image}}' "$C" 2>/dev/null)
if docker history --no-trunc "$IMG" 2>/dev/null | grep -qiE 'sk-ant|kga_|api[_-]?key='; then
  fail "credential-shaped value in image history"
else
  pass "image history clean"
fi

echo
if [ "$fails" -gt 0 ]; then echo "$fails check(s) FAILED"; exit 1; fi
echo "all hardening checks passed"
