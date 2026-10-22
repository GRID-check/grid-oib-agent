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

Migration `0150_annotation_mentions.sql` adds whom a text mentions (below,
„Mentioning a colleague“):

| Where | Holds | CHECK |
|---|---|---|
| `document_annotations.mentions`, `document_annotation_replies.mentions` | whom the mark's text or the reply mentions, as the server kept them: the chat's mention shape, `[{targetId, display}]` | an array of at most ten (`MAX_MENTIONS_PER_MESSAGE`; `…_mentions_bounded`); default `[]` |

Migration `0151_annotation_carry_and_due.sql` adds what a mark carried on to
another document keeps, and an index over the rows the daily Frist reminder ranges over (below,
„A mark goes on with a new Fassung“ and „The daily Frist reminder“):

| Where | Holds | CHECK |
|---|---|---|
| `document_annotations.carried_from_id` | the mark of the replaced document this one was carried on from; `ON DELETE SET NULL` | never the mark itself (`…_carried_from_other`); unique where set (`uniq_document_annotations_carried_from`): one source is carried once, whatever raced |
| `idx_document_annotations_due` | open marks with a Zuständige and a date, by the date (partial) | |

Migration `0152_annotation_reply_edits.sql` adds when a reply was reworded
(below, „A reply its author takes back or rewords“):

| Where | Holds | CHECK |
|---|---|---|
| `document_annotation_replies.edited_at` | when its author last changed its text, by the database's clock (`now()` in the edit's UPDATE); null for one never changed | never before `created_at` (`…_edited_after_created`) |

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
by-name reads alike) carries `marks: { open, proposed, forYou }`: how many of
the document's marks are open, how many are Piloti's proposals nobody decided
on (both live, `isLive`, on every Fassung, and counted apart: „offen“ means the
office's own open marks wherever it is said, as Offene Punkte, the Protokoll
and the Postfach say it), and how many of the open ones have the reader as
Zuständige (`isForReader`, `lib/annotations/types.ts`: the review's „Für Sie“
filter is the same predicate, so its Offen count is this number), or `null`
when none is live. `tallyLiveMarks`
(`lib/annotations/repository.ts`) counts a whole page in ONE grouped query,
bounded by the page's ids, that joins `documents` behind the listing's own
`documentVisibleTo(reader)`. A proposal that names the reader is not theirs
yet: only the person who takes it over makes it so. The count comes with the
listing and is as fresh as its last read; it is not live, with one exception:
the document open in the preview. Once the pane's review has read the marks,
and whenever the reader's work there changes them, the pane hands its tally
to the row (`onMarksChanged` in `PreviewHandlers`,
`hooks/use-preview-channel.ts`, which Dateien answers with `patchFile(id, {
marks })`, and the preview host patches the open file too): the review's
`counts`, with `forYou` the review's own „Für Sie“ count (`tabCounts`), and
`null` when nothing is live, as the server sends it. Only a tally the row
does not already hold is sent, so a reader who resolves all five marks and
closes the review sees no „5 offen“ left behind. The review's `load` reads
`loading`, never `ready`, until the list of the document it is now for has
answered (`listedFor` in `use-document-review.ts`): a pane reused for
another document otherwise counted the last one's marks under the new id for
one render. Dateien draws it as
`OpenMarksChip` (`features/documents/components/open-marks-chip.tsx`), the
kit's `Chip`, beside the name in the list and on a card's footer, on its own
line under the size and the date (never in their place). It says it in words,
„4 offen · 2 für Sie · 12 Vorschläge“ (`openMarksShortLabel`, each part only
when it has any), not as bare numbers; the kit's `Tooltip` and the button's
name carry the whole sentence, „4 offene Anmerkungen, 2 für Sie und 12
Vorschläge von Piloti“ (`openMarksLabel`, the name adding „in „Grundriss
EG““). The review says the same in its header and the rail's count
(„2 offen · 12 Vorschläge“), its Offen tab counts the open marks and adds the
proposals it lists under them („Offen 2 · 12 Vorschläge“, `tabCounts`), and the
approve confirm names both (below). On a phone, where the list opens from a
button in the review's header, the button shows the open count and its name
says the whole sentence („Anmerkungen: 2 offene Anmerkungen und 12 Vorschläge
von Piloti“, `review.listOpen` over `openMarksLabel`). A press opens the review: the page's own URL
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
| `project-types.ts`, `project-marks.ts`, `project-repository.ts`, `project-export.ts` | a project's Offene Punkte: the query and the view, the service, the SQL, and the Protokoll (below) |

Routes:

| Route | Methods |
|---|---|
| `/api/documents/[id]/annotations` | GET, POST |
| `/[annotationId]` | GET (one mark as the caller sees it: what a room hint names), PATCH, DELETE |
| `/[annotationId]/replies` | POST |
| `/[annotationId]/replies/[replyId]` | PATCH (its author rewords it: `{body, mentions?}`, answers `{annotation}`), DELETE (its author takes it back, 204) |
| `/api/documents/[id]/thread` | POST: the caller's own thread about the document (below) |
| `/api/projects/[id]/annotations` | GET: a project's Offene Punkte, the live marks of all its documents (below, „Offene Punkte“) |
| `/api/projects/[id]/annotations/export` | GET: their Protokoll |

A mark's create (POST), a PATCH that carries a `body`, and a reply take
`mentions`: whom the person picked in the composer's „@“ picker, as
`[{targetId, display}]` (a user id, or `agent:piloti`). A PATCH sends them only
with a `body` (400 otherwise). Every view carries the `mentions` the server
kept, on the mark and on each reply. See „Mentioning a colleague“ below.

A PATCH with `carryToCurrent: true` (and nothing but `expectedStatus` beside
it, 400 otherwise) carries an open mark to the document's current Fassung
(below, „A mark goes on with a new Fassung“): a closed or proposed mark is 422
`not-open`, a mark Piloti works on another document's behalf 422 `delegated`,
and a colleague's move first, or a second carry, 409. It answers the mark as it
now stands, which for a mark of a replaced document is the linked mark on the
replacing one (its `documentId` says which). Every view carries `carriedFrom`
and `carriedTo`: the other end of a carry, `{annotationId, documentId, number,
documentName}`, or null, named only to a reader who may open that document
(`linkedDocuments`, through `getAccessibleDocument`).

The list answers `pilotiWakes`, whether the organization lets events wake
Piloti. A reply answers `{annotation, replyId, wake}` and a PATCH that
delegates `{annotation, wake}`, where `wake` is `none` (no rule met), `off`
(the switch is off), `queued` (the server wakes Piloti) or `suppressed` (a cap
held it).

The UI and Piloti are equal clients of one service (ADR-0055).

**What PostHog counts.** Because every client passes the service, the product
events about marks are sent there and nowhere else: `annotation_created`
(who set it, person or Piloti, its kind, open or proposed), `annotation_closed`
(resolved or dismissed, by whom, whose mark, from which status) and
`annotation_carried` (in place or across). Kinds and statuses only, never a
word of a mark or a name ([`posthog-events.md`](../observability/posthog-events.md)).

**Who may do what.** Every right is a permission on the document, asked through
the shelf's rule (`getAccessibleDocument` for the session, and for other people
`mayOpenDocument` / `mayWriteDocument` in `lib/documents/may-open.ts`), never a
role name:

| Who | May |
|---|---|
| whoever may open the document (`project:view` and read in its folder; on the Büroablage every member) | read the marks and their threads, export the Protokoll, be @mentioned and be told |
| whoever may write it (`project:documents:write` or `project:edit`, and write in its folder; on the Büroablage `org:office_shelf:manage`) | set a mark, answer in a thread, take over, dismiss, resolve or reopen, assign, set or clear a date, delegate to Piloti, carry an open mark to the current Fassung (to a replacing document only with the right to write that one too); **be made Zuständige** (`isAssignable`), because the Zuständige answers and closes the mark |
| the author (`createdBy`, a person's own mark) | reword it („Bearbeiten“ in the card's menu; the server lets any writer change a `body`, the card offers it to the author) and delete it (`mayDeleteMark`), while nothing but its author and Piloti stands on it (below) |
| the author of a reply (a person's own, `created_by`), who may still write the document | reword it and delete it, while the mark is live and Piloti has not taken the reply up (below); never a colleague's reply, never Piloti's (a note Piloti posted for them goes by the chat card's undo) |

**What a delete would take with it.** Deleting a mark takes its thread along,
turns every inbox row anchored on it inert, leaves a hole in the numbering a
Protokoll cites, and for a carried mark cuts the link that carries the point
on. So even its author deletes a mark only while nobody but the author and
Piloti has written in its thread, and while it neither went on to another
document nor came from one (`deleteRefusalOf`, `lib/annotations/service.ts`;
the rule undo always kept, below, now kept for every delete). Otherwise
`DELETE` is `409` with `details.reason` `mark-discussed` or `mark-carried`.
The view says it before anyone tries: `canDelete` is false and
`deleteRefused` names why (`discussed`, `carried`) on the author's own mark,
and the card's menu shows „Löschen“ withheld with that reason under it,
with „Stattdessen erledigen“ above it while the mark is open. A resolved mark
stays in the Protokoll's record (`scope=all`); an open one is resolved.

