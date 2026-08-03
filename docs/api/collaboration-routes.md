# Collaboration BFF routes

Routes for sharing, `@`-mentions with the agent hand-off, and the inbox.

- **Requirements:** [`../design/collaboration-sharing-and-inbox-spec.md`](../design/collaboration-sharing-and-inbox-spec.md)
- **Decisions:** [ADR-0032](../adr/0032-shareable-resource-model.md) (sharing model),
  [ADR-0033](../adr/0033-server-authoritative-shared-conversations.md) (shared threads),
  [ADR-0034](../adr/0034-mention-handoff-persisted-state.md) (hand-off),
  [ADR-0035](../adr/0035-notification-model-and-inbox.md) (inbox + live delivery)
- **Sibling reference:** [`bff-routes.md`](bff-routes.md)

## Rules that apply to every route here

- **All are gated**, in one of two ways. The collaboration-only routes (sharing,
  mentions, inbox, `/api/stream`, `/api/conversations/{id}/{awaiting,
  mention-candidates,live}`) call `requireCollaborationEnabled(session)` as their
  first statement and return
  `403 { error: 'feature-disabled', feature: 'collaboration' }` when off. The
  routes that **pre-date** the feature and were extended by it —
  `…/messages`, `…/read`, `…/typing` — cannot answer `403` without breaking chat
  for orgs that never had collaboration, so the gate sits in the service and only
  the collaboration *behaviour* switches off: a message with no mentions persists
  exactly as it always did while one carrying `mentions` is refused
  `403 details.reason = 'feature-disabled'`, `…/read` still moves the high-water
  mark but skips the ambient inbox clear, and `publishTypingPresence` returns
  without publishing (`204` either way). Both forms read the same
  **default-deny** flag (per-org `collaboration` WorkOS flag with flag enforcement
  on; `GRID_COLLABORATION_ENABLED=true` otherwise), because the feature changes
  who can see conversations.
- **All are declared through `apiRoute`** from `@/lib/api/handler`, so they are
  session-authenticated, org-scoped, and return the standard error envelope
  `{ error, code, details? }`. The one exception to the JSON-wrapping is
  `/api/stream`, which returns a `Response` (the factory passes it through).
- **Denial is indistinguishable from non-existence.** Anything the caller may not
  see is `404 NOT_FOUND`, never `403` (spec SH-6). This includes a conversation in
  another organization, a private conversation belonging to a colleague, and a
  resource whose container project the caller cannot reach.
- **Machine-readable refusal reasons** ride in `details.reason` so the UI can
  localise without parsing prose. Values are defined in
  `lib/sharing/types.ts` (`SHARING_ERROR_REASONS`) and `lib/mentions/types.ts`
  (`MENTION_ERROR_REASONS`).

---

## Sharing

`resourceType` is validated against `SHAREABLE_RESOURCE_TYPES` (today:
`conversation`); anything else is `400`. The registry
(`lib/sharing/registry.ts`) is what makes these routes generic — a new shareable
type needs no new route.

### `GET /api/sharing/{resourceType}/{resourceId}`

The sharing state. Requires `viewer` — a participant is entitled to know who else
is in the room, which is also what the participant strip renders.

Returns `ResourceSharingState` (`lib/sharing/types.ts`):

| Field | Meaning |
|---|---|
| `visibility` | `private` \| `project` \| `organization` |
| `allowedVisibilities` | What this type permits — drives the UI's options. Conversations expose only `private`/`project` in phase 1 (see ADR-0032 follow-ups) |
| `myRole` | The caller's effective role, or `null` |
| `canManage` | Whether the caller may change sharing (`owner`) |
| `canEscalate` | Project admin who may take ownership of a resource they were not party to |
| `entries[]` | `{ person, role, reason, grantedBy }` — `reason` is why they have access (`creator`, `grant`, `visibility-project`, `visibility-organization`) so the roster is never mysterious |
| `shared` | True when the server is authoritative for this resource (ADR-0033) |

### `PATCH /api/sharing/{resourceType}/{resourceId}`

Body `{ visibility }`. Requires `owner`. Rejects a visibility the registry does
not permit for the type (`400`, `details.allowed`). A no-op save is a no-op: no
audit event, no events published.

Narrowing publishes `resource.access.changed` to the **previous** audience as well
as the new one, so losing sight of a thread is never silent.

### `POST /api/sharing/{resourceType}/{resourceId}/grants`

Two shapes on one route:

- `{ subjectUserId, role? }` — grant or re-grant (`role` defaults to
  `collaborator`). Requires `owner`. `201`.
- `{ escalate: true }` — a project admin taking ownership. Audited distinctly as
  `resource.ownership.escalated`, because it is the one path by which someone
  reaches a **private** resource without being invited.

