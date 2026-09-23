# The Laufblock — one element for everything a run is

**Status:** Implemented (2026-09). ADR-0062 decides the model; this is the
design of what the reader sees of it.
**Related:** `frontends/ui/src/features/runs/components/RunBlock.tsx`,
`.../RunBlockLine.tsx`, `.../RunBlockMessage.tsx`, `lib/choreography.ts`,
`frontends/ui/src/components/ui/stage-track.tsx`; evidence at `/dev/run-block`,
`?variant=transition`, `?variant=motion`.

## What it replaces, and why

A run used to be told in four places at once: a banner at the top of the thread,
a side panel with its own tabs, a stub sentence in the message list, and a status
pill on the task card — each with its own vocabulary, none of them agreeing about
what „running" meant. A person who handed Piloti a task and came back an hour
later had to reconstruct the run from four partial accounts.

The block is the one element. It lives in the thread that commissioned the run,
because that is where the person was standing when they asked, and it renders
from ONE input: the run's ledger.

## The grammar it borrows

Nothing here is a new material, and the surface it borrows from is the document
lifecycle panel — the one place in this product that had already solved „where
does this stand".

- **A stand**: the title, the elapsed time, a thin track of the five phases, and
  ONE muted line naming where the run is. Exactly the panel's badge-over-track-
  over-sentence, in the same order.
- **The track** is the shared atom, `components/ui/stage-track.tsx`, lifted out
  of `document-lifecycle-stand.tsx` when this block needed the same shape. Two
  surfaces showing the same thing compose the same atom, or they drift on the
  first token retune.
- **The body** is `ItemList` + `Item`: one block with hairlines between its
  rows, which is what a list of rounds is — the same three atoms
  `document-version-list.tsx` composes, and for the same stated reason (three
  bordered boxes read as three cards rather than as one history).
- **The phase acts** are `dt`/`dd` rows at the version history's own weight: the
  same kind of fact („eingereicht von X am Y") in another vocabulary.
- **The reviewer's words** are quoted with a `border-l-2`, the adjunct a version
  row already renders under itself.
- **The document chips** stay the „Belegt durch" chips (`SourceSignalChip` +
  `AuthorityTag`), painted by the shelf the ledger stated: provenance is the one
  thing the design language spends colour on, and which documents a run read is
  its whole claim to being checkable.

## What „stripped down" removed

The first version said the state four ways before the reader reached the work: a
glyph, a bold word in the header, a phase summary beside it, and a sentence in
the footer. A state said four times stops reading as one fact.

Now it is said once, in the status line, and shown once, in the track. The
labelled phase rail is gone (the track carries position, the line carries the
name), the per-phase timeline is gone (finished phases are acts, the live one is
a line), the footer sentence is gone (it IS the status line), and the header's
summary is gone with it. What is left of the chrome is a glyph, a title, a
clock, a chevron and one action.

## What it refuses to show