The Zuständige picker reads who may write
(`GET /api/assignments/document/{id}/candidates?access=write`,
`listAssignmentCandidates` with `access: 'write'`), offers the reader
themselves („Mir zuweisen“), and the service checks the pick again on every
write (422 `assignee-cannot-answer`; by name for Piloti, `resolveAssignee`). A
mention asks less: whoever may open the document. A held upload (ADR-0086)
narrows both rows to its uploader and the people who may review its
quarantine, as `findDocumentForSession` does for a session.

## The Prüfansicht

`features/documents/components/review/` holds the canvas. `document-review.tsx`
is the document opened full screen:

- marks drawn on the PDF pages (`review-page-layer.tsx`);
- the open thread beside its mark (`thread-card.tsx`), on the side a whole card fits in pixels, else under the mark (`placeCard`); on a phone in a sheet from the bottom edge. On the sheet a card keeps inside the free stage, the canvas less the toolbars and chips at its foot (`review-stage.ts`): beside its mark it moves up as it grows, under its mark it gets shorter, and past the stage's height its thread scrolls inside it, never the reply field. A new line at the end of the thread (a reply, Piloti at work, its answer) is scrolled into view for a reader at the end or one who just sent into it (`use-follow-end.ts`; a jump under reduced motion);
- the list (`review-panel.tsx`), where Piloti's proposals lead the open marks as a group you can walk through („Durchgehen": the card says „1/3", J or „Weiter" goes on, and taking one over or dismissing it moves to the next);
- the tools, leading the viewer's own pill at the foot; on a touch screen a row of their own above it, each with its name. The first review a browser opens spells every tool out with its key (`TOOLS_INTRO_KEY`), folded after the first mark or by its ×. A tool in hand says what it does next at the top of the canvas.

Everything drawn on the page is in `--paper-ink`, never `--foreground`: the
page stays white in dark mode, and the theme's ink there is paper-white.

Keys:

| Key | Does |
|---|---|
| V / C / R / P | select, point, box, ask Piloti about a box; C, R and P from the keyboard bring the crosshair (below) |
| J / K | step through the marks the list shows that the sheet draws, proposals first: this Fassung's and the ghosts of an earlier one (below), not a closed mark of an earlier Fassung |
| E | take a proposal over, or resolve an open mark; a toast says so with „Rückgängig“ (below) |
| ⌫ / Entf | dismiss a proposal, with the same toast |
| / | cursor chat |
| Esc | backs out one layer at a time (the dialog's own Escape: an open menu or sheet takes its own first) |

**A key's decision waits a moment.** One key is easy to hit by mistake, so E
and ⌫ do not write at once: the card and the list show the move, the toast
(„Anmerkung 4 verworfen · Rückgängig“, `review.decided.*`) offers the way
back, and the PATCH goes when the toast's five seconds are up
(`DECISION_UNDO_MS`), the page is hidden or the review goes, with the status
the mark had (`expectedStatus`). The review's toasts are its own
(`review-toaster.tsx`, `LayerToaster` in `components/ui/sonner.tsx`): mounted
inside the review's dialog, centred at the foot of the canvas above the
viewer's pill, where the cursor chat stops too. The app's toaster, top right
and outside the modal dialog, covered „Protokoll exportieren“, „Piloti prüfen
lassen“ and the list's filter, and its „Rückgängig“ could not be clicked. A
toast raised after the review closed goes to the app's. „Rückgängig“ lets go of it before anything
was sent, so an undone slip leaves no inbox row, no audit event and no
`piloti-decision` score; there is no inverse write, because taking a proposal
over or dismissing it has none. The deferral is the inbox archive's own
(`useUndoableArchive`); `review.decide` and `review.undoDecision` in
`use-document-review.ts` hold the decision. A click on the card's own button
is deliberate and writes at once; a change to a mark whose decision is still
held (a click, a reply's status) lets the decision go and starts from where
the mark really stands. Once its PATCH has gone out, a decision is no longer
held: the card shows it until the answer comes, and a change or „Rückgängig“
meanwhile goes to the server as it is (a status moved under it is the usual
conflict notice). A decision is sent to the document it was taken on, and its
answer is dropped if the pane has moved to another document.

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
A composer that took a control's place, rewording a mark or a reply, gives
the focus back to the ⋯ it was opened from when it is saved or let go
(`useFocusBackOnClose`), never to the page.
A card is a `dialog` named by its header („Mangel #4"); a pin says its state
in words („Vorschlag", „erledigt"), who else has it open, and that it opens a
dialog (`aria-haspopup`; `aria-expanded` in the review, not in the file
preview, where a pin opens the review). A row, in the list or in Offene
Punkte, draws its pin for the eye only and starts with the same words
(`pinLabel`, `mark-row.tsx`): „Anmerkung 4: Mangel · Vorschlag“. The list's filter and a draft's
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

A mark of an earlier Fassung is never drawn as a mark of this sheet. An OPEN one
of this same document is drawn as a **ghost** in the review, under „Offen“:
where it stood on its own Fassung, a hollow pin with a dotted ring (a box
dotted too, `CommentPin`'s `ghost`), under this sheet's own marks, and named
„Anmerkung 4: Mangel · aus Fassung 2“ for a screen reader (`isGhostMark`,
`review-page-layer.tsx`). The reader sees where it would land before carrying
it, rather than carrying it to find out. A mark of a replaced document (Index B
under another name) is never a ghost here: its sheet is another drawing, and its
place may mean nothing on this one. Selected, from its ghost or its row, its
thread opens over the sheet (not beside the ghost, whose place the current
drawing may not have), saying so in its first line, and an open one offers to go
on with the current Fassung (below); the view goes to where its ghost stands. Status moves carry the status the card showed
(`expectedStatus`), so a stale tab gets the conflict notice, never a blind
change. The list is read again when the room returns after a drop and when the
tab returns to view.

`use-document-review.ts` is the state both surfaces share: the inline layer in
the file preview, and the full-screen review. While the review is open the
inline viewer is not mounted at all: one viewer draws the document at a time.
Closing the review opens it again at the page the reader was on in the review.
It knows who reads (`review.me`) from the room's welcome, else from the page
(the shelf's `currentUserId`, passed as `viewerUserId`), else from the
session's user id the app keeps (`useChatStore`'s `currentUserId`), so
„Für Sie“, its counts and „Mir zuweisen“ work while the room is down.

**„Für Sie“** is one predicate on both surfaces (`isForReader`,
`lib/annotations/types.ts`): the marks the reader is Zuständige of, and that are
the office's (Piloti's proposal naming them is not theirs until somebody takes
it over). Who set a mark does not count: a mark set for a colleague is the
colleague's. The list's filter shows those under Offen and Erledigt alike, and
its Offen count is the number Dateien's chip says, „4 offen · 2 für Sie“, which
the server counts in SQL (`tallyLiveMarks`). The words are the chip's, and
`repository.integration.spec.ts` holds the SQL to the predicate on the cases
of `@/test-utils/marks-for-reader`.

**A thread with news.** A pin and its row wear a dot when the reader's
Postfach holds news anchored on the mark they have not read: a reply, the mark
closed, Piloti's finished work (the informational inbox items opening a mark
reads). One bounded read per document through the inbox's typed client
(`unreadMarks`, `GET /api/inbox/unread-anchors`, the same rows
`markAnchorItemsRead` reads), said in words to a screen reader („ungelesen“).
Opening a thread with a dot reads it (`readMarkNews`) and the dot goes; a
thread without one writes nothing, since most marks a reader opens have no
news. The set is read again on the tab's
`inbox.changed` nudge, which goes out once the row is written; the room's hint
goes out before the thread's notification is, so reading on the hint would race
it. News that reaches a thread the reader has open is read as it arrives.
A row about new marks („Anna hat 15 Anmerkungen gesetzt“, below) anchors on
the newest mark only so its link opens there: its news is the document's, so
it puts no dot on that one pin (`listUnreadAnchors` and `markAnchorItemsRead`
leave out rows folded on `MARKS_SET_GROUP_ANCHOR`), and it is read while the
review of the document is open: when it opens, and on each `inbox.changed`
nudge while it stays open, so fifteen marks a colleague sets while the reader
looks at the document are read as they arrive (`watchMarksSetNews` in
`use-document-review.ts`, called by the review's open effect and let go when
it closes; `markMarksSetRead`, `POST /api/inbox/read { resourceType:
'document', resourceId, marksSet: true }`, which narrows
`markResourceItemsRead` to those rows in the types the reader may see). It
cannot loop: a read that finds nothing unread (`affected: 0`) sends no
nudge (`markMarksSetReadFor`).

**The card's own facts.** The Zuständige chip and the date chip each carry a ×
that clears them. The author's own mark has „Bearbeiten“ in the card's menu:
the composer takes the mark's place with its text and whom it mentions
(`initialBody`, `initialMentions`), so a name still standing stays mentioned
and the server tells only whom the new text adds (`newlyMentioned`); Escape or
„Abbrechen“ leaves it unchanged.

**The review's address.** While the review is open the URL says so:
`review=1`, `mark=<id>` for the selected mark and `tool=point|region` for a
tool in hand (`features/documents/lib/open-review.ts` reads and writes them;
the pane keeps them in step). Opening from the pane pushes, so Back closes the
review; a new mark or tool replaces, so walking the marks is one entry; closing
goes back, or takes them off when the review came in by a link. A link from
another page of the app (an Offene Punkte row, a Postfach row) carries `back`,
that page's own address with its filters (`reviewFilesHref(…, { back })`,
`withReviewBack`), and closing a review the pane did not push goes there, so the
reader lands where they left rather than in Dateien. When that page, query
and all, is the entry one step back in this tab, closing is `router.back()`: a
replace left the Postfach in history twice, and its sheet, whose close is Back,
came back after the first. The tab's history answers that, not the return
trail: `backLandsOn` in `lib/navigation/history-step.ts` reads the entry before
`navigation.currentEntry` off the Navigation API, which sees each
`replaceState`, and compares path and query with `back` (parameters in any
order, the hash aside). The trail keeps paths only and cuts itself back on a
revisit, so a Postfach row in the project the reader came from looked like
Dateien behind, and a review reached by „Übernommen aus …“ looked like the
Postfach behind when the first review was. Otherwise (a new tab, a shared link,
a browser without the API) the entry is replaced with `back`. A link from one
review to another („Übernommen aus …“, „Weiter in …“) replaces its entry
too, as walking the marks does, so the review it opens has the page the first
was reached from right behind it and closes there in one step. `back` is
only ever a path of this app (`appReturnPath`, `lib/utils/same-origin-path.ts`:
no scheme, no other origin, no `//`, no backslash or control character, under
`/app/`); anything else is dropped as if it were absent. A reload stays
in the review, and the Files reconciler (`use-preview-channel.ts`) drops them
when a different document opens. A mark's „Link kopieren“ is the mark's own
address, not this tab's: the document on its shelf at the review (the pop-out
link, `reviewFilesHref`), else this page, with `clearReviewParams` first and
then `doc`, `review` and `mark`, so neither the tool in hand nor `back` (the
page this reader came from) goes to whoever opens it. The pane writes the address only where the URL
names its document (Dateien's `doc`, or the chat's peek).

