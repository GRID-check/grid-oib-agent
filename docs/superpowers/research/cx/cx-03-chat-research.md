# CX Research 03 — Chat & Deep Research (core value surface)

Scope: `frontends/ui`, traced from actual code (imports followed, no guessing). Chat transport is WebSocket (`use-websocket-chat.ts` → `server.js` `/websocket` proxy → backend NAT protocol). Deep research runs as an async backend job whose progress streams over **SSE** (`EventSource`, via `/api/jobs/async/[...path]/route.ts`), triggered by a job-ID string the WebSocket layer detects inside a normal chat response.

Entry points:
- `src/app/projects/[id]/chat/page.tsx:12-27` — sets `projectId` into the chat store (`setProjectId`, cleared on unmount) and renders `<MainLayout isAuthenticated onSignIn withShell={false} />`. `chat/layout.tsx` is a pass-through wrapper.
- `src/app/projects/[id]/research/page.tsx:16-39` — server component; resolves project access + `collectionName`, 404s if project missing, renders `<ResearchRunsList projectId projectCollection>`.

---

## Global layout skeleton

`MainLayout.tsx:56-203` is the composition root:
- Reads `useChatStore` (currentConversation, conversations, isStreaming, pendingInteraction, isDeepResearchStreaming, deepResearchOwnerConversationId, currentUserId — L56-75) and `useLayoutStore` (rightPanel, L83-84).
- Invokes `useDeepResearch()` (L88, the SSE lifecycle hook) and `useSessionUrl()` (L91, URL↔session sync) at the top of the tree — both fire regardless of which panel is visually open.
- `isNavigationBlocked = isStreaming || pendingInteraction !== null` (L130) — gates "New chat."
- Center column is inline-styled `width: isResearchPanelOpen ? '40%' : '100%'` with a 600ms transition (L163-169) — chat is squeezed to 40% width whenever the research panel opens; this is the literal embodiment of "does the research panel compete with chat for attention" (see Flow b below — yes, structurally, chat width is cut by 60%).
- `min-w-[768px]` hard floor (L153) — no responsive/mobile layout at all; narrow viewports get horizontal scroll.
- SessionsPanel/DataSourcesPanel render as **overlays** (fixed-position `DockedPanel`, `w-[400px]` hardcoded, `DockedPanel.tsx:63-75`) outside the width-animated row; ResearchPanel instead **pushes** content (占 space, not an overlay) — inconsistent interaction model between the three panels.
- `AppBar.tsx` is dead code (unused in the render tree; only `GlobalTopNav.tsx` is actually rendered via `AppShell.tsx:16`) but duplicates ~150 lines of theme/user-menu logic byte-for-byte with `GlobalTopNav.tsx` — a maintenance trap, not a CX one, but worth flagging since a future edit to one won't propagate to the "real" one.

---

## Flow (a): Send message → shallow answer with citations + grid cards

### Entry + branches
Single entry: `InputArea.tsx:236-278` `handleSubmit`. Three-way branch:
1. **HITL response mode** (`isResponseMode = !!pendingInteraction`, L205) → `respondToInteraction()` (see Flow c).
2. **Pending-files warning gate** (L252-256): if files are still uploading/ingesting and the warning hasn't been shown yet, it adds a `file_upload_status` card (`pending_warning`, non-dismissable) and **does not send** — user must press Send again to confirm sending without those files attached.
3. **Normal send** (L266-267): `sendMessage(currentMessage)` from `useWebSocketChat()`.

### Step-by-step (file:line)
1. `InputArea.tsx:78` — `useWebSocketChat({autoConnect: true})`.
2. `use-websocket-chat.ts:1121-1246` `sendMessage`:
   - Gathers `enabledDataSourceIds` (layout store) + session files with status `ingesting`/`success`, plus `'knowledge_layer'` if available (L1126-1143).
   - `addUserMessage()` (messages-store) creates the message (and conversation, lazily, via `ensureSession()` if needed) (L1152-1155).
   - Sets `currentStatus='thinking'`, `isStreaming=true`, `isLoading=true` (L1171-1173).
   - Token pre-flight (L1196-1205): if the socket's JWT already expired, buffers the payload and rotates the socket silently before sending — user sees no interruption.
   - `sendOutgoingPayload` → NAT client `sendMessage` → backend.
