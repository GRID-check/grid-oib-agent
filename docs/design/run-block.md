# The Laufblock — one element for everything a run is

**Status:** Implemented (2026-09). ADR-0062 decides the model; this is the
design of what the reader sees of it.
**Related:** `frontends/ui/src/features/runs/components/RunBlock.tsx`,
`.../RunBlockLine.tsx`, `.../RunBlockMessage.tsx`, `lib/choreography.ts`;
evidence at `/dev/run-block`, `?variant=transition`, `?variant=motion`.

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

Nothing here is a new material. The header is the Herleitung bar's (`ChatThinking`):
a glyph in a fixed slot, the bold status word, the muted summary, the elapsed
pill, the rotating chevron, and a body that grows out of the bar. The document
chips are the „Belegt durch" chips (`SourceSignalChip` + `AuthorityTag`), painted
by the shelf the ledger stated. The phase swatches are the product's status
swatch. The two atoms the kit lacked — a phase rail and a timeline — were added
to `components/ui/`, not hand-rolled inside the organism.

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

| State | What the header says | What the footer owes the reader |
|---|---|---|
| `angelegt` | Wird gestartet | where the result will be filed |
| `laeuft` | Läuft · phase · tallies | nothing — the list IS the account |
| `wartet` | Wartet auf Sie | the question, and where to answer it. The block opens itself |
| `fertig` | Fertig · tallies | where the report is, the way to it, who accepted it |
| `fehlgeschlagen` | Fehlgeschlagen | the reason, in one quiet red line, and what was done by then |
| `abgebrochen` | Abgebrochen | stopped at your request, and what was done by then |
| `unterbrochen` | Unterbrochen | the research was cut short; the report is written from what was there |

`completedBefore` — „Bis dahin: Planen, Recherchieren (2 Runden, 6 Dokumente)" —
is the difference between „failed" and something a person can act on: it is what
stops them re-commissioning work that is already done.

## How a change reads

The block is replaced ledger by ledger, and every difference between two ledgers
is one small fixed move, never decoration. What moves is what CHANGED; what was
already on screen stays where it is:

- **Arrival** — the turn's fade-and-rise, then the rail's swatches left to right.
- **A phase completes** — its swatch fills and checks, the connector to the next
  phase fills, and in the list the live content folds while the one-line summary
  fades in over it; the next phase's row rises in.
- **A round arrives** — its row rises, the document chips cascade (capped, so a
  round with nine documents is not nine beats long), the open points last.
- **The run lands** — `landingDelays` queues the header glyph, the status word,
  the fold, the footer and the report so they play in that order. Every offset is
  summed from the motion kit's own constants, so the ORDER survives a retune of
  any single duration.

Nothing replays: rows are keyed by phase and by step id, so a re-render is the
same element with new props, and `AnimatePresence initial={false}` on every list
means a block that mounts finished paints in one frame — a staged reveal of facts
that were true before the reader arrived is theatre. Under reduced motion every
one of these is the change with no motion.

The status word crossfades rather than cutting, because it is the one place the
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

## Evidence

`/dev/run-block` shows every state, `?variant=transition` shows the handover as
the thread sees it, and `?variant=motion` walks a real ledger frame by frame
through the same fold helpers production uses, so the choreography can be watched
rather than argued about. All three are captured in `visual/screenshots/`.
