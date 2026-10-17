# Anmerkungen: marks on a document, the Prüfansicht, and Piloti on it

An **Anmerkung** is a mark on one page of one Fassung: a point, or a drawn box (a
*Bereich*). It carries what it says, a running number, optionally a person
responsible and a date, and a thread of answers. The term is defined in
[`CONTEXT.md`](../../CONTEXT.md) under „Anmerkung“. This page covers the moving
parts.

## The data, and the rules the database holds

Migration `frontends/ui/drizzle/0138_document_annotations.sql` creates two
tables, both under `grid_secure_table` RLS.

| Table | Holds | RLS predicate |
|---|---|---|
| `document_annotations` | the mark: page, shape, normalized box, kind, body, basis, author kind, status, assignee, due date, Fassung, number | org, and the document's org |
| `document_annotation_replies` | the thread | org, and the annotation's org |

The coordinates are normalized to the page, 0 to 1 with the origin at the top
left. This is the same frame as `PageRegion` in the PDF viewer, so a mark stays
put at any zoom and on any screen.

The domain rules are CHECK constraints, not service code. A tired contributor
cannot route around them:

- Only Piloti proposes.
- A mark by Piloti is `open` only with a person behind it: `accepted_by` is set,
  by the person who took it over, or by the person who asked Piloti for it.
- A closed mark (`resolved`, `dismissed`) says who closed it and when.
- A box stays on its page.

`scripts/rls-test-db.sh` refuses each CHECK against a real PostgreSQL, then
applies the down migration and re-applies the up migration.

Migration `0139_piloti_wakes.sql` adds what wakes Piloti (below, „Events wake
Piloti“):

| Where | Holds | CHECK |
|---|---|---|
| `document_annotation_replies.addresses_agent` | the reply addresses Piloti: the composer's @Piloti chip, never read from the text | default false |
| `document_annotations.delegated_by`, `delegated_at` | Piloti is the delegate, working the mark for this person | both or neither (`…_delegation_complete`); only on an open mark (`…_delegated_while_open`) |
| `piloti_wakes` | one row per event that met a wake rule: its id is the job id and the turn id (uuid5 of the event); trigger, event, the person who acted, and what it came to: `queued`, then `started` and its final word, `answered`, `stopped` or `failed` (a turn that ran), or `suppressed` and `refused` (no turn ran) | a reason exactly for `suppressed`, `refused` and `failed`; `settled_at` exactly when it left `queued`; `ended_at` exactly when it reached its final word (migration `0141_wake_ends.sql`); RLS on the org and the mark's org |

