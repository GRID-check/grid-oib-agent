# WebSocket Gateway

The gateway server (`server.js`) is a Node.js HTTP server on port 3000 that acts as the single entry point for all traffic. It proxies HTTP requests to Next.js and handles WebSocket upgrade requests.

## server.js architecture

`frontends/ui/server.js`

**Development mode** (`NODE_ENV !== 'production'`):
- Gateway runs on port 3000
- HTTP requests proxied to Next.js dev server on port 3001 via `httpProxy`
- WebSocket upgrade requests for non-`/websocket` paths proxied to Next.js HMR

**Production mode**:
- Next.js is embedded in the same process (`nextApp.prepare()`)
- HTTP requests handled by `nextHandle(req, res, parsedUrl)`
- WebSocket upgrade handled by `nextApp.getUpgradeHandler()`

Key configuration:

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Gateway listen port |
| `BACKEND_URL` | `http://localhost:8000` | Python backend HTTP URL |
| `NEXT_INTERNAL_URL` | `http://localhost:3001` | Next.js dev server URL |

## WebSocket upgrade flow

`server.js:199`

```
Client WS connect → server.on('upgrade')
  → pathname === '/websocket' ?
    → fetchCollectionScopeHeader(req, projectId, conversationId)
      → internal GET /api/auth/websocket-scope?projectId=&conversationId=
    → if 401/403 → reject socket
    → set headers: x-grid-collection-scope, x-grid-organization-id,
                    x-grid-user-id, authorization
    → backendProxy.ws(req, socket, head, { target: BACKEND_WS_URL })
  → else → dev? proxy to Next.js HMR : nextApp.getUpgradeHandler()
```

The `BACKEND_WS_URL` is derived from `BACKEND_URL` by replacing `http` with `ws` (e.g., `ws://localhost:8000`).

## Scope resolution

`frontends/ui/src/app/api/auth/websocket-scope/route.ts`

Called internally (no external route) by `server.js` during WebSocket upgrade. Resolves the collection scope for the backend:

1. Reads `projectId` and `conversationId` from query params
2. Calls `getGridSession()` to resolve the WorkOS session (or null in anonymous mode)
3. If `REQUIRE_AUTH=true` and no session: returns `401`
4. If project access required: calls `requireProjectAccess()` → returns `403` on failure
5. Calls `buildCollectionScopeFromRequest(session, { projectId, conversationId })` to build the ordered scope
6. Returns JSON:
   - `scope`: The resolved scope array
   - `header`: Base64url-encoded `X-Grid-Collection-Scope` header value
   - `organizationId`: Session org ID (if authenticated)
   - `userId`: Session user ID (if authenticated)
   - `accessToken`: Raw WorkOS JWT (if authenticated)

## Headers forwarded to Python

| Header | Source | Purpose |
|---|---|---|
| `X-Grid-Collection-Scope` | Base64 JSON array from scope resolution | Tells Python which collections to query |
| `X-Grid-Organization-Id` | Session `organizationId` | Tenant identification |
| `X-Grid-User-Id` | Session `userId` | Caller identity |
| `Authorization` | `Bearer <accessToken>` | JWT for backend validation |

## The chat wire

The socket speaks chat wire v2: the upgrade asks for `?v=2`, and any other
version is closed with `4426`. The event set, the four client messages and
the rejection codes are the contract in
[`websocket-protocol.md`](../api/websocket-protocol.md); the design, and why
it replaced NAT's frames, is [`chat-wire-v2.md`](../design/chat-wire-v2.md).

The client is `createTurnSocket` (`frontends/ui/src/adapters/api/turn-socket.ts`):

- **Reconnect.** A jittered ladder (`createRetryLadder`, 1 s doubling to 30 s,
  12 attempts), with the auth cookie refreshed before each attempt, since the
  handshake is the only point where the gateway reads it. A `rejected{auth_expired}`
  reopens the socket the same way and sends the refused message again.
- **Resume.** On every reopen each turn the client still holds open is
  re-`attach`ed from the last `seq` it folded; the agent tier replays the
  turn from its stream and continues live.
- **Liveness.** While a turn runs the server sends `heartbeat{every_ms}`;
  three beats of silence and the socket is dropped and reopened. Nothing is
  watched before `RUN_STARTED` or after the terminal.

**`CUSTOM` `heartbeat`**: the running turn is still running (chat wire v2)

```json
{ "v": 2, "type": "CUSTOM", "name": "heartbeat", "conversation_id": "s_<uuid>", "turn_id": "<message_id>", "seq": 10, "ts": 1759000016777, "value": { "every_ms": 20000 } }
```

Stamped by the turn's own sequencer (`aiq_api.chat_socket.TurnWire`) every
`TURN_HEARTBEAT_SECONDS`, by a task that lives exactly as long as the turn does,
so it covers what the answer stream cannot: context loading before the graph
starts, a ten-minute tool call, and the whole of a deep-research turn that runs
on this socket because no job dispatcher is configured. It sleeps before its
first beat, so a turn that answers in two seconds sends none, and none is ever
sent after the terminal.

It renders nothing. Its only job is to let the client tell a turn that is quiet
because it is thinking from one that is quiet because its backend is gone.
`every_ms` is the server's stated cadence and the client's deadline is a
multiple of it, so the interval is retuned on the backend alone. The whole event
set is [`docs/api/websocket-protocol.md`](../api/websocket-protocol.md).