3. Backend streams **intermediate steps** over the same socket (`system_intermediate` → `onIntermediateStep`, `use-websocket-chat.ts:739-816`): this is the *only* client-visible trace of intent classification — `intermediate-step-parser.ts:20-30` `CATEGORY_MAP` labels function names like `intent_classifier`, `depth_router`, `shallow_research_agent`, `deep_research_agent` as display categories (`agents`/`tools`); actual routing logic is entirely server-side, the client only renders whatever step name the server reports.
4. Each intermediate step becomes a `ThinkingStep` (messages-store.ts:313-363), rendered live in `ChatThinking.tsx` (see State matrix).
5. Final answer: `system_response` → `onResponse` (`use-websocket-chat.ts:576-737`). If content matches `addAgentResponse(content, showViewReport, cards)` (messages-store.ts:686-750) — **this is where grid cards attach**: `cards: GridCard[]` (schema-validated via `validateGridCards`, L609) is spread directly onto the `ChatMessage`.
6. `isFinal` (L719-736): completes the thinking step, `setStreaming(false)`, `currentStatus='complete'`.
7. Render: `ChatArea.tsx` filters `displayableMessages` to user/prompt/agent_response/file/error/banner types (L66-81) — full deep-research `assistant`-type report messages are deliberately excluded from chat (shown in the Research panel instead, `ChatArea.tsx:319-322`).
8. `AgentResponse.tsx:138,187` renders `<GridCards cards={cards} />` **before** the markdown body, then the answer text, then an optional "View Report" button.

### Grid cards — citation rendering (the crux of this research)
Cards are Zod-typed from an auto-generated schema mirrored off backend Pydantic models (`generated.ts`, header: do-not-edit). Three card types exist:

| Card | Fields | What it shows |
|---|---|---|
| `SummaryCard` | title (req), content?, key_points?[] | Plain summary bullet list. No source/citation info at all. |
| `LegalBasisCard` | law (req), article?, section?, summary?, original_text? | Header "Legal basis: {law}" + `Art. X` / `§ Y` badges + plain-language summary + **the literal regulation excerpt** rendered as an italicized blockquote (`LegalBasisCard.tsx:34-38`) |
| `ProjectProfilePatchCard` | title, rationale, preview[], patch[] | Before/after diff table + Accept/Reject buttons that POST to `/api/projects/{id}/profile/patches` |

**LegalBasisCard is the hero card for this OIB/RIS use case, and it is currently under-baked**:
- It DOES show the actual excerpt text inline (`original_text` blockquote) — good, this is the load-bearing "proof of work."
- It has **no hyperlink or "view source" action** to the underlying OIB Richtlinie document/RIS page — a user cannot click through to verify against the primary source.
- All fields except `law` are nullable — the schema does not enforce that a "legal basis" citation actually contains an excerpt, article, or section; a degraded citation (just a law name) is schema-legal.
- Visually it's one of three interchangeable `Card` components with the same left-border treatment as `SummaryCard` — nothing marks it as *the* trust-critical artifact of the whole product. No distinct icon, no "verified"/"source" badge, no timestamp of when the Richtlinie text was last checked.
- Separately, the **research-citation UI** (used inside the Deep Research thinking tab, not inline chat) is worse: `CitationCard.tsx` renders only `getDomain(url)` (hostname) + raw URL + timestamp + cited/read icon — it never renders `citation.content` (the captured excerpt) at all, even though the type (`CitationSource`, types.ts:262-269) carries a `content: string` field. A richer sibling component, `SourceCard.tsx`, *does* render `title`+`snippet` but is dead code — unused anywhere except its own spec file. The richer citation experience exists in the codebase but isn't wired up.