Migration `0142_piloti_changes.sql` adds the change record: every change Piloti
applied to a mark or a thread, with the turn that made it. The chat card reads
it, and undo runs from it (below, „In the chat“). Each change is also one
`piloti.change.applied`, and each undo one `piloti.change.undone`, in the
organization's WorkOS audit log, where an admin reads what Piloti did and for
whom ([the trail](../deployment/workos-provisioning.md#5-audit-logs-native-workos-product)).

Numbers are allocated under an advisory lock per document, so two people
setting a mark at the same moment never share a number. Status moves are
compare-and-swap on the expected status (`updateDocumentAnnotation`): a
conflicting move returns 409, and the canvas re-reads.

Every read ANDs `documentVisibleTo(reader)`, and the repository functions are
registered in `lib/documents/document-visibility.spec.ts`. A held upload's
marks are as invisible as the upload.

**What a listing says about them.** Every listing row (`toListedDocuments`,
`lib/documents/shelf-listing.ts`, so a project's Dateien, the Archiv and the
by-name reads alike) carries `marks: { live, forYou }`: how many of the
document's marks are live (`isLive`: open, and Piloti's proposals nobody
decided on, on every Fassung) and how many of those are open with the reader as
Zuständige, or `null` when none is live. `tallyLiveMarks`
(`lib/annotations/repository.ts`) counts a whole page in ONE grouped query,
bounded by the page's ids, that joins `documents` behind the listing's own
`documentVisibleTo(reader)`. A proposal that names the reader is not theirs
yet: only the person who takes it over makes it so. The count comes with the
listing and is as fresh as its last read; it is not live. Dateien draws it as
`OpenMarksChip` (`features/documents/components/open-marks-chip.tsx`), the
kit's `Chip`, in a card's footer and beside the name in the list, labelled
„3 offene Anmerkungen, 1 für Sie“. A press opens the review: the page's own URL
with `doc` and `review=1` (`reviewHrefAt(…, { withDocument: true })`), which
the shelf's `?doc=` sync and the pane already answer.

## The service and its API

`frontends/ui/src/lib/annotations/`:

| File | Owns |
|---|---|
| `types.ts` | the zod contract: requests, the view, the agent's internal request |
| `repository.ts` | SQL |
| `service.ts` | who may do what, and the state machine (`transition()`) |
| `client.ts` | the typed client the UI uses |

Routes:

| Route | Methods |
|---|---|
| `/api/documents/[id]/annotations` | GET, POST |
| `/[annotationId]` | GET (one mark as the caller sees it: what a room hint names), PATCH, DELETE |
| `/[annotationId]/replies` | POST |
| `/api/documents/[id]/thread` | POST: the caller's own thread about the document (below) |

The list answers `pilotiWakes`, whether the organization lets events wake
Piloti. A reply answers `{annotation, replyId, wake}` and a PATCH that
delegates `{annotation, wake}`, where `wake` is `none` (no rule met), `off`
(the switch is off), `queued` (the server wakes Piloti) or `suppressed` (a cap
held it).

The UI and Piloti are equal clients of one service (ADR-0055).

## The Prüfansicht

`features/documents/components/review/` holds the canvas. `document-review.tsx`
is the document opened full screen:

- marks drawn on the PDF pages (`review-page-layer.tsx`);
- the open thread beside its mark (`thread-card.tsx`), on the side a whole card fits in pixels, else under the mark (`placeCard`); on a phone in a sheet from the bottom edge;
- the list (`review-panel.tsx`), where Piloti's proposals lead the open marks as a group you can walk through („Durchgehen": the card says „1/3", J or „Weiter" goes on, and taking one over or dismissing it moves to the next);
- the tools, leading the viewer's own pill at the foot; on a touch screen a row of their own above it, each with its name. The first review a browser opens spells every tool out with its key (`TOOLS_INTRO_KEY`), folded after the first mark or by its ×. A tool in hand says what it does next at the top of the canvas.

Everything drawn on the page is in `--paper-ink`, never `--foreground`: the
page stays white in dark mode, and the theme's ink there is paper-white.

Keys:

| Key | Does |
|---|---|
| V / C / R / P | select, point, box, ask Piloti about a box; C, R and P from the keyboard bring the crosshair (below) |
| J / K | step through the marks the list shows, proposals first |
| E | take a proposal over, or resolve an open mark |
| ⌫ / Entf | dismiss a proposal |
| / | cursor chat |
| Esc | backs out one layer at a time (the dialog's own Escape: an open menu or sheet takes its own first) |

**Without a mouse.** A mark tool taken up from the keyboard (its key, or its
button with Enter) puts a crosshair at the middle of the reader's view on the
page there (`KeyboardAim` in `review-page-layer.tsx`, `role="application"`
with a label that says the keys). The arrows move it a hundredth of the page,
with Shift a twentieth; Enter sets a point, or for a box holds the first
corner, the arrows draw the box out and Enter sets it. What it sets goes the
way a click goes: the draft card, or the question to Piloti. A held Enter is
one press. Escape is the review's own Escape and puts the tool down. The hint
at the top reads „Klicken oder ↵ · Pfeiltasten · Esc"; while the crosshair is
out it is hidden from a screen reader, which hears the crosshair's label instead.

**The focus.** A card a key opened (J, K, Enter on a pin or a row) takes the
focus itself, not its first control, so the Enter after J does not land on
„Erledigen"; whatever had the focus gets it back when the card closes (its ×,
Escape), as it does when the crosshair or the cursor chat goes
(`focus-return.ts`). A card opened by a click leaves the focus where it was.
A card is a `dialog` named by its header („Mangel #4"); a pin says its state
in words („Vorschlag", „erledigt"), who else has it open, and that it opens a
dialog (`aria-haspopup`; `aria-expanded` in the review, not in the file
preview, where a pin opens the review). The list's filter and a draft's
kinds are buttons that say which is on (`aria-pressed`), each reached by Tab.
Every control of the viewer's pill keeps its 28px target; a pill longer than
its stage scrolls, and under about 1000px of stage the tools spelled out with
their names fold to their glyphs, still named for a screen reader and with the
glyphs' tooltip (name and key).

**What a screen reader hears.** What the others do reaches it through one
polite live region of its own, there from the moment the review opens
(`review-announcer.tsx`), beside the review's few status lines (offline,
Piloti's review in the header, the tool hint): what the others did to the marks,
gathered for three seconds and said as one line („Piloti hat 3 Vorschläge
gesetzt. Anna Berger: neue Anmerkung 7"), and „Piloti hat geantwortet" when a
question this reader asked is answered. Never a pointer or who came and went,
never this reader's own changes, in this tab or another. The same line twice
is said twice. The pointers and their tags are hidden from it.

A mark of an earlier Fassung is listed and never drawn; selected, its thread
opens over the sheet, saying so in its first line. Status moves carry the status the card showed
(`expectedStatus`), so a stale tab gets the conflict notice, never a blind
change. The list is read again when the room returns after a drop and when the
tab returns to view.

`use-document-review.ts` is the state both surfaces share: the inline layer in
the file preview, and the full-screen review. While the review is open the
inline viewer is not mounted at all: one viewer draws the document at a time.
Closing the review opens it again at the page the reader was on in the review.

**The review's address.** While the review is open the URL says so:
`review=1`, `mark=<id>` for the selected mark and `tool=point|region` for a
tool in hand (`features/documents/lib/open-review.ts` reads and writes them;
the pane keeps them in step). Opening from the pane pushes, so Back closes the
review; a new mark or tool replaces, so walking the marks is one entry; closing
goes back, or takes them off when the review came in by a link. A reload stays
in the review, and the Files reconciler (`use-preview-channel.ts`) drops them
when a different document opens. The pane writes the address only where the URL
names its document (Dateien's `doc`, or the chat's peek).

**Ways in from the file preview.** The header's „Prüfansicht öffnen" (a PDF
that carries marks opens full screen as the review, not as the enlarged
viewer, which images keep); „Anmerken" in the viewer's pill and at the phone
reader's thumb, which opens the review with the point tool armed (`tool=point`,
`initialTool`); the rail's „Anmerken und prüfen" and „Dazukommen"; and a pin's
hover card („In der Prüfansicht öffnen", `inline-mark-peek.tsx`, a hovering
pointer only: a tap on a pin opens the review as before). The pane header shows
who is in the document with the review's own `Presence`, without following.

**Before a Freigabe.** The approve confirm in the rail
(`document-review-controls.tsx`, under „Freigabe und Fassungen“) names the
live marks the pane's review holds, before the signature: „4 offene
Anmerkungen – trotzdem freigeben?“, with „In der Prüfansicht öffnen“ beside it
(`openMarks`, handed down from `file-preview-pane.tsx` through
`DocumentFassungen`). It informs and never blocks: approving with open points
is the reviewer's call, approving without knowing about them is the mistake.
Only where the pane has a review (a PDF that is not held). A count the review
has not read yet says „Offene Anmerkungen werden noch gelesen …“, and one it
could not read says so and links to the review (`OpenMarksAtApproval`): an
unknown count never reads as none. A known zero says nothing.

## Live

Each document has a room. In it, people see each other's presence, named
cursors (spring-interpolated, about 80 ms apart) and viewports (followable),
the way a design tool shows its collaborators:

| What | How it shows | Where |
|---|---|---|
| A colleague's pointer | the arrow in their colour, their name on a tag; after 8 s at rest it quiets and the tag folds down to a dot with their initial (`CURSOR_IDLE_MS`, one timer per pointer). Under the open card, never over it. In the file preview, the arrow alone: no tag, no chat, no name on a mark or a box being drawn | `review-page-layer.tsx`, `components/ui/live-cursor.tsx` |
| Cursor chat | „/" opens a field at the reader's pointer, the toolbar's button centred above the toolbars, always inside the canvas; every key shows beside it for the room as typed; Enter keeps the line 4 s, Esc takes it away. A colleague's chat keeps their name above the words. Nothing is stored | `cursor-chat.tsx` |
| The mark a colleague has open | a ring round the pin (an outline round a region) in their colour, with their first name at its top-right; „Anna +1" for several; a person whose own pointer is within 48 px of the mark is not named twice (`selectionTagged`); never the reader's own tabs, never Piloti | `peerSelections`, `PeerSelection` |
| A box being dragged out | dashed in their colour, with their first name over its top-right corner; beside the box when the box is narrower than the name, so the name never lies over a pin next to it (`draftTagPlace`) | `review-page-layer.tsx` |
| A colleague out of view | a chip at the edge that leads to them („Lena · Seite 2"), decided by whether their point is on screen (`peerSide`); a click jumps there; the face's tooltip names the page | `Elsewhere` in `document-review.tsx` |
| Piloti | its own pointer, always led by its name („Piloti · Fluchtweg · für Anna"), quieting once it is parked with nothing in hand (`pilotiResting`); the box it reads glows while it reads it (`canvas__look` sends the `look` op: presence and a `reading` activity) | `PilotiCursor`, `tools/canvas/presence.py` `show_reading` |

A write sends an `annotations.changed` hint. A hint is a nudge to re-read, never
the state itself, so a dropped hint costs a few seconds, not a wrong list. The
tab that wrote ignores its own hint. The others read again only the marks the
hint names, each through `GET …/annotations/{id}` (a 404 takes it off the
list); a burst naming more than eight reads the list once. Only the latest read
of a mark lands: an older answer cannot bring back a mark a newer one found
gone, a list read asked since outranks it, and nothing lands once the pane
shows another document. The whole list is
read again when the room returns after a drop and when the tab returns to view.

**What a pointer re-renders.** The roster is an external store
(`useChannel`'s `roster`, read through `useSyncExternalStore`), and a peer that
did not change keeps its object. Nothing that holds the review (the file
preview, the review itself, its list) reads the roster in render: the faces and
the header read who is here by membership and page (`useRoomCompany`), each
page's company layer reads the peers on its page (`usePeersOnPage`), and the
marks are a memoised layer of their own. A pointer moving redraws its pointer.
Piloti's highlights are kept once per room (`createHighlightTracker`), not per
page drawn.

Everything a colleague's colour carries white words on (`identityInk`) is dark
enough for 4.5:1 on every hue of the ring, and the words on it are solid white.

The transport is the shared realtime channel layer; see ADR 0110 for why it is
our own thin layer over Dragonfly rather than a library.

What a tab sends is bounded per person and per document (`lib/realtime/send.ts`),
from two budgets in `lib/limits/rules.js`. Motion, the pointer and the scroll,
spends `ROOM_LIMIT`; a claim, presence and the selected mark, spends
`ROOM_CLAIM_LIMIT`. A burst of motion can therefore never refuse the presence
refresh that keeps a person in everyone's roster. When the server refuses motion
(429), the tab pauses its pointer and scroll for that document for the
`Retry-After` and keeps its claims going (`features/realtime/connection.ts`).
Only the `gone` a tab says on leaving goes out as `keepalive`. Once a tab has
left the room it sends nothing more under its peer, so a late send from a timer
(the cursor chat's linger) cannot put it back in the roster as a ghost
(`features/realtime/use-channel.ts`).

## Piloti on the canvas

Piloti reaches marks in two ways.

**By tool.** The `canvas` function group (`src/aiq_agent/tools/canvas/`) calls
`/api/internal/document-annotations`: `canvas__marks` (`list`), `canvas__mark`
(`propose`, or `create` with `open=true`), `canvas__update` (`update`),
`canvas__delete` (`delete`), `canvas__reply` (`reply`), `canvas__room`
(`room`), and the gestures `canvas__point` and `canvas__highlight`;
`canvas__look` renders the page or a box on it through `view_knowledge_image`'s
own body. The turn sends `leave` when it ends, so Piloti's cursor goes with it.

- A tool may name a document (`document`: a file name from the turn's inventory, or an id); the name is resolved against the inventory and its id read from `GET /api/internal/document-file` with the envelope echoed. Without one it acts on the document open on the canvas (`focus_document_id`), then on the conversation's *subject*. The server checks a named document against the asker's access and the turn's signed scope (`lib/annotations/agent.ts`).
- With no document named and no subject, the tool gets a typed 422 and asks which document is meant.
- A reply, a proposal, a highlight and a labelled pointer are seen by everyone who opens the document, so a conversation that drew on a restricted folder or another project may write none of them (`tools/canvas/policy.py`).
- A held upload reaches no model.
- A subject in a restricted folder is admitted against the conversation first.

### What the person asks for, Piloti does as they could

The product decision: there is no difference between what Piloti does and what
a person does, with light reporting. When the person ASKS, Piloti may do on a
document's Anmerkungen everything that person may do, under that person's own
rights, because every op runs as the asker's pinned session through the same
service functions the person's own routes use (`lib/annotations/agent.ts`):

| Asked for | Op | Runs | Recorded as |
|---|---|---|---|
| Set a mark | `create` | `setAnnotationsForAsker`: born `open`, `author_kind = piloti` | `created_by` and `accepted_by`/`accepted_at` = the asker |
| Resolve, reopen, dismiss a proposal, take one over, assign, set or clear a date, reword, change the kind | `update` | `updateAnnotationForAsker`, which runs `updateAnnotation` with `actor = PILOTI`, then posts `note` as Piloti's reply | `closed_by` / `accepted_by` = the asker |
| Delete a mark | `delete` | `deleteAnnotation`, which allows only a mark the asker set themselves | nothing left |

Findings Piloti makes on its own initiative, including a whole-document review
the person did not itemise, stay proposals (`propose`). The tool descriptions
say when to use which: `open=true` only when the person asked for exactly that
mark; `update` only when they asked for that change to that mark; `delete`
only on explicit request.

**Only where the office switched it on.** Acting is the organization's choice:
the WorkOS flag `piloti-acts`, an entitlement off by default, so a pilot office
starts with Piloti proposing only. With it off, `runAgentAnnotationRequest`
refuses `create`, `update` and `delete` before reading or writing anything, a
403 with code `PILOTI_ACTS_OFF` and `details.reason` `piloti-acts-off`; the
canvas tools turn it into a sentence (`tools/canvas/calls.py`): a mark the
person asked for is proposed instead (`canvas__mark` without `open`), and a
change or a deletion is left to the person, in the document. Reads, the room,
pointing, highlighting, replies and proposals never ask the flag.

The CHECKs of migration 0138 hold on every path, unchanged:

- `only_piloti_proposes`: a born-open mark is not `proposed`; a person's mark never is.
- `acceptance_complete`: `accepted_by` and `accepted_at` are set together, on birth or by `transition()`.
- `piloti_needs_a_person`: Piloti's open or resolved mark carries `accepted_by`, the asker, because the person stood behind it by asking.
- `closing_complete`: closing goes through `transition()`, which sets `closed_by`/`closed_at` to the asker and clears them on reopening.

`frontends/ui/src/app/api/internal/document-annotations/route.spec.ts` runs the
real service over a fake repository and checks every row it leaves against
these predicates; `repository.integration.spec.ts` sets a born-open mark in
real PostgreSQL and finds the CHECK still refusing one with nobody behind it.

**The note.** Every change Piloti makes to an existing mark posts ONE short
reply in that mark's thread, authored as Piloti, from the `note` the model must
give („Erledigt: Die lichte Breite ist im Schnitt B-B mit 1,25 m kotiert.").
The service posts it in the same request as the change, so the two cannot
drift apart: a full thread refuses the change before it lands, a stale
`expectedStatus` is a 409 with no note, and a change that moved nothing posts
nothing. A mark the tool looked up by its number is changed only if its status
is still the one read (`expectedStatus`).

**Who is assigned.** The model never sees a user id, so `update` takes the
`assignee` as the person said it. The BFF resolves it against the
organization's directory among those who can open the document
(`resolveAssignee`): an exact name or address, then a first name or the start
of a name. None or several is a 422 naming the candidates, and the tool turns
it into a question.

**Who it says did it.** Piloti's presence and replies are labelled Piloti. The
person shown as `acceptedBy` or `closedBy` is the asker, which is correct: they
are accountable.

**By a box.** A person draws a box and asks Piloti about it, on the canvas.

1. The canvas opens a conversation whose subject is the document, before the socket opens. The proxy only verifies a conversation that exists at upgrade time.
2. It sends the question with `focus_region` (page and normalized box) on the wire v2 `user_message`.
3. The agent looks at a server-side crop of exactly that box, from `canvas__look` (or `view_knowledge_image`) with `region`. The crop is rendered from the screened Fassung, never from pixels the browser sends.
4. The answer streams into a card beside the box and can be kept as a mark.

A turn that ended is read by its outcome, never its phase alone
(`statusOf` in `use-canvas-ask.ts`): a refusal or a full queue is `declined`
(its words are the reason, never a mark to keep), a commissioned run is
`handedOff` to the chat, a cancel from elsewhere is `stopped`, and an answer
without words says Piloti worked on the document instead. A question whose
server does not read its box or its thread target still goes; the canvas client
says what it went without (`onDegraded`, `canvasDegradations`), the card says
Piloti answered about the whole document, and a thread answer that never
reached the thread is offered there to add by hand. Both fields travel only
while `GRID_WIRE_V2_ADDITIVE_FIELDS` is on, its default: the hello then names
them in `accepts`.

Mentioning Piloti in a thread sends the same turn with `reply_in_thread`. The
prompt tells the model it was asked in that thread, and the model answers there
with `canvas__reply`: nothing is posted on its behalf. The turn runs without
restricted folders in scope, so its own research cannot keep the reply out.
Whether the browser or the server sends that turn is the next section's.

The canvas asks in the person's own thread about the document, `POST
/api/documents/{id}/thread` (`lib/annotations/document-thread.ts`): its id is
uuid5 of the document and the person, created with the document as its subject
on first use, the construction `lib/tasks/task-thread.ts` uses. The canvas, the
chat and a wake of Piloti by the person's reply agree on it without a lookup;
the per-tab id the canvas used to keep in session storage is gone.

### Events wake Piloti (ADR-0106)

People answer Piloti where the work is, often with nobody's chat open. These
events wake it, and only these, by a rule people can read (ADR-0036):

| Event | Wakes Piloti when | Trigger |
|---|---|---|
| A person's reply in a mark's thread | it addresses Piloti (the composer's chip, stored as `addresses_agent`) | `thread_mention` |
| A person's reply in a mark's thread | the mark is Piloti's own `question`, still proposed or open | `thread_reply` |
| A person makes Piloti the delegate on an open mark | always | `assigned` |
| A person takes over or dismisses Piloti's mark | never | |

`lib/annotations/wake.ts` decides; the service enqueues the wake **in the
write's own transaction** (`insertAnnotationReply` / `updateDocumentAnnotation`
take a hook that runs in it), so a reply that rolls back leaves no wake. The
wake's id is uuid5 of the event (`wake-ids.ts`), which is its `piloti_wakes`
row, its `bff_job_queue` job (`piloti_wake`) and the turn id: one event wakes
Piloti at most once.

**Who it runs as.** The person whose act is the event: the replier, or the
person who delegated. The job (`lib/annotations/wake-job.ts`) asks everything
again when it runs, because the queue can hold it: the person's pinned session
of today (`resolvePinnedRequesterSession`), the organization's switch, their
right to write the document, the mark, the caps. It writes the trigger into the
person's thread as a question row („Anna Berger in Anmerkung 4: „…““), resolves
the turn context for that session and thread (`lib/turns/turn-context.ts`,
which refuses a spent budget), and opens the chat socket as an internal caller
with the signed envelope and `X-AIQ-Mode: headless` (`lib/turns/headless-turn.ts`).
The `user_message` carries `trigger`, `if_idle`, the mark's region with its
`annotation_id`, and `reply_in_thread`. The contract:
[`websocket-protocol.md`](../api/websocket-protocol.md#a-turn-an-event-woke-trigger--if_idle).

**What the socket answers.** `RUN_STARTED`: the job records `started` and
detaches, the turn persists itself, and reports how it ended (below). `busy` (another turn of that thread runs):
the job waits without spending an attempt (`notBefore`, 15 s doubling to
5 min, twelve times) and asks again under the same id. `duplicate_turn`: done.
A refusal (admission, the budget): recorded as `refused`. A wrong envelope is
retried by the queue and recorded as `failed` on the last attempt.

**Guards.** Piloti's own replies never wake it. Only a person who may write
the document can reply, so only they can wake it. At most
`GRID_WAKE_MAX_PER_MARK_HOUR` wakes per mark an hour (6) and
`GRID_WAKE_MAX_PER_PERSON_DAY` per person a day (50), counted over the
`piloti_wakes` rows at enqueue and again at claim. The WorkOS flag
`piloti-wakes`, an entitlement off by default. A wake held before Piloti was
asked (a cap, the switch, rights lost, the mark gone, the delegation taken
back) has no trace, so it is on its row and in the audit trail as
`piloti.wake.suppressed`. One that started is `piloti.wake.started` there, and
every end, however it came, is one `piloti.wake.ended`: the turn's, or the
job's when it was refused or gave up before a turn answered, with the class of
its reason (`reasonKind`, the inbox's `variant` below)
(`frontends/ui/src/lib/annotations/wake-audit.ts`).

**With the switch off** the reply answers `wake: 'off'` and the browser asks
Piloti itself, as before, under the turn id a server wake of the same reply
would use (`wakeTurnId(replyId)`), so the two could never both run. With it on
the browser runs nothing, and the thread reads Piloti's work off the server.

**Piloti's work is the server's to say** (`lib/annotations/piloti-work.ts`).
Every mark's view carries `pilotiWork`, read off its newest wake, so everyone
in the room reads the same line, after a reload too:

| Newest wake | `pilotiWork.state` | The thread says |
|---|---|---|
| `queued` | `queued` | „Piloti ist dran · für Anna" |
| `started` | `working` | „Piloti antwortet … · für Anna" (a delegation says it in its chip) |
| `failed`, `refused`, for 6 h after it ended | `failed`, with `reasonKind` | why, by class (`workFailed.<class>`) |
| `suppressed`, for 10 min | `held` | that too many requests held it |
| `answered`, `stopped` | none | the answer is in the thread |

Every transition of a wake (started, ended, held at claim) tells the room
(`announcePilotiWork`), so the line moves without a reload.

### How a woken turn ends

A woken turn has an end (ADR-0106, amended by ADR-0109). When the turn's
terminal is written, the chat socket posts its outcome once to
`POST /api/internal/turns/outcome`
(`frontends/ui/src/app/api/internal/turns/outcome/route.ts`). The BFF maps it to
the wake's final word (`wakeEndOf` in `frontends/ui/src/lib/turns/outcome.ts`):

- `answered` and `handed_off`: the wake is `answered`.
- `stopped` (the turn was cancelled): the wake is `stopped`.
- `refused` and `failed`, and a `RUN_ERROR` (it persists nothing): the wake is
  `failed`, with the reason.

The wake records `ended_at` when it reaches that word. A delegation is handed
back when its own turn ends, whatever the end was, and only while the mark is
still delegated by that delegation (`handBackDelegation`, a compare-and-swap on
`delegated_at`). A person who took the mark back and delegated it again in
between keeps the second delegation. A reply of Piloti's never hands a mark
back.

The outcome is idempotent. A turn that is not a wake (a browser's), a
conversation that is not the wake's thread, and a wake that already ended
settle nothing, and the response says so. A wake still `queued` does end: a
turn that errors at once can report before the job has marked it started.

### Taking a delegation back stops its turn

Taking a mark back from Piloti, or resolving, dismissing or deleting the mark,
is a person's change, and it ends what the delegation started
(`frontends/ui/src/lib/annotations/take-back.ts`, in the change's own
transaction):

- A wake still `queued` is settled `suppressed`, with the reason `taken back`,
  after the commit, so its job never starts a turn. The job checks again before
  it runs, and a delegation taken back or delegated anew since it was queued runs
  no turn.
- A wake that started gets a `piloti_wake_stop` job, queued in the same
  transaction, so a crash after the commit loses no stop. The job
  (`frontends/ui/src/lib/annotations/wake-stop-job.ts`) cancels the turn on the
  chat socket, as the person in the thread. The turn ends `cancelled` and
  reports `stopped` itself, so the job never writes the wake. A turn that is no
  longer running is a stop already done.
- Piloti's own change in the asker's name stops nothing. When the delegation's
  own turn closes the mark, that turn is finishing, not being taken back.

Each wake a take-back (or a delete) stops is one `piloti.wake.stopped` in the
audit trail, as the person who took the mark back.

### The thread always hears back

A turn asked from a thread, whose model did not call `canvas__reply`, posts its
answer into that thread at the end, when the turn ended `answered`
(`src/aiq_agent/turn/annotation_reply.py`, posted by `post_fallback_reply` in
`frontends/aiq_api/src/aiq_api/chat_socket.py`). It does so only when nothing
Piloti did in that thread already spoke there, and only where everyone who
opens the document reads. The reply goes through the route the tool uses, as
the person who asked.

### What the person hears

The inbox hears through `frontends/ui/src/lib/annotations/attention.ts` (ADR-0035).
An item about a mark opens the Prüfansicht at that mark (`markId` in
`frontends/ui/src/lib/sharing/registry.ts`):

| Item | When | For | Actionable |
|---|---|---|---|
| `piloti.work_done` | a woken turn ended `answered` | who mentioned, answered or delegated | no |
| `piloti.work_failed` | a woken turn ended `failed`, or the wake job was refused or gave up before a turn answered (a delegation, a mention or an answer) | who delegated, mentioned or answered | no |
| `piloti.asks_you` | Piloti set a Rückfrage, or replied on its own open one | the mark's Zuständige, else the person its turn acted for | yes |
| `annotation.assigned_to_you` | a person made someone Zuständige of an open mark (setting it, changing it, or taking over Piloti's proposal that names one), or Piloti did for the person its turn acted for | the new Zuständige, unless they did it themselves | yes |
| `annotation.activity` | a person or Piloti replied in the thread | the mark's participants, minus whoever acted | no |
| `annotation.activity` | someone resolved, dismissed or reopened a mark | the mark's author, unless they did it | no |

The author's `annotation.activity` row says `yours: true`: a reply or a move
on a mark they wrote answers them, so it reaches their devices as a result
(`InboxPushPolicy.yours`, on by default, like `mention.answered`), while the
thread's other participants hear it as activity (off by default).

The participants are derived from the mark when something happens, never
stored (`markParticipants`): its author (who set it, or for Piloti's mark who
took it over or asked for it), its Zuständige, who delegated it to Piloti, and
every person who replied. Whoever acted is left out, and for Piloti that is the
person its turn acted for: on a wake, who woke it, who hears `piloti.work_done`
instead. When Piloti follows up its own open Rückfrage, the Zuständige it asks
has the `piloti.asks_you` row and no second one. Every recipient of a
colleague's news must be able to open the document now, its folder included
(`mayOpenDocument`, `frontends/ui/src/lib/documents/may-open.ts`), the same
rule that decides who may be made Zuständige at all. The note Piloti writes
with a change it made for the asker tells nobody: the change told whoever it
concerns, exactly as the asker's own change would.

Each row reads as a colleague's sentence: what Piloti did, to which mark in
which document, and what the reader can do now. The payload carries the
document's name (`subject`), the mark's number (`related`) and, as the excerpt,
what the mark says (Piloti's question for a Rückfrage):

| Item | Title | Body |
|---|---|---|
| `piloti.work_done` | „Piloti hat Anmerkung 4 in „Grundriss EG“ für Sie bearbeitet“ | „Lesen Sie die Antwort im Verlauf der Anmerkung.“ |
| `piloti.work_failed` | „Piloti konnte Anmerkung 4 in „Grundriss EG“ nicht bearbeiten“ | why, and what to do (below) |
| `piloti.asks_you` | „Piloti hat eine Rückfrage an Sie zu Anmerkung 4 in „Grundriss EG““ | „Piloti wartet auf Ihre Antwort. Antworten Sie im Verlauf der Anmerkung.“ |
| `annotation.assigned_to_you` | „Miriam hat Ihnen Anmerkung 4 in „Grundriss EG“ zugewiesen“; variant `piloti`: „Piloti hat Ihnen für Miriam Anmerkung 4 in „Grundriss EG“ zugewiesen“ | „Sie sind dafür zuständig. Antworten Sie im Verlauf oder erledigen Sie die Anmerkung.“ |
| `annotation.activity`, variant `reply` | „Miriam hat zu Anmerkung 4 in „Grundriss EG“ geantwortet“, counted „3 neue Antworten zu Anmerkung 4 in „Grundriss EG“, zuletzt von Miriam“; Piloti's reply „Neue Antwort zu Anmerkung 4 in „Grundriss EG““ | none: the newest reply is the excerpt |
| `annotation.activity`, variants `resolved` / `dismissed` / `reopened` | „Miriam hat Anmerkung 4 in „Grundriss EG“ erledigt“ / „… verworfen“ / „… wieder geöffnet“ | none |

`piloti.work_done` names what woke Piloti as its variant; a delegation's end
(`assigned`) adds „Die Anmerkung liegt wieder bei Ihnen.“ Rows fold per mark
and their payloads merge, so every row names its variant, and a replied-to
mark is one counted row however busy its thread is (`titleRelatedMany` in
`frontends/ui/src/lib/inbox/item-copy.ts`). Piloti's own rows wear its glyph,
drawn as a line like every other row's; a row a person caused wears that
person's face with the type's glyph in its corner.

The row acts on the mark (`anchor: 'mark'` on the type's entry in
`INBOX_TYPE_PRESENTATION`, from which the server's `MARK_ANCHORED_INBOX_TYPES`
is derived). „Zur Anmerkung“ opens the Prüfansicht at it and marks the row read.
On an open `annotation.assigned_to_you` or `piloti.asks_you`, „Antworten“
answers in the thread from the row, and an assigned mark also has „Erledigen“
(`status: 'resolved'`, `expectedStatus: 'open'`, so a mark someone moved
meanwhile is a `409`, not overwritten). Both go through the annotations' own
client (`lib/annotations/client.ts`), the same writes the thread makes, so the
settle rules above apply unchanged.

Opening a mark reads its news. When a mark stays selected in the review for
`MARK_NEWS_SETTLE_MS` (`features/documents/hooks/use-document-review.ts`), the
reader's informational items anchored on it are read through
`POST /api/inbox/read { resourceType: 'document', resourceId, anchorId }`; a
mark stepped past with J/K is not, and one mark is read at most once a minute
from a tab. Requests stay open: seeing a mark is not answering it. A mark
with no news changes nothing, so it nudges no open inbox. A tapped
notification is read too: the service worker posts its item to the same route
before it opens the mark.

A failure says why. `onWakeEnded` classes the wake's stored reason with
`wakeEndReasonKind` (`frontends/ui/src/lib/annotations/wake-end-reason.ts`) and
stores the class as the item's `variant`; the row reads
`pilotiWorkFailed.variants.<class>.body`, never the stored reason, which is
English and meant for the audit trail:

| Class | Stored reasons | The body says |
|---|---|---|
| `budget` | `budget: …`, the agent's „LLM budget is exhausted“ | the usage budget is used up; whoever manages the organization raises it under Organisation → Nutzung & Budgets |
| `busy` | `gave up waiting: …`, the admission and fence refusals („send your message again in a moment“, „answers in progress“, „research jobs waiting“) | Piloti did not get to it in time; ask again later |
| `access` | `rejected: auth_expired`, `rejected: conversation_mismatch`, `auth_error`, `token_expired`, `token_invalid` | Piloti could not sign in on the person's behalf; ask again |
| `error` | anything else, `DEFAULT_FAILURE_REASON` included | the work broke off before there was an answer; ask again, or work on the mark yourself |

A stop makes no item, because the person stopped it; nor does a suppressed wake
(the person's own act, a rule or a cap held it). A wake the job ends without an
answer is told and handed back as a turn's end is (`wake-job.ts`), so a
delegated mark never keeps reading „Piloti arbeitet daran“ after a refusal. A
`piloti.asks_you` is resolved for everyone once any person answers in the
thread, and with `annotation.assigned_to_you` for everyone when the mark is
resolved or dismissed, by a person or by Piloti in their name. A Zuständige
who is replaced, or removed, has their `annotation.assigned_to_you` resolved.
Deleting a mark turns every row anchored on it inert, for everyone: none keeps a
link to it or a quote from it.

A proposal Piloti made (`piloti.proposal_waiting`, `lib/proposals/attention.ts`)
is worded by what it changes, stored as its `variant`: a file operation by its
verb („Piloti schlägt eine Umbenennung vor“), a note („Piloti möchte sich eine
Notiz merken“), a change to the project context. Its excerpt names the files,
the note or the change, and its body says the proposal is in the chat and that
nothing changes until the person applies it.

### Piloti as the delegate

Work is assigned to people and delegated to agents (ADR-0105, the pattern
Linear ships). „An Piloti delegieren“ in the thread's menu (offered while the
switch is on, on an open mark) sets `delegated_by` and `delegated_at` and wakes
Piloti; the mark keeps its assignee, and the thread shows „Piloti arbeitet
daran · für Miriam“. „Von Piloti zurücknehmen“ clears it without a wake, and stops the turn that
works it (below). Piloti hands the mark back when the turn the delegation woke
ends, or when its wake was refused or gave up before a turn answered (a spent
budget, a busy thread), never by a reply of its own, and resolves it only when the person who
delegated asked for that; closing the mark ends the delegation. Piloti cannot
delegate to itself.

The trace carries `turn_surface` and `focus_region_viewed`
([`docs/observability/langfuse.md`](../observability/langfuse.md)).

## In the chat

Whatever Piloti did on a document in a turn comes back as one
`canvas_activity` card ([cards.md](cards.md#current-card-types)): marks
proposed (`proposed`) or set on request (`created`), changes (`changed`, each
field before and after, and the note), deletions (`deleted`) and replies. It
is the way from the chat onto the canvas and back. The card is a window onto
the change record (`piloti_changes`), not a copy of it: its turn's rows are read
when the card is first seen, and again whenever one of its marks changes, so
every reader sees the same state. The card's own copy is only the fallback for
an answer older than the record. Its actions:

1. Each proposed mark carries „Übernehmen" and „Verwerfen". The answer goes
   through the same typed client the canvas uses, and is stored on the message
   per mark. Before a take-over the card reads the mark again: the API lets a
   discarded mark be opened again, so a 409 alone would not stop it reopening
   one a colleague just discarded.
2. „Im Dokument zeigen" puts the document in the peek beside the chat (the
   preview store) and writes `review=1&mark=<id>` onto the chat's own URL with
   `router.replace`. The pane opens the Prüfansicht at that mark and keeps
   the params while it is open (below, „The review's address"). Closing the
   review takes them off, and leaves the document in the peek and the
   conversation where it was. On the chat the link never carries `doc`,
   because there `doc` is the subject of an ask. A copied link
   (`doc=…&review=1&mark=…`) still works: the chat opens that document
   beside it, leaves the composer alone, and drops `doc` once the review has
   closed and taken `review` off. Off the chat the card goes to Dateien with
   all three params.

3. A change carries „Rückgängig“ while the record says it can be undone. The
   card reads its turn's rows from `GET /api/conversations/[id]/messages/[messageId]/changes`,
   and the button calls `POST /api/piloti-changes/[id]/undo`. The undo is a
   compare-and-swap run as the person who clicks, through the annotations
   service's own rules (`frontends/ui/src/lib/changes/service.ts`, the inverse
   in `frontends/ui/src/lib/changes/undo.ts`). It runs only while the mark is
   still as Piloti left it, so a colleague's later move is never undone: the
   answer is `409 moved-on`, and the card says where the mark stands. Undoing a
   change that is already undone answers `409 already-undone` and shows who did
   it. A mark Piloti set open for the asker is taken back by deleting it, which
   the person it was set for may do like their own mark (`mayDeleteMark`), but
   only while nobody but Piloti has written in its thread: deleting the mark
   would delete a colleague's answer with it. A reply Piloti posted for a person
   is deleted the same way, while its text is still what Piloti wrote
   (`deleteReply`). Undoing a mark Piloti proposed dismisses it, and that is
   scored once, as the dismissal. Taking a proposal over or dismissing one has
   no way back, as before.
   A deleted mark is set again from what the change recorded, and resolved again
   if it was; it comes back with a new number and without its thread. An answer
   older than the record keeps its own copy of the
   changes, and undo there still replays that copy after reading the mark again.

   Each decision on Piloti's work also posts one `piloti-decision` score on the
   trace of the turn that produced it (`frontends/ui/src/lib/langfuse/decision-score.ts`;
   the catalogue is in [`langfuse.md`](../observability/langfuse.md)): a proposed
   mark taken over (`accepted`) or dismissed (`dismissed`), and an applied change
   undone (`undone`). The score says what was decided, never by whom; the
   audit trail says who: who undid it (`piloti.change.undone`), and who took
   over or dismissed a proposed mark (`piloti.mark.decided`,
   `frontends/ui/src/lib/annotations/mark-audit.ts`, one per mark, the live
   card's batch included, since it sends the same PATCH per mark).

## The Protokoll: Anmerkungen as a file

A review ends outside the app: as the Protokoll of a Jour fixe, or sent to the
client or a consultant. „Protokoll exportieren" in the Prüfansicht's header
(`features/documents/components/review/review-export-menu.tsx`) downloads one.

`GET /api/documents/[id]/annotations/export?format=pdf|docx|md&scope=open|all&fassung=current|all&includeProposals=1`
(`frontends/ui/src/lib/annotations/export.ts`; the query and the link in
`export-request.ts`, shared by the route and the menu). The defaults are a PDF
of the open marks.

**The Fassung narrows the record, never the work** (`selectMarks`). A mark
still open is in every Protokoll whichever Fassung it was set on, and its entry
names that Fassung: Index C arriving the day before the Jour fixe does not
answer the marks on Index B, and a default that dropped them would drop exactly
the points the meeting is for. `fassung=current` leaves out what was CLOSED on
earlier Fassungen; `fassung=all` takes that in too. So the menu offers the
Fassung only under „Auch erledigte“: with „Nur offene“ it would change
nothing. This was chosen over defaulting the menu to „Alle Fassungen“ whenever
an earlier Fassung has a live mark because it holds on every path (the bare
link, a copied link, any other client of the route) rather than only in the
menu, and it does not pull an earlier Fassung's closed marks into a Protokoll
nobody asked them for. The cover says what is in it: „aktuelle Fassung“ only
while nothing from an earlier one came along, else „alle Fassungen“ (open
only) or „aktuelle Fassung, dazu Offenes aus früheren Fassungen“.

**Who may have it.** Whoever may list the marks: the service reads the document
with `getAccessibleDocument(…, 'read')` and the marks through `listAnnotations`,
so a held upload, a document in a folder closed to the reader and another
organization's document are 404, as they are for the Prüfansicht.

**What it says.** A header: the document, „Fassung 3 von 5 · Stand vom …" (the
published version's number among the document's versions, and the day it was
filed), the project, the selection, when and by whom it was exported. Then one
entry per mark, by number: „Nr. 4 · Seite 2 · Mangel · offen", who set it („von
Piloti gesetzt · für Anna" for a mark Piloti set that a person stands behind),
who closed it, the text, Grundlage, Zuständig, Termin, the Fassung it was set on
when that is an earlier one, and the thread (author · date: text, Piloti's
replies as „Piloti · für Anna"). Piloti's proposals that nobody took over are
not the office's: they are left out, or with `includeProposals=1` listed after
the marks under „Vorschläge von Piloti, nicht geprüft". Dates are on the
office's calendar (Europe/Vienna).

**How the three files are made.** The Protokoll is built once as the answer
export's `DocBlock`s and handed to the renderers that already exist: `renderDocx`
(`lib/answer-export/docx.ts`), `BlocksDocument` (`lib/pdf/blocks-to-pdf.tsx`,
with its cover page), and `blocksToMarkdown` in `export.ts`, the only new
writer, which escapes what a person typed so it stays text. No dependency was
added. A PDF whose layout cost passes `MAX_MARKDOWN_PDF_CHARS` is refused (422)
before react-pdf blocks the event loop; Word and Markdown have no such bound.
There is no thumbnail of the marked place: the BFF has no page rasterizer, so
an entry names its page.

**The trail.** Each export is the audit event `document.annotations.exported`
on the document: format, scope, Fassung, whether proposals were included, and
the counts, never a name or a word of the marks. Nothing calls a model, so
nothing is traced to Langfuse.

## Known debts

- The chat-hosted canvas (the review open over the chat) still asks an @Piloti reply in the chat's conversation, under the chat's own message id, when wakes are off; only the standalone canvas uses the reply's turn id.
- The „Geweckt durch“ prompt block names the person the turn runs for. A woken turn has no access token, so the name comes from the signed envelope's `requester`, which the wake job mints from the pinned session (`resolvePerson`; `turn.context.user_info_for`). `author_name` on the message only attributes the turn in the transcript. A woken turn whose person WorkOS cannot name still reads „Eine Person“.
- Which Piloti reply a wake wrote is derived, not stored (`lib/annotations/wake-attribution.ts`): a wake of the same person on the same mark that began before the reply and had not ended before it. The thread shows it as „Geweckt durch …“ under the reply's byline.

- The canvas runs its own small turn client next to the chat's turn driver in `use-websocket-chat.ts`. That driver should become one shared module that both use.
- A box asked about on the canvas is still this tab's: its answer lives in the tab until kept, and a reload loses the card (the conversation keeps the answer). The next step is the primitive the thread now has: an ask as a server-side request on the document (a wake with an `asked` trigger), run headless, its state on the room, the tab attaching to its turn to stream it.
- Over the chat, a canvas question whose server reads no box is not told so (`onDegraded` is the stand-alone canvas client's).
- The Python side posts to internal routes through several near-identical helpers.
- A change Piloti makes and its note are two writes in one request, not one transaction (`updateAnnotationForAsker`). Every refusal the service can foresee (rights, a stale status, a full thread) comes before the change; a database failure between the two writes would still leave the change without its note.
- The change record is a third write, after the annotations service has committed the change and its note (`recordPilotiChanges`, `frontends/ui/src/lib/changes/service.ts`). The service offers no hook into its transaction, and a failed record is logged, not thrown: the change then lands without a row, so the card cannot undo it from the record.
