#!/usr/bin/env bash
# A WorkOS access token for a coding agent reading Langfuse without a browser.
#
# The platform edge (deploy/pulumi/src/platform/platform-oidc.ts) admits a
# request that carries a WorkOS token holding `platform:organizations:view`,
# checked exactly like a browser session. This script mints that token from a
# WorkOS M2M application (client credentials) and prints it in the shape the
# caller needs. ADR-0044 Amendment 3.
#
#   token             the bare JWT
#   langfuse-headers  JSON headers for Claude Code's MCP `headersHelper`: the
#                     WorkOS token for the edge, and Langfuse's own Basic
#                     credential for Langfuse
#
# Environment:
#   WORKOS_AUTHKIT_ISSUER        https://<tenant>.authkit.app (the stack's otelOidcIssuer)
#   WORKOS_AGENT_CLIENT_ID       the M2M application's client id
#   WORKOS_AGENT_CLIENT_SECRET   its secret
#   LANGFUSE_PUBLIC_KEY          pk-lf-… (langfuse-headers only)
#   LANGFUSE_SECRET_KEY          sk-lf-… (langfuse-headers only)
#
# Tokens live minutes, not hours. `headersHelper` runs this on every connection,
# so an MCP session never holds a stale one; anything that caches the output
# has to re-run it when the edge starts answering 401.
set -euo pipefail

mode="${1:-token}"
case "$mode" in
  token) ;;
  langfuse-headers)
    : "${LANGFUSE_PUBLIC_KEY:?set LANGFUSE_PUBLIC_KEY (pk-lf-…)}"
    : "${LANGFUSE_SECRET_KEY:?set LANGFUSE_SECRET_KEY (sk-lf-…)}"
    ;;
  *)
    echo "usage: $0 [token|langfuse-headers]" >&2
    exit 2
    ;;
esac
: "${WORKOS_AUTHKIT_ISSUER:?set WORKOS_AUTHKIT_ISSUER, e.g. https://<tenant>.authkit.app}"
: "${WORKOS_AGENT_CLIENT_ID:?set WORKOS_AGENT_CLIENT_ID (the M2M application)}"
: "${WORKOS_AGENT_CLIENT_SECRET:?set WORKOS_AGENT_CLIENT_SECRET}"

# The secret goes in on stdin (`@-`), never as an argument: `headersHelper`
# runs this on every connection, and argv is readable by anyone who can run
# `ps` on the machine. On an error WorkOS says why in the body, which
# `--fail-with-body` keeps; the parser prints it instead of a bare HTTP code.
token="$(
  printf '%s' "$WORKOS_AGENT_CLIENT_SECRET" |
    curl -sS --fail-with-body "${WORKOS_AUTHKIT_ISSUER%/}/oauth2/token" \
      --data-urlencode grant_type=client_credentials \
      --data-urlencode "client_id=${WORKOS_AGENT_CLIENT_ID}" \
      --data-urlencode client_secret@- \
      --data-urlencode "scope=platform:organizations:view" |
    python3 -c '
import json, sys
body = sys.stdin.read()
try:
    print(json.loads(body)["access_token"])
except (ValueError, KeyError):
    sys.exit("WorkOS token request failed: " + (body.strip() or "no response body"))
'
)"

if [ "$mode" = token ]; then
  printf '%s\n' "$token"
  exit 0
fi

basic="$(printf '%s:%s' "$LANGFUSE_PUBLIC_KEY" "$LANGFUSE_SECRET_KEY" | base64 | tr -d '\n')"
TOKEN="$token" BASIC="$basic" python3 -c '
import json, os
print(json.dumps({
    "x-workos-token": os.environ["TOKEN"],
    "Authorization": "Basic " + os.environ["BASIC"],
}))'