**Ways in from the file preview.** The header's „Prüfansicht öffnen" (a PDF
that carries marks opens full screen as the review, not as the enlarged
viewer, which images keep); „Anmerken" in the viewer's pill and at the phone
reader's thumb, which opens the review with the point tool armed (`tool=point`,
`initialTool`); the rail's „Anmerken und prüfen" and „Dazukommen"; and a pin's
hover card („In der Prüfansicht öffnen", `inline-mark-peek.tsx`, a hovering
pointer only: a tap on a pin opens the review as before). The pane header shows
who is in the document with the review's own `Presence`, without following.

### A reply its author takes back or rewords

A reply in a thread can be wrong: a typo, a wrong name after „@“, an answer
on the wrong mark. Its author has „Bearbeiten“ and „Löschen“ in the reply's
own menu (`ReplyEntry` in `thread-card.tsx`): the composer takes the reply's
place with its words and whom it mentions, as a mark is reworded, and a delete
is confirmed, as a mark's is (`ConfirmDialog`). An edited reply says
„bearbeitet“ beside its time (`editedAt`). Both go through
`PATCH`/`DELETE …/replies/{replyId}` (`editReply` and `deleteOwnReply` in
`lib/annotations/service.ts`, the typed client's `editReply` and
`deleteReply`), and tell the room, which re-reads.

The server refuses, and the menu is not offered:

- anyone's reply but one's own person reply (403): a colleague's words stay
  theirs, and a note Piloti posted for the person goes by the chat card's undo
  (`deleteReply`, a compare-and-swap on what Piloti wrote);
- a reply on a closed mark (422, `details.reason` `mark-closed`): a resolved or
  dismissed mark's thread is the record;
