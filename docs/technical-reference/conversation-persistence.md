# Conversation Persistence

Conversations persist through two layers: a PostgreSQL database (server-side) and `localStorage` (client-side). The frontend merges both sources to provide offline-capable access with server durability.

## Drizzle schema

### conversations table

`frontends/ui/src/lib/db/schema/conversations.ts`

| Column | Type | Notes |
|---|---|---|
| `id` | `text PK` | Session ID (e.g. `s_<uuid>`) |
| `organization_id` | `text NOT NULL` | WorkOS org scope |
| `created_by` | `text NOT NULL` | WorkOS user ID |
| `title` | `text` | Auto-generated from first user message |
| `project_id` | `uuid FK → projects.id` | Optional project scope (on delete set null) |
| `created_at` | `timestamp with tz` | Default `now()` |
| `updated_at` | `timestamp with tz` | Default `now()` |

### messages table

`frontends/ui/src/lib/db/schema/messages.ts`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid PK` | Default `gen_random_uuid()` |
| `conversation_id` | `text NOT NULL FK → conversations.id` | Cascade on delete |
| `role` | `text NOT NULL` | `user` or `assistant` |
| `content` | `text NOT NULL` | Message text |
| `metadata` | `jsonb` | Optional structured data (messageType, errorData, fileData, cards, enabledDataSources, messageFiles) |
| `created_at` | `timestamp with tz` | Default `now()` |

## BFF CRUD routes

### GET /api/conversations

`frontends/ui/src/app/api/conversations/route.ts:17`

Lists all conversations for the session's organization, ordered by `updatedAt DESC`. Requires `requireAuthorizedSession()`.

### POST /api/conversations

`frontends/ui/src/app/api/conversations/route.ts:30`

Creates a new conversation. Request body: `{ id: string, title?: string, projectId?: uuid }`. Returns 201 with the created row.

### GET /api/conversations/[id]

`frontends/ui/src/app/api/conversations/[id]/route.ts:15`

Returns a single conversation. Checks `organizationId` match. 404 if not found or wrong org.

### PATCH /api/conversations/[id]

`frontends/ui/src/app/api/conversations/[id]/route.ts:36`

Updates conversation `title`. Validates `organizationId` access.

### DELETE /api/conversations/[id]

`frontends/ui/src/app/api/conversations/[id]/route.ts:71`

Deletes a conversation. Messages are cascade-deleted by the FK constraint. Returns 204.

### GET /api/conversations/[id]/messages

`frontends/ui/src/app/api/conversations/[id]/messages/route.ts:11`

Lists all messages for a conversation, ordered by `createdAt ASC`. Validates org access.

### POST /api/conversations/[id]/messages

`frontends/ui/src/app/api/conversations/[id]/messages/route.ts:47`

Appends one or more messages. Accepts a single message object or an array. Each message requires `id`, `role`, `content`; optional `messageType`, `metadata`, `createdAt`. `messageType` is stored inside the `metadata` jsonb (no dedicated column) so the client can route rehydrated history to the right renderer. Duplicate message ids are skipped (`ON CONFLICT DO NOTHING`) so client retries can't fail a batch. Returns 201.

## Store hydration

On mount, `loadServerConversations()` (`store.ts:439`) runs:

1. Fetches all server conversations via `conversationsClient.list()`
2. Builds a `serverMap` keyed by conversation ID
3. Merges with existing local `conversations` array:
   - If a conversation exists locally and on server: server metadata wins, but a `null` server title never clobbers a locally generated one, and local messages are preserved
   - If a conversation exists only on server: appended to local list (messages empty until hydrated, see below)
   - Local-only conversations remain untouched (not yet persisted to server)

The merge result updates `conversations` in the store. Server timestamps are normalized to `Date` objects.

## Message repopulation (server → client)

localStorage is a cache, not the source of truth: the storage manager evicts
old sessions near the ~5 MB quota, and history is per-browser. When a past
chat's local messages are missing, they are repopulated from the server:

- `selectConversation()` kicks off `hydrateConversationMessages()` when the
  selected session has zero local messages.
- `loadServerConversations()` does the same for the restored current session
  on boot.
- `hydrateConversationMessages()` fetches `GET /api/conversations/[id]/messages`,
  maps rows back to `ChatMessage` via
  `features/chat/lib/server-message-mapper.ts` (messageType from metadata,
  falling back to role for legacy rows), and fills the session — but never
  overwrites messages that arrived while the fetch was in flight.

Heavy stream state (thinking-step content, report content, deep-research
tabs) is not stored server-side; like the localStorage pruning path, it is
refetched on demand.

## Local → server lifecycle sync

- `deleteConversation()` / `deleteAllConversations()` also delete the server
  rows — otherwise the next merge would resurrect deleted sessions as empty
  ghosts.
- `updateConversationTitle()` mirrors renames to the server row
  (best-effort; the row may not exist until the first message append).

## Per-message persistence

Messages are persisted to the BFF as they are created, not batched:

| Store action | Server call |
|---|---|
| `addUserMessage()` | `_appendMessage()` → `POST /api/conversations/[id]/messages` |
| `completeAssistantMessage()` | `_appendMessage()` → `POST /api/conversations/[id]/messages` (completed message) |
| `addAgentResponse()` | `_appendMessage()` → `POST /api/conversations/[id]/messages` |

The `_appendMessage()` method (`store.ts:981`):
1. Checks if the conversation exists on the server via `conversationsClient.list()`
2. Creates it via `POST /api/conversations` if it doesn't exist (`_ensureConversationExists()` called separately, or inline in `_appendMessage`)
3. Appends the message via `POST /api/conversations/[id]/messages`

## Lazy conversation creation

The conversation DB row is created lazily — `_ensureConversationExists()` (`store.ts:964`) runs on the first message append. This prevents empty conversations from creating database rows:

```typescript
_ensureConversationExists: async () => {
  const existing = await conversationsClient.list()
  const exists = existing.some((c) => c.id === conv.id)
  if (!exists) {
    await conversationsClient.create(conv.id, conv.title || undefined)
  }
}
```

## localStorage persistence

The Zustand store uses the `persist` middleware with `createResilientStorage()` (`store.ts:123`):

- **Key**: `aiq-chat-store`
- **Persisted fields**: `currentUserId`, `conversations`, `currentConversation`, `pendingInteraction`
- **Pruning**: `prunePersistedChatState()` strips heavy fields (full thinking steps, research panel data) from stored messages; `currentConversation` is stored as just an ID reference
- **Hydration transforms**: Connection error messages are stripped on read; `currentConversation` is reconstructed from the stored ID
- **Quota handling**: On `QuotaExceededError`, falls back to clearing all sessions as a last resort

## WebSocket persistence

When the WebSocket connects, `server.js` calls `/api/auth/websocket-scope` which returns `userId`, `organizationId`, and `accessToken`. These are forwarded to the Python `/websocket` route as headers:

- `X-Grid-User-Id`
- `X-Grid-Organization-Id`
- `Authorization: Bearer <token>`

The Python backend uses these to identify the caller for message persistence and authorization checks. The conversation ID is included in every NAT protocol message as `conversation_id`.
