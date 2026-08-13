# Chat

The chat interface supports two communication modes: SSE (Server-Sent Events) streaming for simple conversations, and WebSocket for real-time interaction with full HITL (human-in-the-loop) support.

On small screens (below the `md` breakpoint) the chat is mobile-first: the sessions and data-sources panels open as full-width overlays capped at their desktop width, the research panel takes over the whole viewport while open, and the project sidebar is replaced by a top bar with a navigation drawer.

## Starting a conversation

Click **New chat** in the chat-history panel (left) or the quiet **New chat** button in the thread header to start a fresh conversation. On an empty thread the chat shows a time-of-day greeting (with your first name when available). Type your message in the composer at the bottom of the screen and press Enter. The first user message sets the conversation title (truncated to 50 characters).

## Thread header

The header is two floating pills, split by what they are for.

**Left — where you are.** The chat-history toggle (the door to past chats) and a breadcrumb **{project} / {session title}**. Click the session title to rename it inline — Enter or clicking away commits, Escape cancels; this uses the same rename action as the chat-history panel. The project name truncates before the session title does, because the project is already named by the composer's scope chip and the navigation rail, while the session title is the only place this thread is named at all. On a phone the project segment is dropped entirely.

**Right — what is true about this chat, then what you can do to it,** separated by a hairline.

Before the line is *status*, and none of it is clickable. Who can read the chat is answered in **one** of two forms, never both, depending on what kind of audience it has:

- **shared with named people** → their **faces**. The audience was listed person by person, so the faces are the whole answer.
- **shared with the whole project or organization** → an **access chip** (`Projekt`, `Organisation`) and *no* faces. That audience is a rule, not a list — it changes as people join the project — so avatars would show a handful of people and imply only they can read it.
- **private, just you** → neither. There is nothing to report.

Alongside it, while deep research is running, a spinner — so the "still working" signal survives scrolling past the thread's own progress banner.

Either way the full picture (the rule *and* anyone individually invited) is in the sharing surface, one click away in the menu. On small screens the faces and the access chip are hidden below the `sm` breakpoint, so the same picture also lives at the top of the **…** menu, where it is never further than one tap away.

After the line is *action*. **New chat** is the only one kept in the open. The rest live in the **…** menu, and each appears only when it is real:

| Menu entry | Appears when |
|---|---|
| **Rename chat** | there is a chat to rename — it opens the same in-place editor a click on the title opens (the menu entry is how you find it; the click is the shortcut). Enter or clicking away commits, Escape cancels — the same rename action as the chat-history panel |
| **Share** | collaboration is enabled and this thread is reachable — the one door to the sharing surface, for every participant, not only owners. On a brand-new chat the thread only reaches the server with its first message, so this entry arrives a moment after you send it rather than being there from the first keystroke |
| **Research report** | this thread already has a report, one is running, or the panel is open |

Everything in this pill comes and goes during a conversation — the participants resolve a moment after the chat opens, research starts and finishes, the menu appears with the first thing worth listing — so arrivals animate: the pill grows into its new width and the buttons slide rather than jumping. If your system is set to reduce motion, they simply appear.

If none of them applies, there is no menu button either. The main way into a report is still the "view report" action on the answer that produced it — the menu entry is for coming back after you have closed the panel and scrolled on — and the panel closes with its own ✕ or Escape.

The whole header is hidden on an empty chat that has not started yet, apart from the sessions and navigation doors.

## The composer

The composer is a white card with the message field on top and a control row below, separated by a hairline:

- **Datengrundlage chip**: shows how many data sources are currently enabled and opens the existing Data Sources panel.
- **Scope chip**: shows the current project with a lock icon. Retrieval is always scoped to this project; the popover lists a disabled "All projects" option — cross-project search is not available yet.
- **Deep Research pill**: an on/off *preference*. Piloti escalates to deep research automatically when a question calls for it; the pill records your intent and shows an honest hint — it does not force a deep-research run.
- **Attach / file counter / send**: unchanged file-upload and send affordances.

Under the composer, on an empty thread, a **Shortcuts** row offers three source presets — *Baurecht & Richtlinien* (law sources such as RIS), *Projektunterlagen* (project documents; external sources off), and *Büroarchiv* (office archive). A preset maps onto the data sources the backend actually exposes; the pressed shortcut is the only place the preset is named. Any manual change in the Data Sources panel takes you off the preset again. The composer control row does not repeat the preset as a second chip.