### State matrix (Flow a)
| State | Trigger | User-visible signal |
|---|---|---|
| idle | initial / after complete or error | placeholder text, empty input enabled |
| thinking | `sendMessage` sets `currentStatus='thinking'` | `ChatThinking` header: spinner + "Working on a response..." |
| streaming (intermediate steps) | `onIntermediateStep` | new rows appended to the thinking list, `Send` button shows pulsing "..." (`InputArea.tsx:561-564`, no real spinner) |
| complete | `onResponse` isFinal | `AgentResponse` bubble renders cards+markdown; `ChatThinking` header flips to check + "Done" |
| error | `onError` (any branch) | dismissible `ErrorBanner` with expandable raw details |
| empty (no conversation) | fresh draft session | `WelcomeState` (ChatArea.tsx:338-469) — hardcoded marketing copy, decorative prompt suggestions with **no onClick to actually populate the input** |

### Edge cases / failure modes
- `ChatArea.tsx:139-161` computes per-message `isWaiting`/`hasResponse`/`isInterrupted` by re-slicing the message array on every render (not memoized) — a fragile, potentially costly heuristic for long conversations.
- `handleFileRetry` is an explicit no-op stub (`ChatArea.tsx:122-126`, `TODO: Implement file retry/cancel/delete...`) — file error recovery is currently unimplemented in the UI despite the affordance existing.
- Auth pre-flight (token refresh) is silent and seamless when caught in advance; but `auth_expired` errors arriving mid-stream are retried up to `MAX_CONSECUTIVE_AUTH_EXPIRED = 3` times silently before finally surfacing `auth.session_expired` (`use-websocket-chat.ts:866-897`) — good UX (bridges brief token blips) but there is zero visible signal to the user that a rotation happened at all, even on the 2nd/3rd retry.

