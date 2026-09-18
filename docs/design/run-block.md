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

## The actions

One action fits each state — „Antworten", „Prüfen", „Bericht öffnen", „Erneut
starten" — at the header's right end from `sm` up, in the footer on a phone. Two
things sit beside it rather than instead of it:

- **„Abbrechen"**, while the run is going and only when a caller offers it. Ghost,
  so it never competes; always in the same slot, so it is never hunted for. It
  asks first, and the question is phrased around what SURVIVES: the rounds
  already researched stay in the block, only the report goes unwritten.
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
   a `wartet` question is answered.
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