## Invoking a skill (`/name`)

When Agent Skills are enabled (ADR-0046), typing `/` **as the first character
of a message** opens a picker of the skills you can invoke here. ↑↓ choose,
Enter inserts, Esc closes — the same keyboard contract as the `@` mention
picker. Picking one inserts `/name ` and shows a chip naming the skill attached
to this message, together with its description, so you can confirm you picked
the right one before sending. Deleting the token removes the invocation; there
is nothing else to undo.

The menu only opens at the start of a message. Slashes are ordinary punctuation
in this field — `12/05`, `OIB-RL 2/3`, `und/oder` — and an invocation applies to
the whole message anyway, so it belongs at the front.

Each entry shows a name and a one-line description and nothing more. That is
exactly what Piloti itself is told about each skill: the full instructions are
loaded only when the skill is actually used. So a description that does not say
*when* a skill applies is as unhelpful to the assistant as it looks to you —
which is the signal to go and improve it in the project's **Skills** tab.

A message that starts with a slash but names no real skill is sent as the plain
text it is.

**Which skills were used.** An answer that loaded skill instructions carries a
quiet *Skills used* line underneath. Opening it names them and explains the
mechanism: every skill contributes its name and description to Piloti's
catalogue on every turn, and only the ones listed there had their full
instructions loaded for this answer.

## Sharing, mentions, and the inbox (collaboration)

When collaboration is enabled (ADR-0032…0036), a chat can have a named audience, and a message can address a person or the agent explicitly. Everything in this section is off unless an administrator switched collaboration on — without it the chat behaves exactly as described above.

**Sharing.** The **Share** entry in the **…** menu opens the sharing dialog for every participant, not only owners. It shows the audience as a rule or a list: a visibility choice (*Only me / Everyone in this project / Everyone in this organization*), then the people with access grouped by role (*Owners / Can contribute / Can view*), each row stating why they are there (for example "invited by {name}"). Owners can change roles, remove people, or take ownership — with a confirmation step, because ownership changes are audited. Invite search covers the whole organization; a colleague who is not in the project yet is listed as blocked with the reason, because sharing a chat never grants access to the project itself. Anyone can **Leave** the conversation — owners too, as long as another owner remains; the last owner is protected server-side. If the sharing settings fail to load, the dialog opens with a retry rather than the Share entry silently disappearing.

**Mentions.** Typing `@` in the composer opens the person picker: Piloti (the agent) pinned first, then the people in this conversation, then colleagues elsewhere in the project who would need an invitation. ↑↓ choose, Enter inserts, Esc closes — and the picker works from the very first message of a chat. Below the composer an addressee line states truthfully who the next message goes to — *Goes to Piloti*, *Goes to {name}*, or *Goes to everyone in the chat* — and doubles as the discoverable way to mention someone.

**Waiting for a person.** A message that addresses a person by name hands the thread over to them: the agent deliberately stays silent until they answer, and a banner says who is being waited for — with, per person, the question they were asked and who asked it, so a thread waiting on two colleagues still shows both. The banner always offers an escape — **Continue without waiting**, **Ask Piloti instead** (pre-fills an agent mention), or **Ask {name} back** (re-mentions the asker) — and those offers really route as mentions, so the agent is asked rather than the text sitting in the chat. When the awaited person answers, a transient offer appears — "{name} replied — let Piloti carry on?" — which pre-fills the composer with an agent mention so Piloti actually picks the thread back up. In a thread with several people talking, a plain message is a remark for everyone, and the addressee line says so; an offer can switch the thread to *answer only when mentioned* mode.

**Watching a colleague's turn.** When somebody else in a shared chat asks Piloti a question, you do not wait at a spinner: the answer streams in as it is written and the *Herleitung* builds alongside it, the same reasoning chain the person who asked is looking at. If Piloti puts a question back to them, you are told that the chat is waiting on an answer — the question is theirs to answer, so no control appears for you. The live view is a preview, not the record: the finished answer replaces it a moment later, with its sources, confidence and feedback controls. Where live delivery is not available in your deployment, this falls back to a short "Piloti is answering {name}'s question" strip and the finished answer, exactly as before.

