---
status: accepted
date: 2026-10-04
decision-makers: Grid engineering
consulted: product owner
informed: Grid contributors
---

# Prompt context is loaded over HTTP, not carried in WebSocket headers

## Context and Problem Statement

A production project with 101 confirmed facts, 107 unknowns and six assumptions
stored a 6,200-byte project brief. Its base64url WebSocket header was 8,267 bytes;
the deployed websockets parser accepts at most 8,192 bytes per header line.
Replaying that exact header stalled the handshake, while an empty-profile
control immediately returned 101. The agent never received the question.

The signed envelope duplicated the same prompt data. Even an envelope containing
only the project brief was 8,588 bytes, so deleting the legacy header alone
would not restore chat. Python's 4,000-character prompt limit runs after the
handshake parser and cannot enforce a transport limit.

## Decision Drivers

- Growing project information must not determine whether chat can connect.
- The BFF owns tenancy, authorization and application data (ADR-0003).
- Signed requester identity remains mandatory; browser-supplied prompt data
  cannot become authoritative context.
- A workspace primitive has one HTTP API and typed clients (ADR-0055).
- Existing HTTP/job callers and anonymous development must remain compatible.

## Considered Options

1. Raise the parser limit or compress the existing headers.
2. Delete duplicate headers and truncate the brief before encoding.
3. Keep compact authenticated claims in the handshake and load prompt data
   through an authorized BFF HTTP API at turn setup.

## Decision Outcome

Chosen option: **3**.

Authenticated WebSocket handshakes carry signed identity, project/conversation
scope and existing compact policy fields, but no project brief, memory digest
or office instructions. The signed envelope states `contextTransport: "bff"`.
Every emitted header has an explicit encoded-byte budget; excess is reported
as an upgrade failure rather than sent to a parser that cannot accept it.

For that transport, Python calls `POST /api/internal/turn-context` with the
original signed envelope and service authentication. The BFF verifies the
requester, checks current project/conversation access and returns
`projectContext`, `projectMemory` and `orgInstructions` in a JSON response body.
Identity and resource scope never come from the body. Memory remains
query-specific, and context is loaded again for each turn.

The existing prompt normalization budgets remain separate from transport
budgets. HTTP/job callers that still supply inline context keep their legacy
contract. Compact mode is explicitly selected, never inferred from empty text.

This supersedes ADR-0013's decision to carry growing prompt blocks in handshake
headers. Base64url remains appropriate for the small structured claims that
still travel in headers; WebSocket remains the sole chat transport (ADR-0009).

### Consequences

- Good, because a legitimate larger profile no longer breaks the connection.
- Good, because profile and office-instruction changes can reach the next turn
  without reconnecting.
- Good, because the BFF remains the sole gate and Python stays stateless.
- Bad, because turn setup depends on a bounded HTTP context read. Its failure
  must fail the turn explicitly, not silently answer without project context.
- Bad, because rolling upgrades must deploy the backend reader before the
  frontend starts emitting compact mode. No new service or datastore is needed.

### Confirmation

Frontend handshake tests cover large and non-ASCII profiles, the absence of
all three prompt blocks from the signed capsule and the encoded-header budget.
Context-route tests cover signed requester identity, permissions and rejection
of identity supplied outside the envelope. Python tests cover transport
selection, live reads, response validation and explicit failures, while
preserving legacy callers.

## More Information

- [ADR-0003](0003-nextjs-bff-and-stateless-python-agent.md)
- [ADR-0013](0013-base64url-context-headers.md)
- [ADR-0055](0055-api-first-workspace-primitives.md)
- [WebSocket protocol](../api/websocket-protocol.md)