- **No tool names.** The ledger carries none, on purpose: a step is the runner's
  stated intent („Klären, welche Fluchtweglängen OIB 2 für Gebäudeklasse 4
  vorsieht"), never `knowledge_search`.
- **No identifiers.** No job id, no run id, no message id reaches the reader.
- **No numbers in the header** except the two tallies and the clock.
- **One ambient loop on screen.** The Herleitung bar runs a shimmer and a sweep
  beside its spinner; a thread with three live runs cannot afford nine loops, so
  the block runs one — the spinner — and the rail's active ring is static.

## The seven states

The status line is the whole of it: the word, then the one fact the state owes
the reader. While the run is going it leads with the PHASE instead of with
„Läuft", because the phase is the informative half and „läuft" is already said by
the turning glyph.

| State | The status line | The track |
|---|---|---|
| `angelegt` | Wird gestartet · Ergebnis kommt ins Projekt | empty, ink |
| `laeuft` | Recherchieren · 3 Runden · 9 Dokumente | walked segments ink, the live one at half weight |
| `wartet` | Wartet auf Sie · Antworten Sie unten im Verlauf | unchanged; the block opens itself |
| `fertig` | Fertig · Bericht abgelegt in Projekt › Berichte | full, settled |
| `fehlgeschlagen` | Fehlgeschlagen: `<reason>` | stops short: the next segment is a dashed outline, in the error register |
| `abgebrochen` | Abgebrochen · auf Ihren Wunsch beendet | quiet: nothing is broken |
| `unterbrochen` | Unterbrochen · Bericht aus dem Vorhandenen geschrieben | settled — there IS a report, only a narrower one |

The failure's reason is in the LINE and not behind the chevron: a failure the
reader has to go looking for is a failure nobody reads. So is the way to a filed
report — when nothing else fits the state, „Im Projekt anzeigen" is the stand's
one action, because the line has just said where the report is.

`completedBefore` — „Bis dahin: Planen, Recherchieren (2 Runden, 6 Dokumente)" —
is the difference between „failed" and something a person can act on: it is what
stops them re-commissioning work that is already done.

## How a change reads

The block is replaced ledger by ledger, and every difference between two ledgers
is one small fixed move, never decoration. What moves is what CHANGED; what was
already on screen stays where it is:

- **Arrival** — the turn's fade-and-rise.
- **A phase completes** — its segment fills, as a colour transition on the
  track, and the line under it names the next phase.
- **A round arrives** — its row rises, the document chips cascade (capped, so a
  round with nine documents is not nine beats long), the open points last.
- **The run lands** — `landingDelays` queues the glyph, the status line, the
  fold, the closing rows and the report so they play in that order. Every offset is
  summed from the motion kit's own constants, so the ORDER survives a retune of
  any single duration.

Nothing replays: rows are keyed by phase and by step id, so a re-render is the
same element with new props, and `AnimatePresence initial={false}` on every list
means a block that mounts finished paints in one frame — a staged reveal of facts
that were true before the reader arrived is theatre. Under reduced motion every
one of these is the change with no motion.

The status line crossfades rather than cutting, because it is the one place the
block states what just happened. The crossfade holds two words at once for a
moment, so the SPOKEN word is a plain `sr-only` copy beside it and the moving
pair is `aria-hidden`: a reader must never hear the run called two things in one
breath.

## What a round shows while it runs

A round used to show only what it read. It now also shows what it established:
the claims the researchers' notes state, up to eight per round, under the
document chips and before the open points, and the header counts them
(„3 Runden · 9 Dokumente · 4 Befunde"). A twelve-minute run is readable at
minute three. The fold copies each `ResearchNotes.findings[].claim` off the
researcher's own output (`run_ledger_fold._add_findings`); the ledger's
`findings` field is the contract on both sides, pinned by the schema fixture.

When the reader named documents on the plan card, the block carries a receipt
under the phases: each Grundlage row, read — with the pages or Punkte the
rounds reached, derived from the steps (`grundlageReceipt`) — or not yet read.
The ledger's `grundlage` field is the list; the loci are never stored twice.
A row opens the document as a dialog over the thread, never a pane beside it.

## The plan on the block

A run commissioned with a research plan shows it first in its body
(`RunPlan.tsx`, ADR-0065), because what the run is about comes before what it
did. One row, three readings, and none of them is a question:

- **Proposed** — the brief at a glance: the genre's glyph in a well, the
  plan's title (up to two lines), a line of facts (genre, depth, sections,
  „n zuerst gelesen" or „nur n Unterlagen", exclusions), the first four sections as a numbered outline and
  the named documents in their provenance colours, over a bar draining toward
  the start. Doing nothing is
  a complete answer: the run starts on its own. „Anpassen" stops the clock and
  opens the plan as controls; „Jetzt starten" skips the wait.
- **Held** — the plan open as three steps, each titled by what it decides and
  with one line on what deciding it does: *Was der Bericht behandelt* (the
  outline with its add row, and suggestions for the chosen genre that skip
  what the outline already covers), *Wie er aussieht* (genres as
  `ChoiceCard`s, a radio group; depth as a segmented choice) and *Was Piloti
  liest* (optional, below). The steps carry no numerals: the outline beneath
  them is numbered, and two counters in one column read as one. Every edit is
  saved as it is made, applied to the block at once (`applyPlanEdit`) so the
  next edit is diffed against it; the status line says so, in the same line
  that says where the plan stands. „Starten" sits both in the header and at
  the end of the plan, where the reader finished. The ledger reads `wartet`
  meanwhile, so the header's clock stops and the inbox tells the requester.
- **Started** — the brief the run is running, folded and read-only.

A plan the reader wrote in „Recherche planen" reads „Ihr Rechercheplan" and
starts at once. The dialog asks the question first and then shows the same
steps; its document step names the sources the composer has switched on. An empty outline offers the genre's ready outline in one press. Beside
the steps a preview shows the brief as the block will show it. The footer
ticks off what is still missing (a question, a section), so the reader is not
left guessing why the button is grey. The pieces are the plan's own atom kit
(`features/runs/components/plan-atoms.tsx`) and `PlanBrief.tsx`; the block and
the dialog compose the same ones.

### What Piloti reads

The document step is optional and opens as a sentence, not a setting:
„Piloti durchsucht [Wissensbasis] [Projektunterlagen] und wählt selbst, was
zur Frage passt." The chips are the sources the run was commissioned with, so
„alles" has a name. Nothing in the step needs touching for that to happen.

Then one action, „Bestimmte Unterlagen zuerst lesen …", opens the document
picker. The chosen documents are read in full before anything else, and show
as chips under „Zuerst gelesen:". In the picker's footer one checkbox, „Nur
diese verwenden", narrows it: of the reader's own documents the run uses only
these, while norms and laws stay available. The chips then read „Nur diese:",
with a line saying what stays available. The choice sits beside the documents
it is about, not in a scope switch the reader must understand first.

Excluding is rare, so it sits behind the product's one disclosure
(`Advanced`), whose trigger says „· 1 ausgeschlossen" when something is set.
Exclusions stay when „Nur diese" is on; the note says they have no effect
while it holds. Striking the last chip under „Nur diese" lifts „Nur diese"
with it.

### How the plan moves

Every motion below comes from the kit (`components/motion`) and the rules in
[`grid-design-language.md`](grid-design-language.md#motion-vocabulary); the
atoms carry it (`features/runs/components/plan-atoms.tsx`), so the block and
„Recherche planen" move the same way.

| What happens | How it moves | Why |
|---|---|---|
| The grace runs down | The bar drains once, linearly, over the seconds left (`motionCountdown`) | A clock passes time at a constant rate. Stepping it once a second on a 320ms tween read as a stutter |
| The clock stops, the plan is held or started | The bar fades out; the status line swaps (`Swap`) | A new state in the same place. The line swaps with the status, not with every tick |
| „Anpassen" | The editor is there at once, the brief fades out over it (`Swap`, `popLayout`) | Waiting out an exit would read as the press not landing |
| „Anpassen" leaves, „Starten" takes its place | Each action fades in or out; the other glides over (`PlanAction`) | The reader sees which control went and which stayed |
| A section is added, struck or taken from a suggestion | The row rises in where it lands; a struck row folds away left; the rows below glide up (`layout`, `motionBase`) | The travel is a row, not a panel, so a tween; the glide shows which one went |
| The outline first paints | A capped cascade (`staggerMaxSteps`) | A reading cue, finished inside 200ms |
| A genre is chosen | The card's check lands (`ChoiceCard`) and the well's glyph on `springSnap` | A mark landing under the hand, under 24px of travel |
| Depth | The chosen segment's pill travels (`ToggleGroup`, `springGlide`) | The same segmented control as everywhere else |
| A document is named or struck | The chip fades and scales in or out, its neighbours glide (tweens only) | Provenance is evidence: it never springs |
| A requirement in the dialog is met | Its tick lands on `springSnap` | Confirmation of the reader's own input |

Reduced motion drops all of it: the kit's `MotionConfig` zeroes transforms, the
cascade's delays go to zero (`useReducedMotion`), the countdown bar shows how
much is left without draining, and every state still reads from its words.

## The document picker

Every place that asks the reader to name documents opens the same modal: the
plan's „zuerst lesen" (with „Nur diese verwenden") and its exclusions,
„Unterlage hinzufügen" on a running block, and whatever asks next
(`features/documents/components/document-picker/DocumentPickerDialog.tsx`,
preview at `/dev/document-picker`).

It is the Files browser in a dialog, not a second one. The listing is
`FileBrowserPane` with a `selection` (`features/documents/lib/file-selection.ts`):
the same `FileCard`s with their real page thumbnails
(`/api/documents/{id}/thumbnail`, falling back to the kind sketch), the same
detail list (`FileListView`) with its sortable columns, the same folder cards,
path row and back control, the same search, empty states and level motion.
Folders are browsed read-only: without the rename, delete and create handlers
the folder atoms show no menu and no „Neuer Ordner". What the picker adds is
only what a picker is:

- **Places** on the left: the project, the Büroarchiv (when the organization
  has one), and Ausgewählt, which lists what is chosen across both. On a phone
  the places become a row under the toolbar.
- **A checkbox on every document**, top right on a card, a leading column in
  the list. A click on the card toggles it too. A document the caller rules
  out („Ausgeschlossen", „Zuerst gelesen", „benannt") says why in place of its
  summary and cannot be checked.
- **Footer**: how many are chosen, „Auswahl aufheben", the caller's own
  control (`PickerFooterCheck`), „Abbrechen" and the caller's button.
  Confirming an empty choice is allowed when it is a change: that is how a
  list is cleared.

A single-choice picker confirms on the click. How it moves (`picker-atoms.tsx`):
the places' highlight is one element that travels to the place chosen
(`springGlide`), as the app rail's does; everything in the listing moves as
the Files browser moves; „Auswahl aufheben" fades in with a selection and out
without one.

The picker knows nothing of what a choice means; the caller names the button
and the reasons. Its listing comes from `useDocumentLibrary`, read only while
a picker is open.

## The actions

One action fits each state — „Antworten", „Prüfen", „Bericht öffnen", „Erneut
starten" — at the header's right end from `sm` up, in the footer on a phone. Two
things sit beside it rather than instead of it:

- **„Abbrechen"**, while the run is going and only when a caller offers it. Ghost,
  so it never competes; always in the same slot, so it is never hunted for. It
  asks first, and the question is phrased around what SURVIVES: the rounds
  already researched stay in the block, only the report goes unwritten.
- **„Jetzt schreiben"**, while the run is *researching* and only when a caller
  offers it. The opposite of „Abbrechen": stop researching after the current
  batch and write the report from what is there. No confirmation — nothing is
  lost by it. The request travels as a job event
  (`POST /v1/jobs/async/job/{id}/write-now`), the worker's monitor sets a
  per-run signal the research tool reads before every batch
  (`deep_researcher/control.py`), and the report lands marked
  `unterbrochen` with a banner that says it was the reader's choice.
- **„Dokument hinzufügen"**, while the run is *researching*, when a caller
  offers it: a dialog over the thread lists the project's and the Archiv's
  documents, and one press names one as Grundlage. The addition travels as a
  job event (`POST /v1/jobs/async/job/{id}/documents`), the research tool
  plans it into its next batch, and the receipt shows the row at once, unread
  until a round reaches it. A row already named offers no second add.
- **„Bericht fortschreiben"**, on a finished or interrupted run, when a caller
  offers it: a new run on the same subject, briefed with this report's
  findings, so a changed project fact re-reads the Befunde instead of starting
  over, and with the report's cited project and Archiv documents as its
  Grundlage. The new block lands in the same thread; its matrix marks what
  changed.
- **The connection line**, when the live view loses its stream. It leads with the
  run („Der Auftrag läuft weiter"), because that is the fact the reader fears.
  Silence there would read as a run that stopped.

## The compact form

`RunBlockLine` is the header reduced to a line: the same glyph, the same status
word, the same tallies. The Aufträge index and the task cards compose it rather
than writing their own sentence — two renderers for one run is one token retune
away from two different stories.

The card therefore states the status ONCE more than it used to and once fewer
than it did: the swatch on the title line is the pre-reading scan anchor, the
run line is the word, and the status chip that used to sit beside the run line
is gone. It said the same fact in the task vocabulary (`succeeded`) next to the
run vocabulary („Fertig"), and two adjacent labels for one state stop reading as
one state. A row with no run keeps the chip, because there the swatch would
otherwise be the only carrier and colour never travels alone.

## Where the block appears

Three surfaces, one organism:

1. **The thread** (`RunBlockMessage`). The only one that holds a subscription —
   this is where a live run is watched, where „Abbrechen" is offered, and where
   a `wartet` question is answered. When the stream moves the run from one
   status word to the next, the block writes that ledger back onto its message
   in the chat store, so everything outside the block — the composer, the
   toolbar's „läuft" pill, the history's row, the delete that stops a live run
   — reads the same account (`chat/lib/session-activity`).
2. **The Aufträge drawer** (`TaskDetail`). The block again, fetched once through
   `GET /api/projects/[id]/runs/[runId]` and re-read only when the panel's poll
   moves the row. Opened rather than folded: the click on the row IS the request
   to see inside. It yields its own „Im Projekt anzeigen" to the drawer's result
   button, and keeps a link to the thread beside it — reading a run is not
   following one, and the drawer must never become the only door.
3. **The card and the index** (`RunBlockLine`), as above.

A fourth rendering was considered and rejected. The drawer used to restate the
card it was opened from — kind chip, status chip, goal, review reason, error —
which made the bigger, more deliberate surface say strictly LESS about the run
than the row that opened it, and put a run's state on the Aufträge tab four
times. A surface that shows what another surface shows composes the same atoms
or reuses the organism (`frontends/ui/AGENTS.md`); it does not assemble a
lookalike out of `SheetTitle` and `SectionLabel`.

The drawer keeps those paragraphs for exactly one case: a run from before run
messages existed, which has no ledger, so they are the only account there is. A
read that was REFUSED says something different again, and the two must not look
alike.

## What the block never promises

`filesToProject` is a claim a caller makes, never an inference from „there is a
project". It used to default to `!!projectId`, which made every freshly
commissioned run in a chat say „Ergebnis kommt ins Projekt" — including an
escalated question whose report lands inline in the thread, and whose own
`fertig` line then said so. A block that promises one destination at the start
and names a different one at the end has spent the reader's trust to say
nothing.

The clock stops when the run does, and `wartet` counts as stopped: elapsed runs
to `updatedAt`, which is the instant the run asked its question, because nothing
folds into the ledger between the ask and the answer. Running it on to now made
a run that asked on Friday read „68 h" on Monday — a true number about the wrong
subject. The pill says how long the work took, not how long the reader took.

## Evidence

`/dev/run-block` shows every state, `?variant=transition` shows the handover as
the thread sees it, and `?variant=motion` walks a real ledger frame by frame
through the same fold helpers production uses, so the choreography can be watched
rather than argued about. `/dev/task-detail` is the block inside the Aufträge
drawer and `?state=legacy` is the drawer with no run to read.