- a reply Piloti has taken up (409, `piloti-took-it-up`): it was for Piloti
  (its @Piloti, or an answer on Piloti's own Rückfrage) and Piloti wrote in the
  thread after it, or its wake (`wakeTurnId(replyId)`, enqueued in the reply's
  own transaction) is queued, running, answered or stopped. A wake a cap held,
  or one refused or failed before it answered, took nothing up. With wakes off
  the browser asked Piloti itself, and only Piloti's answer in the thread says
  so: the server lets a delete through in the moment between the ask and the
  answer, and Piloti answers a reply that is gone. The card reads the same
  facts (`pilotiRepliedSince`, `pilotiWork` for the reply's author) to keep
  from offering what the server would refuse, and withholds the change too
  while this tab's own ask of Piloti in that thread is thinking
  (`pilotiAskingIn`), which leaves that moment to another tab only. The
  refusal says so in the card, not as a colleague's move.

The write is a compare-and-swap on the words the service read
(`updateAnnotationReply`, `deleteAnnotationReply` with the body), so an edit
or a delete that raced another is a 409.

**An edit never wakes Piloti.** The wake was the posting's event, decided once
(`replyTrigger`), and whether the reply addressed Piloti (`addresses_agent`)
stays what it was. So an @Piloti is kept only when the reply already had one;
one added in an edit is not stored and stays plain text. The edit's composer
offers no @Piloti, and where Piloti could be asked it says that an edited reply
does not reach Piloti and to ask in a new reply.

**What an edit tells, and a delete takes back.** An edit keeps whom it mentions
as a new text does (`keepMentions`): the people it adds are told
(`annotation.mentioned`, quoting the new words), and the people it drops whom
nothing else on the mark names have their row turn inert
(`onMentionsWithdrawn`). The thread hears nothing new: an edit is not a reply.
Every row that still quotes the reply, found by the `replyId` a reply's rows
carry, quotes the new words and whom they mention, in place
(`onReplyEdited`, `rewriteItemPayloadsAnchoredOn`): no row resurfaces, since
nothing new happened. A delete takes back what the reply told, and only that
(`onReplyDeleted`): the mention of whoever nothing left on the mark names goes
inert, and every other `annotation.activity` and `annotation.mentioned` row
still quoting it counts one less and quotes nothing
(`retractOccurrenceAnchoredOn`), again without resurfacing. So Ben, whom
Anna's mark asks, keeps his request when Carl deletes the reply that named him
again, and a folded „2 neue Antworten“ row whose newest reply Dana deleted
still holds Carl's. A thread row that counted only the deleted reply goes
inert: its news is gone. A later reply or move writing over a row names its
own reply, or none, so that row is not touched. A `piloti.asks_you` the reply
settled stays settled.

### A mark goes on with a new Fassung

A mark is set on one Fassung, because a position is true of the sheet somebody
looked at. When the document gets a new Fassung, its open marks stay open and
are listed and drawn only as ghosts (above), and the people working on them are told how many to
check (`document.new_revision`, [`revisions.md`](revisions.md#notifications)).
A mark that still holds goes on with the new Fassung: „Auf aktuelle Fassung
übernehmen“ in its card's first line, for whoever may edit an open mark
(`carryToCurrent`, `lib/annotations/service.ts`). It keeps its place on the
page: a position never changes under someone who read it, so a mark that no
longer fits is resolved and set again instead.

- **Under the same name** the mark moves in place: `version_id` becomes the
  published version's, compared and swapped against the Fassung the mark was
  read on and its status (`revision` in `updateDocumentAnnotation`), so two
  people carrying it at once move it once. Its number, its thread, and every
  inbox row, wake and change record anchored on it stay whole, and it is drawn
  again. Nobody is told: the new Fassung already told them, and the room
  re-reads. The list's „Offen aus früheren Fassungen: 4 · Alle übernehmen“
  carries each the same way, one PATCH per mark, four at a time
  (`CARRY_AT_ONCE`, `inPool`); a mark moved in place takes its PATCH's
  answer, and nothing is read again.
- **Under another name** (Index B confirmed as replaced by Index C, `supersededBy`
  in `lib/documents/revision-links.ts`; through a chain, its end, read only through
  documents the carrier may open, `lib/annotations/carry.ts`: a link the shelf
  shows into a document the carrier cannot open, a closed folder, ends the walk
  at the last one they can) the mark cannot
  move. B's number is what a Protokoll and a Jour fixe named; its thread is
  anchored on B in every inbox row (`resourceId` and the group key both name B),
  wake and change record that points at it; and C has numbers of its own.
  Moving the row (a new `document_id`) would cut all of that, or need every one
  of those rows rewritten. So C receives a **linked mark** instead: set on C's
  current Fassung with B's place, text, kind, Grundlage, author, Zuständige (while
  they may still answer on C) and date, numbered on C, `carried_from_id`
  pointing back; and B's mark is closed (`resolved`, by the carrier) in the same
  transaction (`carryAnnotationToDocument`), compared and swapped on `open` and
  on `delegated_by` being null, so a delegation that lands between the
  service's read and the close makes the carry a conflict (409), like a
  colleague's close. B's thread stays readable where
  every link expects it; C's card says „Übernommen aus „B“, Anmerkung 4“ and
  B's „Weiter in „C“ als Anmerkung 7“, each a link to the other review where
  the page addresses documents by `?doc=` (Dateien, the Büroablage; over the
  chat the name stands without a link, `features/documents/lib/revision-links.ts`).
  Closing B's mark settles what it asked of people; its Zuständige is asked
  again on C's mark (`annotation.assigned_to_you`), unless they carried it
  themselves. A mark Piloti works is taken back first: its running turn writes
  on B.

What the review offers is what the server would do. Each mark of a list or a
write's answer carries `carryTarget`: the document this reader's carry lands
on, named as they see it, or null where the carry would be refused or do
nothing (`carryWayOf` and `carryTargetOf`, `lib/annotations/service.ts`): a
mark that is not open, a reader who may not write its document, a mark on the
current Fassung of a document nothing replaces; across, a replacing document
the reader may not write, and a mark Piloti works. The target is the end of the
chain the carry walks (`replacingDocumentOf`), so when C was replaced by D in
turn, B's card names D, not the direct successor its notice names. A list read
whose chain cannot be read offers no carry rather than failing.

The review shows both sides. C's review lists B's open marks read-only under
„Aus Fassung „B““ (the hook reads B's list through the same typed client,
`useDocumentReview`'s `carried`, the direct predecessors from the file's
`revision` facts, at most three), each with „Auf aktuelle Fassung übernehmen“
where it has a `carryTarget` (labelled for a screen reader with its number,
„Anmerkung 4 auf aktuelle Fassung übernehmen“), „Alle übernehmen“ for several
(the same PATCHes, four at a time, and this list and B's read ONCE after the
last, not after each: thirty marks are thirty PATCHes and two reads; a mark
that did not go leaves „Nicht alle Anmerkungen konnten übernommen werden“),
and „Fassungen vergleichen“, the comparison the inbox row opens
(`compareRevisionHref`). A list of B that could not be read stays as its group,
saying so, with „Erneut versuchen“ (`retryCarried`). In B's review an open
mark's card says „Dieses Dokument ist durch „C“ ersetzt.“ and offers
„In „D“ übernehmen“, D being its `carryTarget`. The header says
„Ersetzt durch „C““ or „Ersetzt „B““ beside the Fassung.

**Piloti prüfen lassen, was behoben ist.** Under both groups (the earlier
Fassungen' bar and „Aus Fassung „B““) the review offers to have Piloti check
which of those open marks look fixed now (`review/check-fixed.ts`,
`useCheckFixed`). It is the review's own whole-document ask, the one the
header's „Piloti prüfen lassen“ runs (`review.piloti.ask` with no region,
`use-canvas-ask.ts`), with the question written for that group: the marks by
number, the Fassung they are checked against („Fassung 3“, or for B's marks C's
name), and how to answer. One turn for the group, in the person's thread about
the document (or the chat's conversation over the chat), so it streams into the
header line, is one turn at a time with every other ask, and can be stopped. The
ask carries `checkFixed` (`{documentId, annotationIds}`), which the header reads
to say „Piloti prüft, was behoben ist …“ / „Piloti hat in den Verläufen
geantwortet“ instead of counting proposals, and the group to say it is running.
Not the wake path: nothing happened on a mark that a rule could name, and a wake
per mark would be N turns, each spending the per-mark and per-person caps, for
one question.

Piloti answers in each mark's thread with `canvas__reply`, „In Fassung 3
behoben: …“ or „Weiterhin offen: …“, naming B for B's marks (`document`, a file
name from the turn's inventory). It changes no status: the question says so,
and the `canvas` tools' descriptions hold it on every path, `piloti-acts` on or
off (`update`: a request to check what is fixed asks for no change; `reply`: the
verdict's form, and no status change; `tests/aiq_agent/tools/canvas/test_parity.py`).
Closing stays the person's: „Erledigt“ in the mark's thread, or for B's marks
„Erledigen“ on the row in C's review (`resolveCarried`, a PATCH to B's mark
with the status the row showed). B's threads are in B's room, which C's review
does not hear, so the group is read again when the check's turn ends, and each
row shows Piloti's newest answer when it is Piloti's. Only on request: an upload
never starts it. Observable as any canvas ask: the turn's trace, with one
`canvas__reply` observation (and its `canvas.reply` step) per mark; the question
is the trace's input. No model call is added.

A carry is a person's edit of a mark, content activity like every other, so it
is not in the admin audit trail
([`workos-provisioning.md`](../deployment/workos-provisioning.md#5-audit-logs-native-workos-product));
the room hears it, and a carried mark names its source on the mark itself.

### Mentioning a colleague

The draft card and a thread's reply box are the chat's composer for mentions,
gesture for gesture (`review/composer.tsx`): „@“ opens the chat's own picker
(`MentionPicker`), a pick writes „@Anna Berger“ into the text and records whom
it means (`features/collaboration/lib/mention-text.ts`), and what is sent is
reconciled against the text at the last moment, so a name deleted while
editing mentions nobody and a name typed by hand never did. The rows are the
people who may open the document, read from the assignment candidates
(`GET /api/assignments/document/{id}/candidates`, `listAssignmentCandidates`,
`mayOpenDocument`; the Zuständige picker asks the narrower `access=write`
list), under „Können das Dokument öffnen“; a reply also offers
Piloti, and its spark writes the @Piloti mention too. A draft does not: setting
a mark wakes nobody. A query that finds nobody says that only people who may
open the document can be mentioned. The picker ranks what it finds
(`filterMentionCandidates`): a name part that starts with the query, then a
name that contains it, then a person found only by their e-mail address; the
server's order stands among equals. Every new letter puts the selection back
on the best match, so Enter after „@Le“ mentions Lena, not Anna whose address
reads `…@lehner-architekten.at`. The chat's composer ranks alike: it is the
same picker.

The server keeps a mention only while its token stands in the text, the name is
the directory's, and the person may open the document
(`lib/annotations/mentions.ts`); Piloti by its product name, and only in a
reply, never in a mark's own text. Where the organization has collaboration
off (the gate the candidates route and the chat keep), a text mentions nobody
but Piloti. A dropped mention
is not stored, so its „@Name“ stays plain text, and the composer, comparing
what it sent with what came back, says whom it did not tell, without a reason
it cannot know („Anna Berger wurde nicht benachrichtigt.“). It says the chat's
words for a spent mention budget, and the bound before sending more than ten
names. A list of people that failed to load says so in the picker, never as
„nobody“, and the next „@“ asks again. A pick whose name was taken out of the
text is dropped as the text changes, and when two picks share a name the
newest wins (`reconcileMentions`), so a namesake taken back is never told. A
reply that
mentions Piloti addresses it, as `addressesPiloti` does; an edit of a reply
keeps an @Piloti only where it stood, and wakes nobody (above). Mentions spend the
chat's one budget (`enforceMentionBounds`, `MENTION_LIMIT`), @Piloti counted
like a person as in the chat, before anything is written. A write that closes
the mark tells nobody it mentions.

A mention renders as the chat's chip (`MentionText`, through
`review/mark-body.tsx`; in the reader's Postfach too, below): the name, never the id, louder when it is the reader
(the review's `me`, below: the room's word for this tab, else the page's,
else the signed-in person the chat knows). In a line clamp (the list, the peek, the summary) the
text runs as one paragraph; the thread card keeps its line breaks.
The thread card, the list, the inline peek and the summary draw it alike. Only
a stored mention becomes a chip.

**Before a Freigabe.** The approve confirm in the rail
(`document-review-controls.tsx`, under „Freigabe und Fassungen“) names the
live marks the pane's review holds, before the signature, Piloti's untaken
proposals apart from the open ones as the chip tells them: „2 offene
Anmerkungen und 12 Vorschläge von Piloti – trotzdem freigeben?“, with „In der Prüfansicht öffnen“ beside it
as a link in the sentence (`openMarks`, handed down from `file-preview-pane.tsx`
through `DocumentRevisions`; drawn as `Button variant="inline"`, underlined at
rest, because `link` is ink like the sentence around it and underlines only on
hover). It informs and never blocks: approving with open points
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
| A colleague out of view | a chip at the edge that leads to them („Lena · Seite 2"), decided by whether their point is on screen (`peerSide`); a click jumps there; the face's tooltip names the page. Never over the open card: the card keeps out of the foot, and a row that would still lie over it steps aside (`covers`) | `Elsewhere` in `document-review.tsx` |
| Piloti | its own pointer, always led by its name („Piloti · Fluchtweg · für Anna"), quieting once it is parked with nothing in hand (`pilotiResting`); the box it reads glows while it reads it (`look` sends the `look` op for a workspace document, from the canvas or the chat: presence and a `reading` activity) | `PilotiCursor`, `tools/canvas/presence.py` `show_reading` |

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
(`room`), and the gestures `canvas__point` and `canvas__highlight`.
`look` (`src/aiq_agent/tools/look/`, ADR-0128), a tool of its own bound in every
context, renders the page or a box on it and makes the box glow here. The turn sends `leave` when it ends, so Piloti's cursor goes with it.

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
| Delete a mark | `delete` | `deleteAnnotation`, which allows only a mark the asker set themselves, while nobody else wrote in its thread and it was not carried | nothing left |

Findings Piloti makes on its own initiative, including a whole-document review
the person did not itemise, stay proposals (`propose`). So do the marks of a
notice of a new Fassung (ADR-0130), which a job proposes through this same
function, as the person who made the Fassung, recorded against a message in
their thread about the document (`lib/revision-notice/job.ts`). The tool descriptions
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
organization's directory among those who may write the document, as every
Zuständige must (`resolveAssignee`, `mayWriteDocument`): an exact name or address, then a first name or the start
of a name. None or several is a 422 naming the candidates, and the tool turns
it into a question.

**Who it says did it.** Piloti's presence and replies are labelled Piloti. The
person shown as `acceptedBy` or `closedBy` is the asker, which is correct: they
are accountable.

**By a box.** A person draws a box and asks Piloti about it, on the canvas.

1. The canvas opens a conversation whose subject is the document, before the socket opens. The proxy only verifies a conversation that exists at upgrade time.
2. It sends the question with `focus_region` (page and normalized box) on the wire v2 `user_message`.
3. The agent looks at a server-side crop of exactly that box, from `look` with `region`. The crop is rendered from the screened Fassung, never from pixels the browser sends.
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
| A person's reply in a mark's thread | it addresses Piloti (the composer's @Piloti mention, stored as `addresses_agent`) | `thread_mention` |
| A person's reply in a mark's thread | the mark is Piloti's own `question`, still proposed or open | `thread_reply` |
| A person makes Piloti the delegate on an open mark | always | `assigned` |
| A person takes over or dismisses Piloti's mark | never | |
| A person rewords or deletes their reply | never: the wake was the posting's (above, „A reply its author takes back or rewords“) | |

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

**With the switch off** the reply answers `wake: 'off'`, whichever rule met it
(an @Piloti, or an answer to Piloti's own open Rückfrage with no @Piloti at
all), and the thread card asks Piloti itself on exactly that answer, under the
turn id a server wake of the same reply would use (`wakeTurnId(replyId)`), so
the two could never both run. The server stays the authority: the card asks on
`off` and on nothing else. With it on the browser runs nothing, and the thread
reads Piloti's work off the server. The inbox has no Piloti to ask, so a
Rückfrage answered from there would reach nobody: its row leads to the
Prüfansicht instead (`answerIn: 'review'`, below).

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
| `piloti.revision_checked` | Piloti compared a new Fassung unasked and proposed marks on it ([ADR-0130](../adr/0130-piloti-notices-a-new-fassung.md)); anchored on the first mark | the person whose upload or link made the Fassung | no |
| `annotation.assigned_to_you` | a person made someone Zuständige of an open mark (setting it, changing it, taking over Piloti's proposal that names one, or carrying it on to a replacing document), or Piloti did for the person its turn acted for | the new Zuständige, unless they did it themselves | yes |
| `annotation.assigned_to_you`, variants `due` / `due_cleared` (`…_piloti`) | someone set, moved or cleared the date of an open mark whose Zuständige stays (a date that comes with a new Zuständige is their assignment) | the Zuständige, unless they did it, in the row they have for the mark | yes |
| `annotation.assigned_to_you`, variants `due_soon` / `overdue` | the daily reminder: the Frist is today or tomorrow, or it has passed (below) | the Zuständige, while they may open the document; once per reminder and date, the overdue one upgrading the same row | yes |
| `annotation.mentioned` | a person @mentioned someone in a mark's text (setting it, or a `body` that adds them) or in a reply | each person mentioned anew who may open the document, minus whoever wrote it, minus a Zuständige the same write made responsible (who has `annotation.assigned_to_you`) | yes |
| `annotation.activity` | a person or Piloti replied in the thread | the mark's participants, minus whoever acted, minus whom the reply mentions (one row for one reply: the mention) | no |
| `annotation.activity` | someone resolved, dismissed or reopened a mark | the mark's author, unless they did it | no |
| `annotation.activity`, variants `created` / `created_piloti` | a person set a mark, Piloti set marks for the person who asked for them, or a person took over Piloti's proposal (`onMarksSet`; a proposal nobody took over tells nobody) | the document's people: who is Verantwortlich for it (ADR-0047) and who uploaded it, as for a new Fassung; minus whoever acted (for Piloti, the person who asked or took it over), minus whom a mark already tells in its own row (its Zuständige, whom it mentions, whom Piloti's Rückfrage asks) | no |

The author's `annotation.activity` row says `yours: true`: a reply or a move
on a mark they wrote answers them, so it reaches their devices as a result
(`InboxPushPolicy.yours`, on by default, like `mention.answered`), while the
thread's other participants hear it as activity (off by default). An
`annotation.mentioned` is pushed as the chat's `mention.requested` is
(requests): one rule for one gesture.

**Where it reaches them: the inbox and web push, not mail.** Every item lands
in the Postfach, and reaches the devices a person turned notifications on for
(ADR-0112, by category). The registry also states each type's mail policy
(`annotation.mentioned` and `piloti.asks_you` an hour unread,
`annotation.assigned_to_you` two hours), but no sender exists yet
(`lib/inbox/delivery.ts`, ADR-0035): today nothing about a mark is mailed.
Those policies take effect the day the sender ships.

**Many rows at once are one notification.** A row folds its own occurrences
(twenty replies on one mark are one row and one push). Some news comes as one
row per mark instead: the morning's Frist reminders, „Alle übernehmen“ handing
every mark over again on the replacing document, a person handing out marks
one after another. `annotation.assigned_to_you` therefore folds its pushes per
person across marks (`fold` in its push policy, `lib/push/fold.ts`): every
job of it waits `BURST_HOLD_MS` (5 s), a burst is the person's rows of the
type each within 5 s of the next (a row read meanwhile still links it), and
only the newest row's job sends, one counted notification for the rows still
news that the person may still see: „4 Anmerkungen für Sie“ over „1
überfällig, 3 heute oder morgen fällig“ (`buildFoldedPushMessage`,
`collaboration.inbox.types.annotationAssigned.pushFold`; each variant counted
under a part, `fold.parts` in the registry). That job sends even when its own
row was read before it ran: the rows before it left the telling to it. It
opens the Postfach, which lists them, and names no item; a burst of one is
told in its row's own words. Each burst's notification has its own tag, so a
later burst stands beside it. A row stamped in the milliseconds before the
newest job reads, and committed after, can start a burst of its own that
tells the earlier rows again (`lib/push/fold.ts`). The inbox rows stay one
per mark.

`annotation.activity` folds the same way, so a colleague resolving fifteen of
the reader's marks one after another is one notification, „15 Neuigkeiten zu
Anmerkungen“ over „14 erledigt, 1 verworfen“, not fifteen
(`collaboration.inbox.types.annotationActivity.pushFold`; parts `reply`,
`resolved`, `dismissed`, `reopened`, and `created` for both new-mark variants,
which push as activity to whoever turned that on). Its rows reach a person
under two categories (their own mark's news as results through `yours`, a
thread they only take part in as activity), so a burst counts only the rows
the person's categories push (`readBurst` with `isPushWanted`): a newer row
they get no notification for would otherwise take the telling from the rows
before it, and nobody would tell them.

The participants are derived from the mark when something happens, never
stored as a list (`markParticipants`): its author (who set it, or for Piloti's
mark who took it over or asked for it), its Zuständige, who delegated it to
Piloti, every person who replied, and every person the mark's text or a reply
mentions (being asked into a thread is taking part in it). Whoever acted is left out, and for Piloti that is the
person its turn acted for: on a wake, who woke it, who hears `piloti.work_done`
instead. When Piloti follows up its own open Rückfrage, the Zuständige it asks
has the `piloti.asks_you` row and no second one. Every recipient of a
colleague's news must be able to open the document now, its folder included
(`mayOpenDocument`, `frontends/ui/src/lib/documents/may-open.ts`), the rule
that decides who may be mentioned; who may be made Zuständige must also be
able to write it (`mayWriteDocument`, above). A held upload (ADR-0086) opens
and is written there only for its uploader and the people who may review its
quarantine (`isQuarantineReviewer`), so nobody else is assigned, mentioned or
told about a document they would find missing. The note Piloti writes
with a change it made for the asker tells nobody: the change told whoever it
concerns, exactly as the asker's own change would.

Each row reads as a colleague's sentence: what Piloti did, to which mark in
which document, and what the reader can do now. The payload carries the
document's name (`subject`), the mark's number (`related`) and, as the excerpt,
what the mark says (Piloti's question for a Rückfrage). Beside the excerpt of
an `annotation.mentioned` and of a reply's `annotation.activity` it carries
whom that text mentions (`mentions`, as the server kept them), and the row
draws them as the thread's chips (`MentionText`, the reader's own louder:
`InboxList` takes the reader's id from the page's session). Every excerpt
writes its `mentions`, `[]` where there are none, so a folded row never pairs
one quote with the last one's names. A row written before this, or a chat
mention (the chat keeps no names on the server), quotes plain text:

| Item | Title | Body |
|---|---|---|
| `piloti.work_done` | „Piloti hat Anmerkung 4 in „Grundriss EG“ für Sie bearbeitet“ | „Lesen Sie die Antwort im Verlauf der Anmerkung.“ |
| `piloti.work_failed` | „Piloti konnte Anmerkung 4 in „Grundriss EG“ nicht bearbeiten“ | why, and what to do (below) |
| `piloti.asks_you` | „Piloti hat eine Rückfrage an Sie zu Anmerkung 4 in „Grundriss EG““ | „Piloti wartet auf Ihre Antwort. Antworten Sie im Verlauf der Anmerkung.“; with `answerIn: 'review'` (below) „Antworten Sie in der Prüfansicht. Von dort erreicht Ihre Antwort Piloti.“ (`bodyInReview`) |
| `annotation.assigned_to_you` | „Miriam hat Ihnen Anmerkung 4 in „Grundriss EG“ zugewiesen“; variant `piloti`: „Piloti hat Ihnen für Miriam Anmerkung 4 in „Grundriss EG“ zugewiesen“; `due`: „Miriam hat die Frist von Anmerkung 4 in „Grundriss EG“ auf 24. Okt. 2026 gesetzt“; `due_cleared`: „… die Frist … entfernt“; `due_soon`: „Anmerkung 4 in „Grundriss EG“ ist am 18. Okt. 2026 fällig“; `overdue`: „… war am 15. Okt. 2026 fällig“ | „Sie sind dafür zuständig. Antworten Sie im Verlauf oder erledigen Sie die Anmerkung.“; with a date (`dueOn` in the payload) „Sie sind dafür zuständig, bis 24. Okt. 2026. …“; `overdue` says the Frist has passed and to agree on a new one |
| `annotation.mentioned` | „Miriam hat Sie in Anmerkung 4 in „Grundriss EG“ erwähnt“ | „Antworten Sie im Verlauf der Anmerkung.“; the excerpt is the text that mentions them |
| `annotation.activity`, variant `reply` | „Miriam hat zu Anmerkung 4 in „Grundriss EG“ geantwortet“, counted „3 neue Antworten zu Anmerkung 4 in „Grundriss EG“, zuletzt von Miriam“; Piloti's reply „Neue Antwort zu Anmerkung 4 in „Grundriss EG““ | none: the newest reply is the excerpt |
| `annotation.activity`, variants `resolved` / `dismissed` / `reopened` | „Miriam hat Anmerkung 4 in „Grundriss EG“ erledigt“ / „… verworfen“ / „… wieder geöffnet“ | none |
| `annotation.activity`, variant `created` | „Miriam hat Anmerkung 4 in „Grundriss EG“ gesetzt“, counted „Miriam hat 15 Anmerkungen in „Grundriss EG“ gesetzt“; `created_piloti` „Piloti hat für Miriam …“ (Miriam asked for them, or took Piloti's proposal over); a setter the directory no longer knows „Piloti hat 3 Anmerkungen …“, „Neue Anmerkungen in „Grundriss EG““ (`…NoActor`) | counted: „Die neueste ist Anmerkung 15.“; once the newest was deleted: „Eine der Anmerkungen wurde inzwischen gelöscht.“ (`bodyNoExcerpt`) |

**New marks fold per document and per who set them.** Every other row about
a mark folds on the mark; a new mark's row folds on the document and the
setter (`groupAnchor` `set:<variant>:<actor>` in `inboxGroupKey`,
`MARKS_SET_GROUP_ANCHOR`), anchored on the newest mark it tells about, so a
review of fifteen marks is one counted row whose link opens the review at the
newest. That mark wears no dot for it, and opening the document's review reads
it (above, „A thread with news“). A write of several at once
(Piloti's batch) is ONE emission counting them all (`InboxEmission.occurrences`,
which the upsert adds to the stored count), so it is one row write and one
notification, not fifteen. Deleting the newest of them takes it out of the
row (`onMarkDeleted`): the row counts one less, quotes nothing and no longer
names it (no `related`), so it reads „Miriam hat 14 Anmerkungen in „Grundriss
EG“ gesetzt“ over „Eine der Anmerkungen wurde inzwischen gelöscht.“, and it
goes inert only once it counts none. Which marks a reader's row counts is not
stored, so the row is not re-anchored on the next newest: its link opens the
review with no mark selected, and deleting a mark that is not the row's anchor
leaves its count as it was. Every other row anchored on a deleted mark goes
inert.

Piloti's proposals tell the document's people nothing: a proposal is nobody's
news until a person takes it over. Taking it over (`proposed → open`, or
reopening a dismissed proposal nobody stood behind, the moves that set
`accepted_by`) tells them then, as a mark Piloti set for whoever took it over
(`created_piloti`, folded with the marks Piloti set for them; `traceChange` in
`lib/annotations/service.ts`), less its Zuständige, who hears
`annotation.assigned_to_you`.

`piloti.work_done` names what woke Piloti as its variant; a delegation's end
(`assigned`) adds „Die Anmerkung liegt wieder bei Ihnen.“ Rows fold per mark
and their payloads merge, so every row names its variant, and a replied-to
mark is one counted row however busy its thread is (`titleRelatedMany` in
`frontends/ui/src/lib/inbox/item-copy.ts`). Piloti's own rows wear its glyph,
drawn as a line like every other row's; a row a person caused wears that
person's face with the type's glyph in its corner.

The row acts on the mark (`anchor: 'mark'` on the type's entry in
`INBOX_TYPE_PRESENTATION`, from which the server's `MARK_ANCHORED_INBOX_TYPES`
is derived). „Zur Anmerkung“ opens the Prüfansicht at it and marks the row read;
on a row about several new marks („Anna hat 15 Anmerkungen gesetzt“,
`annotation.activity` with the variant `created` or `created_piloti` and a
count over one) it says „Zu den Anmerkungen“ (`inbox.mark.openMany`). The
link carries the Postfach's own address as `back`, and the Postfach keeps its
filter in that address (`filter=unread|all|archived`, „Für mich“ unwritten,
`InboxList`), so closing the review comes back to the filter the reader left.
The row offers only what the reader can do, and the server says what that is:
every request on a mark (`annotation.assigned_to_you`, `piloti.asks_you`,
`annotation.mentioned`) carries `answerIn` (`InboxItemView`, decided in
`lib/inbox/service.ts` with `canWriteDocument`, once per document on the page):

| `answerIn` | When | The row offers |
|---|---|---|
| `row` | the reader may write the document | „Antworten“, which answers in the thread from the row, and on an assigned mark „Erledigen“ (`status: 'resolved'`, `expectedStatus: 'open'`, so a mark someone moved meanwhile is a `409`, not overwritten). The write waits for the undo window, as archiving a row does (`useUndoableArchive`, `ARCHIVE_UNDO_MS`): the row says „Als erledigt markiert. Rückgängig“ at once, and the PATCH goes when the window ends, the page is hidden or the row goes. „Rückgängig“ inside it lets go and sends nothing, so the request is still open and the list's re-read keeps the row; a write refused when it goes says the row's conflict (409) or failure words. The focus follows: „Rückgängig“ takes it from „Erledigen“, „Erledigen“ takes it back on an undo, and when the window ends with the write, the outcome line (`tabIndex -1`) takes it, since „Erledigen“ is not drawn again (`useFocusBackOnClose`). Under „Für mich“ the re-read after the write drops the row, outcome line and all; the list hands the focus to the row now at its place, or to the list when none is left, without scrolling, so a reader who scrolled on during the window stays where they read (`InboxList`, any row a refresh takes with the focus in it) |
| `review` | Piloti's Rückfrage while events do not wake Piloti (`piloti-wakes` off) | „In der Prüfansicht beantworten“ in place of „Zur Anmerkung“: the thread card asks Piloti with the answer, which a row cannot |
| null | the reader may only read the document (a mention reaches readers too), or the row is no open request | „Zur Anmerkung“ alone |

„Antworten“ opens the thread's own composer (`Composer`, `review/composer.tsx`)
in the row, gesture for gesture: Enter sends, Shift+Enter breaks the line,
Escape lets go, „@“ offers whoever may open the document, and the spark writes
@Piloti where the row says events wake Piloti (`pilotiWakes` on the item,
`answerIn: 'row'` and the `piloti-wakes` switch on: the server answers it, as in
the thread). The reply carries whom it mentions and the @Piloti flag, so a
colleague asked from the Postfach is told as from the thread. Sent, the row
says so and names whom the server did not keep; a failure keeps the words in
the box and says the row's own failure. Sent or let go, the box gives the focus
back to „Antworten“ (`useFocusBackOnClose`, `review/focus-return.ts`).

Both writes go through the annotations' own client (`lib/annotations/client.ts`),
the same writes the thread makes, so the settle rules above apply unchanged,
and the service checks the write again. An answer from the row that still
comes back `wake: 'off'` (a Rückfrage reached through another row) says that
Piloti reads it only once asked with @Piloti in the Prüfansicht.

The notification offer the shell makes once as a toast
(`features/notifications/components/inbox-push-offer.tsx`) names the newest
request: a person („Anna hat Sie erwähnt …“, „Anna braucht Sie in Piloti …“),
or for `piloti.asks_you` Piloti („Piloti hat eine Rückfrage an Sie …“), never
„Jemand“ for Piloti's question.

Opening a mark reads its news. When a mark stays selected in the review for
`MARK_NEWS_SETTLE_MS` (`features/documents/hooks/use-document-review.ts`), the
reader's informational items anchored on it are read through
`POST /api/inbox/read { resourceType: 'document', resourceId, anchorId }`; a
mark stepped past with J/K is not, and only a mark whose dot says it has news
is read (`unread.has(id)`): a mark without one sends nothing. Requests stay
open: seeing a mark is not answering it. A read that found nothing changes
nothing, so it nudges no open inbox. A tapped
notification is read too: the service worker posts its item to the same route
before it opens the mark. The rows about new marks on the document are read
when its review opens (`marksSet: true` on the same route), not with the mark
they link to.

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
thread, and with `annotation.assigned_to_you` and `annotation.mentioned` for
everyone when the mark is resolved or dismissed, by a person or by Piloti in
their name. An `annotation.mentioned` is resolved for its reader when they
answer in the thread: mentioning yourself tells nobody, and a colleague asked
in the same breath has not answered. A mention taken back (a `body` that no
longer names the person, or its reply deleted), with nothing else on the mark
naming them, turns their `annotation.mentioned` inert, its quote wiped
(`onMentionsWithdrawn`). Every other row still quoting a deleted reply counts
one less and quotes nothing (`onReplyDeleted`, above). A Zuständige
who is replaced, or removed, has their `annotation.assigned_to_you` resolved.
Deleting a mark turns every row about it inert, for everyone: none keeps a
link to it or a quote from it. A „15 Anmerkungen gesetzt“ row anchored on it
counts one less instead (above). Every inert write also sets the row's count
to 0, so a row revived later counts only what revived it.

A proposal Piloti made (`piloti.proposal_waiting`, `lib/proposals/attention.ts`)
is worded by what it changes, stored as its `variant`: a file operation by its
verb („Piloti schlägt eine Umbenennung vor“), a note („Piloti möchte sich eine
Notiz merken“), a change to the project context. Its excerpt names the files,
the note or the change, and its body says the proposal is in the chat and that
nothing changes until the person applies it.

### The daily Frist reminder

A mark handed to someone with a date used to say nothing when the date came.
Once a day the Zuständige of every open mark whose Frist is today or tomorrow
is reminded (`due_soon`), and of every mark whose Frist passed in the last
seven days (`overdue`), in the row they already have for the mark: `annotation.assigned_to_you`, folded
per mark, so the overdue reminder upgrades the earlier one and is never a
second row. Same type and same push policy as being handed the mark
(requests): it is the same request, coming due. It reaches the inbox and the
devices with notifications on, one notification per person for the morning's
reminders however many marks are due (above); the type's mail after two hours
unread waits for the ADR-0035 sender, like every other mail.

- **When.** The job scheduler's daily clock (`scheduler/index.js`,
  `sweepAnnotationDue`) posts `POST /api/internal/annotations/due-reminders` at
  06:45 in Vienna. A start before 06:45 waits for it: a restart at 01:00 would
  otherwise push at 01:00, and its stamps would silence the 06:45
  run. A start later in the day catches that day's run up on its first tick.
  A failed post retries in an hour, but never past the office's midnight: a
  retry that would fall on the next day waits for its 06:45 instead.
- **Where it runs.** The route (`enqueueDueReminders`,
  `lib/annotations/due-reminders.ts`) finds the organizations with marks due
  (one grouped read under the platform scope, `listOrganizationsWithDueMarks`)
  and enqueues one `annotation_due_reminders` job per organization on the BFF
  job queue (ADR-0079), inside `withTenant` for its own lane, so one office's
  thousand marks never hold up the next office's handful. The job's id is uuid5
  of the organization and the office's day: a second post the same day (a
  restart, a second replica) adds nothing while that job is queued, running or
  dead. A finished job's row is deleted (migration 0104), so a post after it
  queues the day's job again, and the stamps (below) make that run tell nobody
  twice. When an organization's job cannot be queued (not a duplicate), the
  others are still queued and the route then fails, so the scheduler retries;
  what is already queued counts as `already`. Discovery takes at most 1000 organizations
  (`DUE_REMINDER_MAX_ORGANIZATIONS`), in an order that turns over with the day
  (a hash of the organization and the day), so the ones over the cap are a
  different set each day rather than the same tail for good; reaching the cap
  is a warning in the log. Not by the earliest Frist: discovery cannot see the
  stamps, so offices with long-overdue marks already reminded of would hold
  the head of the list every day.
- **What it reads.** A page of 100 marks per slice, by id from where the last
  slice stopped (`listDueMarksPage`): open, with a Zuständige and a date from
  seven days back through tomorrow (`dueWindowOn`, `DUE_REMINDER_OVERDUE_DAYS`),
  on an active document of the project or the Büroablage that passed screening
  (`documentVisibleTo(SCREENED_ONLY)`: a held upload reminds nobody, as it
  tells nobody). Discovery reads the same window, so the first run does not
  remind of every Frist that ever passed, and an office whose only open marks
  are long overdue drops out of the daily discovery.
  `idx_document_annotations_due` holds exactly the rows the window ranges over;
  whether a read takes it is the planner's call.
- **Whom it tells.** The Zuständige, while they may open the document
  (`mayOpenDocument`, asked once per document a page holds), as every item
  about a mark is filtered.
- **Once.** The row records which reminder for which date it carries
  (`reminder: "due_soon:2026-10-18"`, `remindedFor`), and the job reads the
  rows first (`readGroupPayloads`): a second run, a retried slice or a
  restarted scheduler tells nobody twice, a date moved since is reminded of
  anew, and a read row that already says it stays read. Handing the mark to
  someone or moving its date clears the stamp (`reminder: null` in
  `onAssigneeChanged` and `onDueChanged`; the row's payload merges, so only an
  explicit null takes it off): a date moved 18→20→18, or a mark handed
  A→B→A, is reminded of again. A change the Zuständige makes themselves
  writes no row, and so leaves the stamp.
- **Observable.** Nothing calls a model, so nothing is traced to Langfuse. A
  finished job is one `annotation_due_reminders_sent` PostHog server event with
  its counts (`checked`, `due_soon`, `overdue`, `already`, `unreachable`,
  `failed`), the way the push job reports what it sent
  ([`posthog-events.md`](../observability/posthog-events.md)). A mark that could
  not be told is a warning in the log, and the next run tells it.

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

`GET /api/documents/[id]/annotations/export?format=pdf|docx|md&scope=open|all&revision=current|all&includeProposals=1`
(`frontends/ui/src/lib/annotations/export.ts`; the query and the link in
`export-request.ts`, shared by the route and the menu). The defaults are a PDF
of the open marks.

**The Fassung narrows the record, never the work** (`selectMarks`). A mark
still open is in every Protokoll whichever Fassung it was set on, and its entry
names that Fassung: Index C arriving the day before the Jour fixe does not
answer the marks on Index B, and a default that dropped them would drop exactly
the points the meeting is for. `revision=current` leaves out what was CLOSED on
earlier Fassungen; `revision=all` takes that in too. So the menu offers the
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
writer, which escapes what a person typed so it stays text
(`lib/text/markdown-escape.ts`, shared with the mail import's note). No dependency was
added. A PDF whose layout cost passes `MAX_MARKDOWN_PDF_CHARS` is refused (422)
before react-pdf blocks the event loop; Word and Markdown have no such bound.
There is no thumbnail of the marked place: the BFF has no page rasterizer, so
an entry names its page.

**The trail.** Each export is the audit event `document.annotations.exported`
on the document: format, scope, Fassung, whether proposals were included, and
the counts, never a name or a word of the marks. A download is also the
browser's `report_exported` with `kind: 'annotations'` and the format, the
trigger of the CSAT survey the answer and room-schedule exports fire. Nothing
calls a model, so nothing is traced to Langfuse.

## Offene Punkte: a project's open marks

A Jour fixe is held per project, not per document. The Prüfansicht answers
what is open on one sheet, and the Postfach what is waiting for one person;
neither answers what is open in the project. **Offene Punkte** does:
`/app/projects/[id]/files/open-points`, reached from the Dateien header beside
the Papierkorb (on a phone from its ⋯), lists the live marks of every
document of the project, grouped by document.

**Why a page under Dateien and not a project section.** A section is a rail
entry, a palette command, a `g` shortcut, a tour stop and a phone tab
decision (`components/shell/project-sections.ts`, `phone-tabs.ts`). Open
points are a view of the documents, so they stand where the Papierkorb
stands: a page of the Dateien section with its own address, which a Jour fixe
can bookmark, and the Dateien tab stays lit on a phone. The rail carries no
counts but the Postfach's, so the page has no count in the navigation.

**What is listed** (`GET /api/projects/[id]/annotations`,
`listProjectAnnotations` in `lib/annotations/project-marks.ts`). The project
gate first (`requireProjectAccess(…, 'project:view')`, as the Dateien listing
asks it). Then one query (`listProjectAnnotationPage`,
`project-repository.ts`) joins `documents` and narrows them exactly as the
listing does: the project's shelf, active documents only (an archived one has
left the working set), outside every folder hidden from the reader
(`getHiddenFolderIds`, the Papierkorb included) and
`documentVisibleTo(reader)` with the reader from `shelfReaderFor`, so a held
upload's marks are listed for its uploader and its reviewers and nobody else.
The function composes the predicate itself, so
`document-visibility.spec.ts` holds it without an allowlist entry.

The filters: `status` (`open` by default, `proposed`, or `all-live`),
`assignee` (`me` or a user id) and `due`: `overdue` is a Frist before today,
`soon` today through seven days ahead (`DUE_SOON_DAYS`, the week to the next
Jour fixe), both on the office's calendar as the daily reminder counts. The
page is ordered by the document's shown name, case-folded by Postgres, then
the number (`order=document`), or by Frist with the marks without one last
(`order=due`). It is keyset-paged: at most 100 rows a page, 50 by default, and
the cursor carries the last row's keys as Postgres wrote them, opaque on the
wire and refused (400) when it is not one the service wrote.

**One view.** Each row is the view a document's own list carries: the list
projection (`documentAnnotationViews` in `service.ts`, which
`listAnnotations` uses too) runs per document of the page, with what this
reader may do on that document (`canWriteDocument`, so `canEdit`,
`canDelete` and `carryTarget` are that document's), plus `documentName`. The
organization's directory is read once per page.

**The page** (`features/documents/components/open-points/`). Each row is the
review list's row (`MarkRowContent`, `review/mark-row.tsx`, which the
review's own list wears too), here a link into that document's review at the
mark: Dateien with `doc`, `review=1` and `mark` (`reviewFilesHref`), which the
pane already answers, and `back`, this page's address with its filters, so
closing the review returns here (above, „The review's address“). Each
document's heading has „Prüfansicht öffnen“ for the whole review. The filters
are „Zuständig: Alle | Für Sie“ (`isForReader`, the review's word) and „Frist: Alle | Überfällig | Bald“, kept in the
page's address (`assignee=me`, `due=overdue|soon`); a change replaces the
address with `window.history.replaceState`, which Next's App Router follows
(`useSearchParams` reads it, an `ACTION_RESTORE` with no server request),
where `router.replace` rendered the page on the server again for a filter
click, and reads the first page again through the typed client
(`listProjectAnnotations` in `client.ts`), and a later page is read at the foot
of the list (`LoadMore`). The server reads the first page for the first paint.
The list is read again, quietly, on mount (Back from a review restores the page
with the server's first page as it was, before the reader closed the marks they
went to) and when the tab returns to view (`useProjectMarks`); that read covers
as many marks as are shown, up to a page's most. A failed read says so with
„Erneut versuchen“. `/dev/open-points` previews it over fixtures.

**The Protokoll** (`GET /api/projects/[id]/annotations/export`,
`project-export.ts`). „Protokoll exportieren“ on the page asks only the
format: what is in the file is what the filters show. The export reads the
marks page by page through `listProjectAnnotations`, so exactly what the
reader's list shows, sorts each document's into the office's marks and
Piloti's proposals with `selectMarks`, and writes each entry with the
document Protokoll's own `entryBlocks` under a heading per document; the files
come from the same `renderProtocol`. Past 1000 marks
(`PROJECT_PROTOCOL_MAX_MARKS`) it is refused (422 `too-many-marks`) rather
than cut. The download goes the document Protokoll's way (`downloadFetched`
in `lib/browser-download.ts`, which `ReviewExportMenu` and the answer's Word
export use too). Each export is the audit event `project.annotations.exported`,
with the filters and the counts and never a name or a word of the marks; a
download is also the browser's `report_exported` with `kind: 'open_points'`
and the format, as the document Protokoll's is. Nothing calls a model, so
nothing is traced to Langfuse.

**Filed in the project.** „Im Projekt ablegen“ in the same menu
(`ProjectProtocolMenu`) files that Protokoll, with the filters on screen, into
the project root, the way a document's Protokoll is filed (below): the export,
then the upload door (`fileProtocol` in `protocol-filing.ts`, which takes the
export's link, so both menus share it), named „Offene Punkte – <Projekt> –
<the office's day, YYYY-MM-DD>“ (`openPoints.export.filedName`). It is offered
where the reader may upload to the root, the check the upload makes
(`canWriteFolder(…, null)`, read by the page), and the project is not closed.
The root is where every member reads, and the Protokoll quotes the marks of
every document it lists: a point on a document in a folder not every member
may read, or on an upload still held back, would reach people who may not open
that document. So the list's first page says whether the whole selection
(every page, the filters applied) touches such a document (`restricted`,
`selectionReachesRestrictedDocuments` over `getRestrictedFolderIds` and the
screening hold, one bounded read), and while it does the item stays in the
menu, withheld, with why under it („Nicht möglich: Einige Punkte stehen auf
Dokumenten, die nicht alle im Projekt öffnen dürfen …“). A filter that leaves
those documents out makes it available again. Filing the project's Protokoll
into a restricted folder instead was not taken: which folder would be
narrow enough for every document it quotes has no one answer, and the root
with this refusal is what the reader can predict.

**Filed as a document.** „Im Projekt ablegen“ in a document Protokoll's menu
(`ReviewExportMenu`) files the export, with the menu's choices, into the project
(`features/documents/lib/protocol-filing.ts`). It is offered on a project's
document, not archived and not in a closed project, to a reader who may write
the document's folder: the review's `canAnnotate`, which is
`getAccessibleDocument(…, 'write')` and so the folder's write (ADR-0088), the
right the upload asks for too. Filing sends no PostHog event: it is neither a
file taken out of the app (`report_exported`) nor a person bringing files in
(`document_uploaded`), and the server's `document.uploaded` audit event
records it.
It composes two existing doors in the browser and adds none (ADR-0055): the
export above, then the project's upload, `POST /api/documents/upload`
(`uploadDocument`), the door every person's file goes through, so the
person's rights, the folder's access per role, name screening, the quota, the
ingest and the `document.uploaded` audit event all apply as to any upload. Not the chat
draft card's „Ins Projekt ablegen“ (`POST /api/conversations/{id}/draft/file`):
that door files a text Piloti wrote in a conversation's working directory
through `fileGeneratedDocument`, which marks the bytes as machine-written and
keeps them out of the index. A Protokoll is the person's record of the office's
marks; filed through the upload it is theirs, and it is read like any other
file. The file goes into the folder of the document it is about: a Protokoll of
a document in a restricted folder quotes what only that folder's readers may
read. Its name is „Protokoll – <document's name without extension> – <the
office's day, YYYY-MM-DD>“ (`protocolFilingStem`, Europe/Vienna); a PDF, or
Word when the export refuses the PDF as too long. A second filing on the same
day carries the same name into the same folder, and the upload door makes it the
next Fassung of the first (ADR-0054's same-name re-upload); the same bytes again
are `unchanged` and write nothing. A name another document holds under another
restriction is the upload's `name_taken` 409, said as such. The toast says
which („Abgelegt als …“, „Als neue Fassung von … abgelegt“, „liegt schon so im
Projekt“) and opens the filed document in Dateien (`documentFilesHref`). Offered
where the document is a project's (not the Büroablage), the reader may manage
it, and the project is not closed (`protocolFiling`, `file-preview-pane.tsx`).

## Known debts

- „Fassungen vergleichen“ compares two documents (`revision-compare-service.ts`); two versions under the same name have no visual comparison yet, so a mark of an earlier Fassung of the same document is carried with only its ghost pin to show where it stood.
- A mark carried on to a replacing document starts a new thread there; the old one is read on the replaced document, by the link in the card. The two are not one timeline.

- The chat-hosted canvas (the review open over the chat) still asks an @Piloti reply in the chat's conversation, under the chat's own message id, when wakes are off; only the standalone canvas uses the reply's turn id.
- The „Woken by“ prompt block names the person the turn runs for. A woken turn has no access token, so the name comes from the signed envelope's `requester`, which the wake job mints from the pinned session (`resolvePerson`; `turn.context.user_info_for`). `author_name` on the message only attributes the turn in the transcript. A woken turn whose person WorkOS cannot name still reads „A person“.
- Which Piloti reply a wake wrote is derived, not stored (`lib/annotations/wake-attribution.ts`): a wake of the same person on the same mark that began before the reply and had not ended before it. The thread shows it as „Geweckt durch …“ under the reply's byline.

- The canvas runs its own small turn client next to the chat's turn driver in `use-websocket-chat.ts`. That driver should become one shared module that both use.
- A box asked about on the canvas is still this tab's: its answer lives in the tab until kept, and a reload loses the card (the conversation keeps the answer). The next step is the primitive the thread now has: an ask as a server-side request on the document (a wake with an `asked` trigger), run headless, its state on the room, the tab attaching to its turn to stream it.
- Over the chat, a canvas question whose server reads no box is not told so (`onDegraded` is the stand-alone canvas client's).
- The Python side posts to internal routes through several near-identical helpers.
- A change Piloti makes and its note are two writes in one request, not one transaction (`updateAnnotationForAsker`). Every refusal the service can foresee (rights, a stale status, a full thread) comes before the change; a database failure between the two writes would still leave the change without its note.
- The change record is a third write, after the annotations service has committed the change and its note (`recordPilotiChanges`, `frontends/ui/src/lib/changes/service.ts`). The service offers no hook into its transaction, and a failed record is logged, not thrown: the change then lands without a row, so the card cannot undo it from the record.