### Current UX state / CX gaps
- Grid cards ("proof of work") are visually indistinguishable from each other — LegalBasisCard, the actual differentiator for an OIB compliance copilot, gets no special treatment.
- No click-through to source document for legal citations anywhere in the app (chat cards or research citations).
- Decorative-only prompt suggestions in the empty state (dead UI — buttons/pills that don't do anything) undermine the "premium" first impression.

---

## Flow (b): Deep research — clarifier → job submit → live progress → report

### Entry + branches
There is no explicit "Start Deep Research" button traced in the read files — the backend decides to escalate a chat turn into a deep-research job, signaled purely by a magic string in a normal WS response: `use-websocket-chat.ts:613-615` regex `Deep research job submitted. Job ID: ([a-f0-9-]+)`. Before that, HITL clarifier/plan-approval prompts arrive as ordinary `system_interaction` frames (`onHumanPrompt`, L818-849) — same mechanism as any other HITL prompt (Flow c).

### Step-by-step
1. Clarifier/plan-approval prompt(s) exchanged via WS HITL loop (Flow c) — these are *not* SSE, still plain WebSocket.
2. On escalation detection (`use-websocket-chat.ts:611-708`):
   - Derives a conversation title from the plan JSON/markdown (L624-682), renames the session.
   - `addDeepResearchBanner('starting', jobId)` (L685) — chat-embedded banner, "Chat is paused, View Progress."
   - `addAgentResponseWithMeta('', ...)` creates an empty tracking message carrying `deepResearchJobId`, `deepResearchJobStatus:'submitted'`.
   - `startDeepResearch(jobId, messageId)` (L702) hands off to the deep-research store/hook; **`isStreaming` stays true** (input remains blocked) until the SSE layer releases it.
3. `use-deep-research.ts:660-723` auto-connect effect fires on `deepResearchJobId` change; opens the Research panel to the **Tasks** tab (L688-689) — this is the one place a tab auto-switch does happen (contradicts the general finding that `researchPanelTab` is never auto-flipped mid-run — it IS flipped once, on job start, but never again, e.g. not auto-switched to Report on completion).
4. SSE connects to `/api/jobs/async/job/{jobId}/stream` (`deep-research-client.ts:320-337`, proxied by `route.ts:141-152`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`). Fresh job → live per-event mode; reconnect (page refresh, status already `running`) → buffered-replay mode, flushed in one `setState` to avoid render storms (`use-deep-research.ts:186-280`, explicit comment about avoiding "Aw Snap" crashes from hundreds of individual store writes).
5. Status progression drives `currentStatus`: `researching` (stream start / tool end) → `searching` (tool start) → `writing` (report.md file signal, or final_report output chunk) → `complete`/`error` (terminal `onJobStatus`).
6. Tabs populate live: `TasksTab` (todos, progress % computed client-side from completed/total counts), `ThinkingTab` → six sub-tabs (Agents/Thoughts/Tools/Files/Read/Referenced — Agents is default), `ReportTab` (only `outputCategory==='final_report'` chunks are shown; draft/notes filtered out since they can be partial/cancelled JSON, `use-deep-research.ts:500-512`).
7. On success: patches the tracking message (`deepResearchJobStatus:'success'`, `showViewReport`), `addDeepResearchBanner('success', ...)` (only banner type with a rendered action button — see below), `stopAllDeepResearchSpinners(true)`, `setStreaming(false)`.

### State matrix (Flow b)
| Phase | `currentStatus` | Tabs behavior | Chat-area signal |
|---|---|---|---|
| submitted | `'submitted'`/(handoff) | Tasks tab opened automatically | `starting` banner, input disabled |
| researching | `'researching'` | Tasks fills in; Thinking→Agents/Tools populate | banner persists |
| searching | `'searching'` | ToolCallsTab shows running tool | — |
| writing | `'writing'` | ReportTab shows amber "research notes" preview if `reportContentCategory==='research_notes'`, else streaming final report | — |
| success | `'complete'` | Report tab has final content; ExportFooter enabled | `success` banner with "View Report" button; input re-enabled |
| failure/interrupted | `'error'` | spinners frozen as `stopped`/`error` | `failure`/`cancelled` banner (no button rendered — see gap below) |
| reconnect (page reload mid-job) | inferred via `deepResearchStatus !== 'submitted'` | buffered replay, single flush | banner state restored from persisted message |
| timed-out (stall >60s) | separate `isTimedOut` flag | — | (not clearly surfaced in UI per traced files — returned by hook but no consuming component confirmed) |

### Edge cases / failure modes
- **DeepResearchBanner button gating bug/inconsistency**: `getBannerConfig` computes `buttonText`/`buttonTab` for `success`, `failure`, *and* `cancelled` (DeepResearchBanner.tsx:88-111), but the actual button only renders `if (bannerType === 'success')` (L172) — so a failed or cancelled job's banner silently drops its "View Thinking"/"View Progress" action even though the copy was written for it. Users hitting a failed deep-research run have no direct link back into what happened, from the banner.
- Cancel has **two independent fallback timers** by the code's own admission: `ResearchPanel.tsx:93-132` comment explicitly says its 5s fallback mirrors one in `use-deep-research.ts` (`CANCEL_FALLBACK_TIMEOUT_MS=5000`, L38) — duplicated safety net, not wired as one shared mechanism.
- ReportTab's "research notes" preview mode hardcodes `isStreaming={false}` (ReportTab.tsx:74) even while a job is still actually writing — a small but real inconsistency in a state that's meant to represent "still in progress."
- Job load guard: `use-load-job-data.ts:645-646` explicitly throws if `getJobStatus` isn't yet terminal — you cannot "View Report" on a running job from the on-demand path; only live SSE serves in-progress data.
- If a job record has expired/vanished server-side (`use-load-job-data.ts:201-250` `syncMissingJobToFailureState`), the UI reconstructs a synthetic "expired" banner from whatever local traces remain (title, prior success banner) — reasonably graceful degradation.

### Is deep-research progress legible or noisy?
**Noisy and duplicated in layers.** Progress exists simultaneously in: (1) the chat-embedded banner, (2) the Tasks tab progress bar, (3) the collapsed-panel toggle-button spinner label, (4) six separate Thinking sub-tabs (Agents/Thoughts/Tools/Files/Read/Referenced) each with their own badge counters using inconsistent badge vocabularies (`"${n} running"` vs `"${n} active"` vs plain counts — `AgentsTab.tsx:61-67`, `ThoughtTracesTab.tsx:39-43`, `ToolCallsTab.tsx:40-46`, `FilesTab.tsx:36-38`). There's no single "here's what's happening right now" headline — a user must actively tab-hop to piece together status. The developer-facing raw `JobID: {deepResearchJobId}` string is printed directly in the Tasks tab header (`TasksTab.tsx:51-53`) — should never be user-facing copy.

### Does the research panel compete with chat for attention?
Structurally yes: chat area shrinks to a fixed 40% width the instant the panel opens (`MainLayout.tsx:163-169`), and — separately — the panel auto-opens to the Tasks tab the moment a job starts (`use-deep-research.ts:688-689`), effectively forcing the layout change on the user rather than it being a deliberate choice. Since deep research also keeps `isStreaming=true` (chat input disabled) for the entire run, the user is pushed into the research panel and given nothing else to do in the (now cramped) chat pane except watch the "Chat is paused" banner.

---

## Flow (c): HITL prompt approve/reject

### Entry + branches
`onHumanPrompt` (`use-websocket-chat.ts:818-849`) is the single entry for *all* HITL prompts (clarifiers, plan approvals, arbitrary text/choice questions) — one WS message type handles every prompt shape. `pendingInteraction` (`PendingInteraction`, types.ts:243-256) carries `inputType: 'text'|'multiple_choice'|'binary_choice'|'approval'|'notification'`.

### Step-by-step
1. Server sends `system_interaction` → `setPendingInteraction(...)`, `addPlanMessage` (captures the plan snapshot before the prompt bubble itself, ordering matters for restore), `addAgentPrompt` (renders bubble), then **pauses streaming**: `setStreaming(false); setLoading(false)` (L846-848) — this is the literal "waiting-HITL" state.
2. `AgentPrompt.tsx` renders the prompt (display-only per its own header comment, L4-12) **except** for plan-approval prompts:
   - `APPROVAL_PROMPT_RE` (L26-27) is a regex matched against the raw prompt text: `/Reply\s+\*{0,2}approve\*{0,2}\s+to proceed,\s+\*{0,2}reject\*{0,2}\s+to cancel/i`. This is a **string-pattern coupling to backend LLM copy** — if the backend ever rewords the approval prompt, the Approve/Reject buttons silently stop appearing, with no test or type linking the two.
   - `showApprovalButtons` additionally requires a live `respondToInteractionFn` (L67) — a callback registered into the store by `InputArea.tsx:190-194` on mount. If `InputArea` hasn't mounted yet, buttons won't render even on regex match.
   - `handleApprove`/`handleReject` (L69-75) call `respondToInteractionFn?.('approve'|'reject')` directly — no confirmation dialog for what is effectively "commit to starting/cancelling a deep research run."
3. Ordinary text/choice prompts are **not directly actionable from the bubble** — user must type the answer in the main chat input, which then routes through `InputArea.handleSubmit` → `isResponseMode` branch → `respondToInteraction(currentMessage)` (`use-websocket-chat.ts:1259-1334`).
4. `respondToInteraction`: marks the message responded (`respondToPrompt`), builds `{kind:'interaction', interactionId, parentId, response}`, sends, and on success restores `isStreaming=true` — same token pre-flight/rotation logic as normal sends.

### State matrix (Flow c)
| State | Signal |
|---|---|
| waiting-HITL | `AgentPrompt` header "Agent needs your input" (MessageSquare icon), input placeholder switches to response-mode copy, options list shown for choice prompts |
| responded | header dims to "Agent received your input" (`opacity-75`), `ResponseDisplay` shows "Your response: {response}" |
| approval-prompt-only: pending | Approve (outline)/Reject (destructive) buttons shown inline, right-aligned |
| approval-prompt-only: answered | buttons disappear, response text shown |

### Edge cases
- Regex-based detection is the single largest fragility point in the entire HITL flow — a wording change on the backend (even punctuation) breaks the one-click affordance with no compile-time or test-time signal.
- No confirmation step before Approve/Reject despite Approve typically kicking off a (potentially long, resource-consuming) deep research job — a "premium" product would likely want at least a brief "Starting deep research…" acknowledgment state between click and the chat-pause banner appearing.
- Ordinary (non-approval) prompts have zero in-bubble affordance — a user unfamiliar with the pattern might not realize they need to type into the chat box rather than click something on the prompt card itself; no visual cue redirects attention to the input.

---

## Flow (d): Sessions — create/switch/rename/delete, project-scoping, reconnect-after-reload

### Entry + branches
All CRUD is presentational in `SessionsPanel.tsx` but delegated via props from `MainLayout.tsx`, backed by `sessions-store.ts`.

### Step-by-step
- **New session**: `MainLayout.handleNewSession` (L104-110) → `startNewSessionDraft()` (sessions-store.ts:439-481) nulls `currentConversation` (draft state, no object created yet) and garbage-collects the *previous* session if it was abandoned (zero messages, no active job — `maybeDiscardAbandonedUploadOnlySession`, L270-294). The real `Conversation` is only materialized lazily by `ensureSession()`/`createConversation()` the first time something needs to persist. `MainLayout` also opens `data-sources` panel by default for new sessions (L107-109).
- **Switch**: `selectConversation` (L533-605) — persists deep-research ownership handoff if leaving a conversation owns the active job, verifies conversation ownership (`userId === currentUserId`), closes the right panel, and calls `restoreSessionState` + `restoreConversationDataSources` to rehydrate thinking steps, pending HITL, plan messages, enabled data sources.
- **Rename**: inline edit in `SessionItem` (`SessionsPanel.tsx:315-478`) → `onRenameSession={updateConversationTitle}` wired directly with no wrapper (`MainLayout.tsx:195`).
- **Delete one**: `deleteConversation` (sessions-store.ts:607-675) — if the session owns an active/incomplete deep-research job, fire-and-forgets `cancelJob()`, **failures only `console.warn`'d**, never surfaced to the user (so a "deleted" session's job could keep running server-side without any user-visible signal).
- **Delete all**: `deleteAllConversations` (L677-764) — same silent-cancel-failure pattern across every non-terminal job, `Promise.allSettled`.
- None of the three delete confirmation modals name the item being deleted (generic "this session"/"ALL sessions"/"files" copy) — no way to double-check you're deleting the right thing from the dialog text alone. `DeleteFileConfirmationModal` additionally has a grammar mismatch ("Deleting Files" / "remove it" — plural/singular clash) despite only ever deleting one file at a time.

### Project scoping
**Chat sessions are NOT project-scoped.** `Conversation` (types.ts:230-240) has no `projectId` field; `MainLayout` filters the session list only by `currentUserId` (L132-135) — a user's sessions from every project appear together in one flat list. `projectId` exists only as a scalar in the messages-store slice (set/cleared by the project chat page) and is consumed in exactly two places: the WS payload (so the backend knows which project corpus to use) and `FileSourcesTab.tsx` (project-vs-private upload target toggle). **File uploads are project-scoped; the conversations containing them are not** — a real architectural/mental-model inconsistency.

### Reconnect-to-active-job-after-reload
Three-tier mechanism, none of it inside the panels:
1. `providers.tsx` `DeepResearchRestorer` (~L150-172): on mount/`currentConversationId` change, calls `reconnectToActiveJob()` then `cleanupOrphanedStartingBanners()`.
2. `deep-research-store.ts` `reconnectToActiveJob()` (~L600-686): scans messages for an active/submitted deep-research message, double-checks with `getJobStatus` (REST) before trusting stale local state, and if genuinely still running flips `isDeepResearchStreaming=true`.
3. `use-deep-research.ts` auto-connect effect picks that flag up and reconnects SSE in buffered-replay mode.
Separately, `SessionsPanel.tsx:109-120` runs a lighter `refreshDeepResearchSessionStatuses()` on panel open — purely a badge/status refresher (session-list icons), not a stream resume.

### Edge case: broken deep-link
`research-runs-list.tsx` "View report" link (L139-144) navigates to `/projects/{id}/chat?job={jobId}` — **but nothing in the app reads a `?job=` query param** (confirmed via grep); the chat page only reads `?session=`. Clicking "View report" from the project research page currently drops the job ID on the floor and shows... whatever the last active session was. This is a broken flow end-to-end.

---

## Flow (e): Data sources & file sources toggling

- `DataSourcesPanel.tsx` — `handleToggle` (L104-114) flips one source via `toggleDataSource` (layout store) then persists onto the current conversation via `saveDataSourcesToConversation` (sessions-store, lazily creates a session if needed). Sources requiring auth are filtered out unless a valid token exists, with a banner explaining why (L189-197).
- Switching to the Files sub-tab explicitly re-pulls files for the session to "detect backend-side removals (e.g. TTL cleanup)" (L120-121) — a deliberate resync, a nice touch of correctness.
- `FileSourceCard.tsx` shows a **live-updating expiry countdown** ("Expires in N min", recomputed every 60s) and a "Deletion Pending – Reupload" state once TTL lapses — good transparency about ephemeral file storage, though it means uploaded files silently expire and the user needs to notice the countdown to avoid losing them mid-conversation.
- File delete confirmation is generic/plural-mismatched (see Flow d).

### CX gap
No project-scoped session filtering (Flow d) but per-file "Project corpus vs. Private session" targeting exists here (`FileSourcesTab.tsx:67, 218-246`) — two different mental models for "where does this belong" living side by side in the same right panel.

---

## Flow (f): Research runs list → view report

`src/app/projects/[id]/research/page.tsx` (server) → `research-runs-list.tsx` (client):
- Fetches via `listResearchRuns({projectCollection, limit:50})` (adapter → `/api/v1` → backend `/v1/jobs/async/jobs`).
- Loading: 5 skeleton rows. Error: destructive alert with message. Empty: plain text, "No research runs yet. Start one by asking Grid a deep question in Chat." — **no CTA button**, unlike SessionsPanel's empty state which does offer one — inconsistent empty-state treatment between two sibling "no items yet" screens in the same app.
- Status badge mapping (`STATUS_BADGE_VARIANT`) is looser than the type system: `ResearchRun.status` is typed as plain `string`, not the `ResearchRunStatus` union, and includes a `'pending'` mapping not in that union — any unrecognized backend status silently falls back to a generic "secondary" badge with no warning.
- "View report" link only renders for `completed` jobs, but is a **dead link** (see Flow d) — the single most consequential broken flow found in this audit, since it is the primary reason this page exists.

---

## Flow (g): Connection loss/recovery, auth expiry mid-stream

### Mechanism
- `use-connection-recovery.ts` — zero-overhead until `hasConnectionError` is true; exponential backoff 5s→60s (`INITIAL_DELAY_MS`/`MAX_DELAY_MS`/`BACKOFF_FACTOR=2`), plus fast-path triggers on `window online` and `document visibilitychange`. On recovery, dismisses connection error cards and calls back into `connect()` — no replay of pre-failure content through this path.
- `NATWebSocketClient` (`adapters/api/websocket-client.ts`) itself retries up to `reconnectAttempts=3` at a **fixed** 1000ms delay (not exponential) before escalating to `onError({code:'CONNECTION_FAILED'})`, which is what triggers the slower, exponential `use-connection-recovery` polling loop — i.e., two different backoff strategies stacked (fast fixed-delay socket retries, then slow exponential health-check polling once those are exhausted).
- Unacknowledged-send replay: a message sent right before a disconnect is buffered and replayed **once** (`MAX_UNACKNOWLEDGED_OUTGOING_REPLAYS=1`) silently on reconnect — if it fails twice, `CONNECTION_FAILED` surfaces normally.
- Auth expiry mid-stream: `auth_expired` errors (matching both an error code AND message) are silently retried (socket rotation, no visible interruption) up to 3 times; beyond that, `auth.session_expired` is shown as a dismissible error card and streaming/pending-interaction state is cleared — **an in-flight HITL prompt is lost** at that point (pendingInteraction gets cleared, L883-888), meaning a user mid-approval who hits a hard session expiry has to restart that exchange with no specific messaging that "your pending approval was cancelled by a session expiry," just a generic session-expired card.
- Deep research SSE: EventSource auto-reconnects up to 5 attempts before escalating; a stall >60s sets `isTimedOut` but no consuming UI component was found rendering it — **the deep-research stall/timeout signal appears to be computed but not surfaced anywhere in the traced components** (worth verifying against the shadcn rewrite in progress).

### State matrix (Flow g)
| State | Where set | Visible signal |
|---|---|---|
| connected | `onConnectionChange('connected')` | none (implicit) |
| reconnecting (socket-level, fixed delay) | `handleReconnect` in websocket-client.ts | no distinct UI state — flicker suppressed while retries remain |
| reconnecting (recovery polling, backoff) | `use-connection-recovery.ts` activation effect | error card remains visible until recovered |
| session_expired | `auth.session_expired` error code | dismissible ErrorBanner, streaming/pending-interaction cleared |
| connection.failed | `getTransportFailure`/backend health check | dismissible ErrorBanner |
| deep-research timed-out | `isTimedOut` flag, use-deep-research.ts | **no confirmed consumer** — likely a gap |

---

## State matrix — full transport-hook survey (cross-flow reference)

| State | Set at | Read/gates |
|---|---|---|
| idle | `currentStatus=null` after error/cleanup | input enabled |
| thinking | send / intermediate step in_progress | ChatThinking spinner header |
| streaming | `isStreaming=true` | input disabled, busy hook true |
| waiting-HITL | `onHumanPrompt` | AgentPrompt renders, input placeholder swaps |
| complete | `onResponse` isFinal / job success | Done header, ReportTab populated |
| error (app/backend) | various `onError` branches | ErrorBanner |
| researching/searching/writing | deep-research phase signals | Tasks/Thinking/Report tab content |
| deep-research submitted/running/success/failure/interrupted/cancelled | job status | banner + tab state |
| reconnecting | socket or recovery-poll | mostly invisible until exhausted |
| session_expired | auth_expired cap exceeded | ErrorBanner, pending interaction dropped |
| timed-out | 60s stall check | flag only, no confirmed UI consumer |
| session busy (derived) | any of streaming/deep-research/pending-interaction | gates file ops, data-source toggles, export, delete/switch session |

---

## Top 6 CX opportunities

1. **Make LegalBasisCard the visible hero of the product, with a real source link.** Right now it's one of three visually-interchangeable cards, its `original_text` excerpt is the only "proof of work" shown anywhere in chat, and there is no click-through to the actual OIB Richtlinie/RIS document. For a compliance copilot, this card should look distinct (dedicated icon/badge, maybe a "Verified citation" treatment), always show article/section when available, and link out to the primary source. Also fix the parallel gap in `CitationCard.tsx` (Research panel → Thinking → Read/Referenced), which drops the `content` excerpt entirely and shows only a domain name — wire in the already-built but unused `SourceCard.tsx` (which has title+snippet) instead of the current bare-URL card.

2. **Fix the broken "View report" deep link.** `research-runs-list.tsx` navigates to `/projects/{id}/chat?job={jobId}`, but nothing reads `?job=` — the entire point of the project Research page (browse past runs → view report) currently does not work. This is the single most concrete, highest-severity bug found.

3. **Stop the research panel from visually squeezing chat to 40% width and auto-opening on job start.** Combined with the chat input being fully disabled for the run's duration, this leaves the user staring at a cramped chat pane with only a static "paused" banner. Consider either an overlay/drawer model (like SessionsPanel) that doesn't shrink chat, or making the panel width user-resizable/collapsible with memory, and let the user choose whether to jump into it rather than forcing the switch.

4. **Consolidate deep-research progress into one legible headline instead of six sub-tabs with inconsistent counters.** Tasks/Thinking(Agents/Thoughts/Tools/Files/Read/Referenced)/Report currently split status across a maze of badge vocabularies ("N running" vs "N active" vs plain counts) with a raw `JobID:` string leaking into user-facing copy. A single persistent "what's happening now" status line (current phase + current task/tool in plain language) surfaced above or instead of the tab maze would make this feel premium rather than like an internal debug view.

5. **Make session and file scoping consistent, and make deletes safe.** Chat sessions aren't project-scoped (all of a user's sessions across every project show in one flat list) while file uploads are — a confusing mismatch. Compounding this, delete confirmations (session/all-sessions/file) don't name the item being deleted, and job-cancellation failures during delete are silently swallowed (`console.warn` only) — a user could "delete" a session while its deep-research job keeps running server-side with zero indication.

6. **Harden the HITL approve/reject path beyond a regex on LLM prose.** `AgentPrompt.tsx`'s one-click Approve/Reject (the only in-bubble actionable HITL affordance) depends on matching `/Reply\s+\*{0,2}approve\*{0,2}.../` against backend-generated text — any copy change silently breaks it with no test coverage tying the two together. Given that approving here kicks off a real deep-research job, this should be a structured, typed signal from the backend (a prompt "kind" field), not string-sniffing, and should show a brief "Starting deep research…" acknowledgment between click and the chat-pause banner rather than an instant, silent pause.