Refusals worth handling in the UI:

| Status | `details.reason` | Cause |
|---|---|---|
| `400` | `container-access-required` | The invitee is not a member of the container project. Sharing never grants project access (spec SH-5) |
| `409` | `roster-full` | The roster cap (`SHARE_ROSTER_LIMIT`) is reached |
| `403` | `rate-limited` | Sharing rate limit for this actor |

### `PATCH /api/sharing/{resourceType}/{resourceId}/grants`

Body `{ subjectUserId, role }`. Requires `owner`. Enforces the last-owner
invariant: `409` with `details.reason = 'last-owner'` when the change would leave
the resource with no owner (spec SH-11).

### `DELETE /api/sharing/{resourceType}/{resourceId}/grants/{subjectUserId}`

Revoke. Requires `owner` — **except** revoking yourself (leaving), which requires
only `viewer`. Also subject to the last-owner invariant.

Revocation is not just a row delete: in the same operation it voids any open
mention request against that person and marks their inbox items for the resource
inert **with payloads wiped**, so a quoted snippet cannot outlive the access it
was quoted from (spec IB-14, MN-9.4). Publishes
`resource.access.changed { change: 'revoked' }` to them.

### `GET /api/sharing/{resourceType}/{resourceId}/candidates`

People who may be invited. Returns `ShareCandidate[]`:
`{ person, alreadyHasAccess, needsProjectAccess }`.

Organization members who **cannot** reach the container project are returned with
`needsProjectAccess: true` so the UI can show them disabled *with the reason*
rather than silently hiding them (spec SH-19) — an invite picker that omits a
colleague with no explanation reads as a bug.

---

## Mentions and the hand-off

### `GET /api/conversations/{id}/awaiting`

The derived hand-off state. Returns `AwaitingStateResponse`:
`{ pending: PendingMentionView[], awaitingMe: boolean }`.

**Derived, not stored**: `pending` is the set of `open` `mention_requests` rows
for the conversation, so this endpoint, the thread banner and the recipient's
inbox cannot disagree (ADR-0034). Empty `pending` means the agent is free to
answer; non-empty means the thread is visibly waiting for a human and the agent
stays silent.

### `GET /api/conversations/{id}/mention-candidates`

Candidates for the `@` picker. Returns
`{ candidates: MentionCandidate[], canInvite: boolean }`, where each candidate is
`{ targetId, person, isAgent, isParticipant, needsInvite }`.

- The **agent** is always a candidate (`targetId: 'agent:piloti'`,
  `isAgent: true`). Tagging it is how you bring it back into a thread that is
  waiting on a human (spec MN-1).
- `needsInvite: true` means mentioning them will invite them — only actionable
  when `canInvite` (caller is an `owner`, spec OQ-3).
- Org members who cannot reach the container project **do not appear at all**.

### `POST /api/mentions/{requestId}/release`

Release the wait — "continue without waiting" (spec MN-9.2). Any participant with
`collaborator` may do it, not only the asker: the whole point is that a thread
must never be stuck because one person went on holiday. Closes the request with
resolution `released`, resolves the recipient's inbox item, and publishes
`conversation.awaiting` with the new (possibly empty) set.

Returns the updated `AwaitingStateResponse`.

---

## Messages (existing route, extended)

### `GET /api/conversations/{id}/messages`

Requires `viewer`. Unchanged in shape, but worth stating here because ADR-0033
makes this the **load** path for a shared thread rather than a rehydration
fallback: it returns the **newest** `MESSAGE_LIST_LIMIT` (1000) messages, in
ascending order, tie-broken on `(created_at, id)` so two clients cannot see the
same two messages in different orders (spec CC-11). Taking the window from the
oldest end pinned a long shared thread to ancient history and let a reader never
see a new message again.

### `POST /api/conversations/{id}/messages`

The existing persist route, with two additions. **The response shape is
additive** — existing callers that ignore the new fields are unaffected.

Request additions: an optional `mentions: [{ targetId }]` per message (bounded).

Response additions per persisted message (`PersistedMessageResult`):

```
{ id, addressees: { agent: boolean, users: string[] }, createdRequests: number }
```

**`addressees` is the server's ruling on who the message is for, and the client
MUST obey it**: it opens an agent turn only when `addressees.agent` is true
(ADR-0034 §4). The rule:

| Mentions in the message | `addressees` | Agent behaviour |
|---|---|---|
| none | `{ agent: true, users: [] }` | answers, exactly as before |
| one or more humans | `{ agent: false, users: [...] }` | **stays silent**; thread awaits them |
| `@Piloti` + humans | `{ agent: true, users: [...] }` | answers, and the humans are asked too |

