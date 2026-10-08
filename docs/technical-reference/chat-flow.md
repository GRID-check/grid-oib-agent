# Chat Flow

The agent conversation runs over one path: a WebSocket via `ws://<host>/websocket`.
A deep-research run is a message in the thread that commissioned it (ADR-0062);
its block follows the run's own stream (`features/runs/hooks/use-run-ledger.ts`),
not this socket.

## WebSocket path

The wire is chat wire v2 ([`chat-wire-v2.md`](../design/chat-wire-v2.md),
the contract in [`websocket-protocol.md`](../api/websocket-protocol.md)).

1. `createTurnSocket` (`frontends/ui/src/adapters/api/turn-socket.ts`) opens
   `ws://<host>/websocket?v=2&conversationId=<id>&projectId=<id>`, refreshing
   the auth cookie before every attempt. The socket is open, and sends, only
   once the server's first frame, `hello`, says it speaks wire v2; a server
   that stays silent or opens with anything else fails the attempt.
2. `server.js` upgrade handler resolves auth and scope (see [WebSocket Gateway](websocket-gateway.md)).
3. The client sends four messages: `user_message` (its `message_id` is the
   question's id, which becomes the turn id), `interaction_response`,
   `cancel_turn` (Stop) and `attach{turn_id, after_seq}` (resume).
4. Every server event carries `turn_id` and `seq`. The driver in
   `features/chat/hooks/use-websocket-chat.ts` hands them to the store's
   `applyTurnEvents`, which folds them with `foldTurnEvent`
   (`features/chat/lib/turn-fold.ts`) and draws the view into the thread
   (`features/chat/lib/turn-projection.ts`). Answer deltas wait for a 100 ms
   flush; anything else is folded at once.
5. `RUN_STARTED` acknowledges the question; until it arrives the question is
   resent on every reopen. A question not acknowledged within 15 s reopens the
   socket, and a second miss ends the turn with an error card and its Retry.
   A running turn, and a finished one whose stages have not landed, is
   re-attached from its last seq whenever the socket reopens; one silent on
   two sockets in a row is ended. Close code 4426, or a frame this bundle
   cannot parse, asks the reader to reload.

## Chat store

`frontends/ui/src/features/chat/store.ts`

The `useChatStore` Zustand store is three slices (`stores/`); `ChatStore` is
their union.

### Turn actions

| Action | Purpose |
|---|---|
| `addUserMessage(content, metadata?)` | Append the question, create the conversation if needed, name it |
| `beginTurn(conversationId, turnId)` | Start folding a turn: one just sent, or one a reload is re-attaching |
| `applyTurnEvents(events)` | Fold events into their turns and draw each changed turn in one `set()`; the terminal settles and persists the answer |
| `dropTurn(turnId)` | Forget a turn the stream no longer holds, with its unfinished answer |
| `stopStreaming()` | Stop: `cancel_turn`, the partial answer kept and marked stopped |
| `respondToPrompt(messageId, response)` | Mark the open question answered |

`isStreaming`, `isLoading` and `pendingInteraction` are derived from the
running turn's view (`turnStateFor`), never set by hand.

### Session management

| Action | Purpose |
|---|---|
| `selectConversation(id)` | Switch conversation, restore state |
| `createConversation()` | Create new conversation with default data sources |
| `startNewSessionDraft()` | Clear current conversation for a fresh draft |
| `ensureSession()` | Return current conversation ID, creating one if needed |
| `deleteConversation(id)` | Remove conversation, cancel the live runs in it |
| `deleteAllConversations()` | Clear the user's conversations in the current project, cancel their live runs |
| `updateConversationTitle(id, title)` | Rename conversation |
| `saveDataSourcesToConversation(ids)` | Persist enabled data source IDs to conversation |
| `loadServerConversations()` | Fetch and merge server-side conversation metadata |

## Data flow summary

```
User types message
  addUserMessage → beginTurn → user_message on the turn socket
  server events → applyTurnEvents → foldTurnEvent → the thread
  HITL: interaction_request → prompt card → interaction_response
  Stop: cancel_turn → RUN_FINISHED(cancelled) → the stopped partial
```