**Who is writing.** While one or more colleagues are composing, their names and three dots appear at the foot of the chat — deliberately a different shape from Piloti's own status, so a pause is legible at a glance as a person thinking rather than the assistant working. It survives a pause mid-sentence on purpose, rather than blinking off the moment someone stops to think or to check a document; it disappears when they send, clear the box or switch chats, and otherwise after about 45 seconds without a keystroke. A closed tab or a dropped connection takes a few seconds longer, because nothing can announce that on the way out — the claim simply expires. Nothing about it is stored.

**Read-only and revoked access.** Someone with view-only access reads along but cannot send; the composer says so instead of silently rejecting, and everything on the composer that would write to the shared chat goes with it — attachments, drag-and-drop, the shortcut chips and every route to the *Datengrundlage*. Opening a file that is already attached still works: reading along is the point. If access to a shared chat is revoked while it is open, a notice explains that what remains is a local copy that no longer updates. While a colleague's turn is running, the composer is locked with a hint rather than letting two people write into one thread at once.

**The inbox.** The inbox (nav entry with a live count badge, and an "Inbox" pill on org-level pages) lists everything that needs a person: mention requests, answers, and shares. Items deep-link into the right chat, highlight the message, and are marked read as you open them; resolved items carry an *Answered* chip, the list can be filtered or archived, and the badge count also rides on the chat's own navigation on phones.

## Chat history panel

The history panel slides in from the left edge and covers the navigation rail for as long as it is open — it spans the full height of the window, because the chat route has no top bar for it to dock beneath. Close it with its **✕** or Escape; focus returns to the control that opened it.

Its heading names the panel and its size (**Chat history · 12 chats**). Below that, two controls stay pinned while the list scrolls:

- **New chat** — starts a fresh conversation. Disabled while Piloti is still answering, and the panel then says so rather than leaving you to discover it.
- **Search chats** — filters by title, and by the "Untitled chat" placeholder for chats that never got one, so what you see is what you can search. A live **n of N chats** count sits under the field and a **✕** inside it restores the full list; a query that matches nothing gets an empty state that quotes the query and offers the way back. On desktop the field takes focus when the panel opens, so you can open the panel and type. The field is hidden entirely in a project with no chats.

The list groups chats by day (Today, Yesterday, then the date) with sticky day headings. A row in **Today** carries a relative time ("4 minutes ago"); every other row carries the time of day ("14:32"), because its day is already on the heading above it. Each row shows a status icon, and the row's accessible name says the same thing in words:

- **Spinner**: a deep research job is running for this chat
- **Document checkmark**: the chat has a finished research report
- **Ellipse**: the chat's research report has expired
- **Chat bubble**: a plain chat with no deep research

Rename and delete appear on the row on hover or keyboard focus. With the `research-in-chat-history` flag on, a **Deep Research** section above the day groups lists this project's research runs — including headless/CLI ones that never touched this browser — each stating its status in words (*Running*, *Report ready*, *Failed*, *Cancelled*).

The footer explains that chats live in this browser and that research reports may expire on the server, warns when browser storage is nearly full (and says what to do about it), and holds **Delete all chats** — the destructive bulk action, kept at the far end of the panel rather than above the list it deletes. It is scoped to the current project.

Switching chats is blocked during shallow thinking (WebSocket stream) or a HITL prompt; deep research runs server-side and does not block navigation.

## Communication modes

### SSE streaming (/api/chat)

POST `/api/chat` proxies to the backend's `/chat/stream` endpoint. The response is an SSE stream of text chunks. The frontend appends chunks to the last assistant message until the stream completes.

### SSE streaming (/api/generate)

POST `/api/generate` proxies to `/generate/stream`. This endpoint emits richer typed SSE events:

| Event type | Purpose |
|---|---|
| `thinking` | Intermediate thoughts displayed in the Thinking tab |
| `complete` | End of stream marker |
| `error` | Error during generation |
| `prompt` | Agent asking for user input (HITL) |
| `intermediate` | Partial content for the Details Panel |

### WebSocket

A persistent WebSocket connection to `ws://<host>/websocket` enables real-time bidirectional communication. The `NATWebSocketClient` connects automatically when the user sends a message. Messages follow the NAT protocol:

| NAT type | Purpose |
|---|---|
| `system_response` | Final or streaming response content |
| `system_intermediate` | Thinking steps and tool calls |
| `system_interaction` | Human prompt requiring user response |
| `error` | Error with auth or processing |

The WebSocket supports auto-reconnection with exponential backoff (3 attempts, 1s delay) and an `onBeforeReconnect` callback to refresh auth cookies before the upgrade handshake.

## Deep research vs simple chat

Simple chat sends a single message through the SSE or WebSocket path and streams the assistant response back.

Deep research submits a job to the backend and receives progress via SSE events through the `/generate/stream` endpoint. The `DeepResearchBanner` component shows submission, success, failure, cancellation, and expiry states. Users can navigate away and reconnect to an active job on return. The Research Panel displays:

- **Report tab**: Final report content
- **Sources tab**: Citations collected during research
- **Thought Traces tab**: LLM reasoning steps
- **Agents tab**: Sub-agent execution traces
- **Tool Calls tab**: Tool invocations with inputs/outputs
- **Files tab**: Generated files
- **Tasks tab**: Progress checklist

**After a run finishes, the composer follows the LATEST run.** A run that
delivered a report locks the composer — the report defines the session's
context, so the composer offers *Neue Sitzung starten* and follow-up questions
belong in a fresh session. A run that failed or was interrupted produced no
report to protect, so the composer stays usable and invites a follow-up or a
retry in place.

Only the most recent run counts, in both directions. Retrying after a failure
and succeeding locks the chat, as a completed session should. Running research
again after a successful one and having it fail leaves the chat usable, so the
retry is possible — previously an earlier success kept the composer locked for
good, telling the user research had completed over a session whose report never
arrived.

## Answer sources ("Belegt durch")

Answers that already carry source data show a provenance block: structured citations from shallow/deep research (`origin` plus optional `file_name`/`page`/`number`, with `[KB]`/`[RIS]`/`[Web]` tokens and URL heuristics as fallback) and the laws named by `legal_basis` cards. Sources are tinted by origin (law / project / web) and always pair icon + label with the color; web and RIS sources link out. Answers without source data show no block — sources are never fabricated.