The set is computed once, server-side, and stored on the message — never
re-derived from the text later, and never trusted from the client (spec MN-2).
Because nothing is started and then cancelled, a mention costs **zero tokens**.

Refusals: `400 details.reason = 'mention-invite-requires-owner'` (a collaborator
tried to mention a non-participant), `'container-access-required'`, or
`403 'mention-rate-limited'`. A refused mention refuses the **whole** message, so
there is never a half-sent trail of grants and notifications.

### `POST /api/conversations/{id}/read`

Body `{ lastReadMessageId? }`. Requires `viewer`. Sets the caller's read
high-water mark and clears the conversation's **ambient** inbox items — never an
actionable request, because reading a thread is not answering the question someone
asked in it (spec IB-9).

---

## Inbox

### `GET /api/inbox?pendingOnly=true|false`

Returns `InboxListResponse` = `{ items: InboxItemView[], pending: number }`,
bounded by `INBOX_LIST_LIMIT`. `pendingOnly` is an explicit `'true' | 'false'`
enum, not a coerced boolean (`z.coerce.boolean()` reads `"false"` as `true`).

**Access is re-checked at read time** (spec IB-13). An item never grants access.
For every distinct target on the page — resolved **once per resource**, not once
per item — access is re-derived; anything unreachable, or already marked inert,
comes back with `href: null` and `excerpt: null`. Such rows are **redacted, not
dropped**: a redacted row explains itself, a vanished one looks like a bug.

`InboxItemView` carries `type`, `state` (`unread`/`read`/`resolved`/`archived`/
`inert`), `actionable`, `count`, `actorName`, `actorUserId`, `subject`,
`excerpt`, `href`, `resourceType`/`resourceId`/`anchorId`, and timestamps.
Rendering is driven entirely by `INBOX_TYPE_PRESENTATION` in
`lib/inbox/types.ts`, so a new item type needs a registry entry and its
translations — no new component (spec IB-6).

**`count` is "occurrences absorbed by grouping SINCE THE ROW WAS LAST READ", not
"since the row was created."** Every mark-read path resets it to zero alongside
`readAt` — `POST /api/inbox/read` in both its shapes, and the ambient clear
performed by `POST /api/conversations/{id}/read` (`markReadValues()` in
`lib/inbox/repository.ts` is the single mutation all three share). So:

- `count: 0` is the **ordinary** state of a read row, not a missing value.
  Anything treating the field as `≥ 1` is wrong for every read row.
- After a read, the upsert increments from zero: a group of twenty that was read
  and then received one more says `1`, not `21`.
- A renderer therefore needs **three** cases, not two —
  `titleMany` / `titleOne` / `titleNone` (`InboxItemRow.tsx`); `titleNone` is what
  a read row with nothing new since renders as.

### `GET /api/inbox/summary`

`{ pending }` — one indexed count, nothing else. This runs on every page render,
so it is deliberately the cheapest endpoint in the feature, backed by the partial
index `idx_inbox_items_pending`.

### `POST /api/inbox/read`

Body `{ itemIds: string[] }` or `{ all: true }` — at least one of them; `{}` is a
`400`. `itemIds` must be uuids and is capped at `INBOX_LIST_LIMIT`, because a
mark-read request can only ever be about rows the client was shown. If both are
sent, `all` wins. Scoped to the caller, so ids belonging to someone else cannot be
poked (they simply match nothing — telling you an item is not yours would confirm
it exists).

Returns `{ affected, pending }`: rows actually touched (`0` is a legitimate
no-op) and the recomputed badge, so no follow-up read is needed.

### `POST /api/inbox/{id}/archive`

Archive one item. `404` on a miss — indistinguishable from "not yours". Returns
the same `{ affected, pending }`.

---

## Live delivery

### `GET /api/stream` (Server-Sent Events)

One connection per browser tab, carrying that **user's** events only.

- Frames are `data: <EventEnvelope JSON>`; see `lib/events/types.ts` for the
  `CollaborationEvent` union (`inbox.changed`, `conversation.message`,
  `conversation.turn`, `conversation.awaiting`, `conversation.typing`,
  `resource.access.changed`).
- Sends `retry: 5000` and a `: connected` comment immediately, then a `: ping`
  heartbeat every 25s so proxies do not reap the connection.
- Headers include `X-Accel-Buffering: no` and `Cache-Control: no-cache,
  no-transform`.

Three properties worth knowing before consuming it:

1. **Authorization happens at publish time.** The server resolves a resource's
   participants and publishes to each one's *own* channel (`user:<id>:events`).
   Browsers never subscribe to a resource channel and filter locally, so a
   non-participant cannot receive a thread's content.
