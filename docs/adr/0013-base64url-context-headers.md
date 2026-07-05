# ADR-0013: base64url-encoded context headers

- **Status:** Accepted
- **Date:** 2026-07-05
- **Deciders:** Grid Agent team
- **Related:** [ADR-0006](0006-knowledge-collection-scoping.md), [ADR-0009](0009-websocket-only-chat-transport.md)

## Context

The BFF passes per-request context to the stateless Python backend as HTTP/WS
headers: the collection scope, the project context (intake profile), and the
project/org memory digest. The scope is a JSON array; the context and memory are
**multi-line** text (`PROJECT_CONTEXT v1` / `PROJECT_MEMORY v1` blocks).

Node's HTTP stack **rejects newlines in outgoing header values** (`ERR_INVALID_CHAR`),
and in the WebSocket upgrade path that error is thrown **synchronously outside any
try/catch** — an uncaught exception that crashes the gateway process and takes down
chat for every user. (This was a real, reproduced defect.)

## Decision

We will **base64url-encode** structured/multi-line header values on the BFF side
and decode them on the Python side:

- `X-Grid-Collection-Scope` — base64url of the JSON scope array.
- `x-grid-project-context` — base64url of the multi-line context block.
- `x-grid-project-memory` — base64url of the multi-line memory digest.

The Python readers decode base64url (with a raw-string fallback for compatibility).
The gateway also guards the proxy upgrade so any header/proxy error becomes a 502,
not a process crash.

## Consequences

### Positive
- Structured JSON and multi-line text pass safely over HTTP/WS regardless of content.
- Eliminates a whole class of "content with a newline crashes chat" failures.

### Negative
- Values are opaque in logs/inspection until decoded (minor).

### Risks
- Encode/decode mismatch — mitigated by a raw-string fallback on decode and a
  round-trip test (multi-line + non-ASCII).

## Alternatives Considered
- **Strip/normalize newlines from content** — rejected; lossy and still fragile
  for other illegal header characters.
- **Send context in a request body instead of headers** — rejected; the WS upgrade
  handshake carries headers, not a body, and the scope must be on the upgrade.

## References
- [`../architecture/backend-deep-dive.md`](../architecture/backend-deep-dive.md)