**One row, not a row plus a written list.** A verified answer ends in a written sources section (`## Quellen` / `**References:**`, produced by the backend's citation verification). That section is *not* rendered a second time under the answer: it is lifted out of the answer body and folded into the chip row. The chip keeps its compact shape and gains the citation's `[N]`; everything else the written list said — the untruncated title, the cited page or host, and a copyable citation — sits **one click away**, in the chip's existing preview popover or document dialog. Each chip is also the anchor its inline `[N]` marker scrolls to. The `[N]` → source binding comes from the backend (`sources[].number`, resolved by `verify_citations`); when it is absent (legacy messages, deep-research SSE) the frontend falls back to matching on document identity, and an answer whose sources were never numbered simply shows no indices.

### Citing a source elsewhere

A source's preview popover (or document dialog) carries a copy button that yields a **German Fachtext citation** — the form a Befund, Gutachten or Einreichung uses (e.g. `OIB-Richtlinie 2 – Brandschutz, Ausgabe Mai 2023, S. 18 (Österreichisches Institut für Bautechnik, Wien).`). The **Zitieren / Cite** menu at the end of the chip row copies *all* of the answer's sources in one of:

| Format | For |
|---|---|
| Zitiertext (Fachtext) | Pasting into a report or submission |
| APA | A formatted bibliography |
| BibTeX (`.bib`) | LaTeX, JabRef |
| EndNote/Zotero (`.ris`) | Reference managers |
| CSL-JSON | Zotero, Word, pandoc |

The citations are built from CSL-JSON items derived from the source data — an OIB Richtlinie becomes a CSL `standard` with its publisher and edition, a RIS source `legislation` with its retrieval date, a project upload a `report`. Nothing is invented: an unknown edition, page or date is simply absent. The bibliographic formats are rendered by [citation-js](https://citation.js.org/) on the BFF (`POST /api/citations/format`) because it is a Node library; if that call fails, the copy degrades to the Fachtext bibliography.

Note the name collision: "RIS" is both the Austrian Rechtsinformationssystem (a source) and the RIS tagged file format (`.ris`, the reference-manager interchange). The menu labels the latter "EndNote/Zotero (.ris)".

### Source preview (clicking a chip)

When a finished answer cites **exactly one** project or Büroarchiv file, that
file opens beside the chat on its own (the same peek used by "Ask about this
file"). Law, RIS and web citations never auto-open, and neither do answers
that cite two or more project files — picking would be a guess. Dismissing
the peek drops the retrieval focus; it does not come back on the next render
of the same answer.

Clicking a source chip opens a preview of the source instead of doing nothing:

- **Web / RIS chips** keep linking out to the real source (RIS citations always hit the official Rechtsinformationssystem).
- **Knowledge chips (`[KB]`)** whose citation names a document that exists for the current project — a project upload (PDF or image) or a base-corpus PDF (OIB Richtlinien) — open an in-app viewer dialog: a provenance-tinted document-type chip plus the title in the header, the document itself in the body (opened at the cited page when the citation carries one, e.g. `file.pdf, p.3`), and the cited passage in a tinted "Fundstelle" box when the citation carries passage text. Shallow and deep research attach structured `file_name` / `page` / `collection` on the wire so chips open real documents without inventing filenames in the browser.
- **The cited passage is marked in the document itself.** When the citation carries passage text, the viewer finds that passage in the page's text layer, scrolls to it, and lights it up — a short pulse on arrival that settles into a highlighter mark in the source's own tint. A **Zur Fundstelle / Go to passage** button in the viewer toolbar brings you back to it after scrolling away or after jumping to another Fundstelle on the rail. Matching is deliberately conservative: it tolerates line-break hyphenation, ligatures, punctuation and German inflection, but when a page offers two passages that fit equally well it marks neither and simply opens at the page — a mark on the wrong sentence is worse than no mark. Scanned pages with no text layer likewise open at the page without a mark.
- **Anything unresolvable** (unknown document, non-previewable file type) shows a light popover with the source's origin, title, and passage instead — never a broken viewer. Chips with nothing beyond their label stay plain.

The same affordance appears in the deep-research report's sources list: `[KB]` entries that resolve to an openable document get a small **View / Ansehen** button next to the entry.

## Human-in-the-loop (HITL)

When the agent needs input — clarification, approval, or a choice — it sends a prompt message. The chat switches to a waiting state with input controls matching the prompt type:

| Input type | UI control |
|---|---|
| `text` | Text input |
| `multiple_choice` | Option selector |
| `binary_choice` | Yes/No buttons |
| `approval` | Approve/Reject buttons |
| `notification` | Acknowledge button |

The user responds through the chat UI; the response is sent back via the WebSocket's `sendInteractionResponse()` method. Pending interactions survive page refreshes through localStorage persistence and `pendingInteraction` state restoration.

## Data source toggles

Open the **Data Sources** panel (right sidebar) to enable or disable knowledge connections. The panel has two tabs:

- **Connections**: Toggle individual data sources (web search, knowledge base, etc.) on/off. A master "Disable / Enable All" switch controls all available sources. Some sources require authentication.
- **Files**: Uploaded files attached to the current session.

Enabled data source IDs are tracked per conversation in `enabledDataSourceIds` and sent with every chat message as `enabledDataSources` metadata.

## Project-scoped chat

Set a `projectId` on the store to scope the conversation context to a specific project's documents. The `buildCollectionScopeFromRequest()` function builds an ordered scope header from the session's organization, project, and conversation IDs. Project access is enforced by `requireProjectAccess()` before requests reach the backend.

## File upload

Drag and drop or select files to attach them to the current session. Uploaded files are ingested into a session-scoped Milvus collection (`s_<sessionId>`) and become part of the conversation context. File upload status is shown via `file_upload_status` system messages. File uploads trigger a `maybeDiscardAbandonedUploadOnlySession` check: sessions with only uploaded files and no user chat messages are cleaned up on navigation.

## Session persistence

Conversations persist to `localStorage` via the Zustand `persist` middleware with the key `aiq-chat-store`. The storage layer:

- Prunes message content to stay within quota limits
- Strips connection error messages on hydration (transient errors should not survive reloads)
- Reconstructs the current conversation from its ID to avoid double-serialization
- Falls back to clearing all sessions if `QuotaExceededError` is hit

On page load, `loadServerConversations()` fetches conversations from the BFF and merges server metadata (title, dates) with local messages. Deep research job statuses are refreshed via `refreshDeepResearchSessionStatuses()` after rehydration.