2. **Every event is a hint, never authoritative content.** Consumers respond by
   re-reading from the server. Two documented exceptions, both bounded by an
   expiry rather than by a fetch: the badge count on `inbox.changed` (a negative
   value means "unknown, go and read"), and `conversation.typing`, which is
   ephemeral presence with no endpoint behind it — it carries a `ttlMs` and a
   receiver stops believing it when that elapses.
3. **There is no resume / `Last-Event-ID`.** Postgres is the record; reconnecting
   means "fetch again" (spec RT-4). Correctness therefore never depends on an
   event having arrived — the client also refreshes on window focus and polls
   slowly while disconnected, and the whole feature works with the cache tier
   absent (spec RT-3).

### `POST /api/conversations/{id}/typing`

Broadcast that the caller is composing. Requires **`collaborator`** — a viewer's
draft can never become a message, so announcing it would be a claim about
something that cannot happen (and would leak that a read-only colleague is
drafting).

Body `{ typing?: boolean }`; absent means `true`, so the common case is the
smallest possible request. Always `204` — there is no state to return, nothing is
persisted, and there is deliberately **no matching `GET`**: the fact is true for a
few seconds and worthless afterwards, so the only way to learn it is to be
connected when it happens.

Publishes `conversation.typing` to every participant **except the caller**, whose
id is taken from the session and never from the body. A private conversation with
no grants publishes nothing at all (spec NF-8). The client republishes every
`TYPING_REFRESH_MS` (3s) while typing continues and posts `{ typing: false }` when
the draft is sent, cleared, or abandoned; the server-side claim expires after
`TYPING_TTL_MS` (6s) regardless, so a closed tab heals itself
(`lib/conversations/presence-contract.ts` owns both numbers).

Rate-limited by `TYPING_RATE_LIMIT` (120 per user per minute — roughly ten times
what the 3s client cadence costs). This is the highest-frequency endpoint in the
product and every call resolves access, counts grants, resolves the participant
list and then publishes once *per participant*, so the bound is what keeps that
cost closed. Past the limit the request is **shed silently and still answers
`204`**: the caller is only ever told the request was accepted, not that anybody
received it, and a dropped presence claim is indistinguishable from the channel
dropping one — which the TTL already heals.

### `GET /api/conversations/{id}/live` (Server-Sent Events)

Watch a turn as it happens (ADR-0039). Relays the agent's outbound WebSocket
frames for **one** conversation, so an observer sees the reasoning being done and
the answer being written rather than a spinner followed by a finished block of
text. Requires `viewer`.

- Frames are `data: {"kind":"frame","seq":N,"payload":<NAT frame>}`. The payload is
  the raw NAT WebSocket frame (`system_response_message`,
  `system_intermediate_message`, `system_interaction_message`, `error_message`) —
  the same bytes the asker's own socket carries, documented in
  [`websocket-protocol.md`](websocket-protocol.md).
- `{"kind":"unsupported"}` followed by a close means there is no cross-process
  frame channel (no `REDIS_URL`, or Dragonfly unreachable). The client falls back
  to the static turn banner and does **not** reconnect.
- `{"kind":"revoked"}` followed by a close means access went away while the stream
  was open.
- Sends `retry: 2000` (shorter than `/api/stream`: five seconds of a ninety-second
  turn is a visible hole in the answer) and a `: ping` heartbeat every 25s.

Three things to know before consuming it:

1. **Authorization is at subscribe time, and re-checked.** Unlike `/api/stream`,
   this attaches to a per-RESOURCE channel (`conv:<id>:events` — the Python tier's
   conversation bus, ADR-0028), so the publish-time argument does not apply. Access
   is proven before the subscription opens and re-proven every
   `LIVE_REAUTHORIZE_MS` (30s); a revoked grant closes the stream.
2. **Nothing here is authoritative.** The finished answer is persisted and arrives
   over the ordinary `conversation.message` → refetch path whether or not a single
   frame was delivered (spec RT-4). That is what lets the whole route degrade to
   one `unsupported` event.
3. **No replay.** A subscriber sees frames from the moment it attaches. The bus's
   replay stream is per conversation rather than per turn, so buffering would mean
   guessing which frames belong to the turn running *now* — and guessing wrong
   shows a colleague a stale answer under a live banner. Opening a thread mid-turn
   therefore loses the tokens already spoken, and nothing else.

### `POST /api/internal/collaboration/prune`

Token-guarded (`internalApiRoute`) retention prune for inbox items (spec IB-15).
Housekeeping invoked by a scheduler, not a person. Idempotent and bounded — each
call deletes at most one batch, so a backlog is worked off over several ticks
rather than taking a long lock on a table that serves every page render. Returns
`{ pruned, cutoff }`.
