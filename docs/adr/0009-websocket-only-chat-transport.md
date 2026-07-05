# ADR-0009: WebSocket-only chat transport

- **Status:** Accepted
- **Date:** 2026-07-05
- **Deciders:** Grid Agent team
- **Related:** [`../architecture/backend-deep-dive.md`](../architecture/backend-deep-dive.md), [`../technical-reference/websocket-gateway.md`](../technical-reference/websocket-gateway.md)

## Context

The app historically carried **two** chat transports: Server-Sent Events (via
`/api/generate` / `/api/chat`) and a WebSocket path (the NAT protocol, which also
supports human-in-the-loop interaction). Maintaining both meant divergent parsing,
duplicated state handling, and confusion about which was live.

WebSocket is required anyway for the NAT human-in-the-loop protocol and
bidirectional control; SSE cannot carry it.

## Decision

We will use **WebSocket as the sole chat transport.** The SSE chat path is
retired. SSE survives only for **deep-research async job streaming**
(`/api/jobs/async/*`), where a one-way server→client stream is the right fit.

## Consequences

### Positive
- One transport, one parsing path, one place to attach structured signals
  (cards, `deep_research_job_id`) — less drift, fewer bugs.
- Native support for HITL and bidirectional control.

### Negative
- WebSocket infrastructure (the `server.js` gateway, upgrade proxying, reconnect
  handling) is more involved than plain HTTP/SSE.

### Risks
- A gateway crash breaks all chat — mitigated by guarding the proxy upgrade and
  encoding header values (ADR-0013) so a bad value can't take the process down.

## Alternatives Considered
- **Keep both transports** — rejected; the SSE chat path was migration residue
  with no unique capability WebSocket lacks.

## Open Questions / Follow-ups
- Remaining reference docs still describe the dead SSE chat path; being updated.

## References
- [`../architecture/backend-deep-dive.md`](../architecture/backend-deep-dive.md) §2
