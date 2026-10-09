# Lifecycle matrices for heavy surfaces

A lifecycle matrix lists every way one surface can be entered, interrupted and
left, and states for each what the reader should see, what goes wrong there,
which fixture shows it and which check holds it. It exists because a heavy
surface fails at the edges nobody scripted: a stop during the finish, a reload
mid-turn, a card that arrives before the first word. A happy-path spec and a
reviewer looking at one screenshot both miss those.

The matrices live in [`../design/lifecycles/`](../design/lifecycles/README.md).
The first one is the [streaming chat turn](../design/lifecycles/chat-turn.md).

## When to write one

Write one only when the surface meets **all** of these:

- **Asynchronous inputs over time.** Many kinds of event reach it after it has
  mounted (socket frames, server stages, other users), in orders the code does
  not control.
- **Motion.** It moves while the reader looks at it: entrances, height changes,
  folds, a paced reveal, a scroll anchor.
- **Shared pixels.** Several components or owners draw into the same region,
  so one component's correct move can shove another's content.
- **Irregular exits matter.** Errors, stop, reconnect, reload or a navigation
  away can each happen at more than one phase.

The chat turn meets all four. So would the run block, a live collaborative
editor, or a viewport that streams geometry.

Do not write one for a form, a dialog, a list or table page, a settings panel,
or a card that renders once from props. Their states fit a component spec and
a `/dev/<name>` preview with a few variants. A matrix for those is a long
document nobody keeps current. If you are unsure, the surface does not qualify:
the test is that you cannot list its states from memory without missing one.

## The steps

1. **Phases.** Write the state machine as a table: phase id (`P0`…), what data
   enters it, what the reader sees, the one ambient loop that runs (or none),
   and the component that owns the pixels. Source the "sees" column from the
   design of record (the choreography), not from what the code does today.
2. **Edges.** One row per transition (`L01`…), the irregular ones included.
   Walk each irregular input across every phase it can hit: error, stop,
   socket drop, reload, navigate away and back, a second observer, the reader
   toggling something by hand, a second action arriving quickly. Then the
   environment axes: reduced motion, phone, phone with keyboard open, dark
   mode. Most findings come from this step.
3. **Events.** Catalogue every event type the surface can receive (`E01`…):
   where it appears, the target choreography, and its cost per event where it
   is known. An event with no visible effect still gets a row that says so.
4. **Columns per row.** Expected (what the reader sees), Failure modes (what can
   go wrong at this edge, in general terms), Fixture (the `/dev` route and
   query that reproduces it), Check (the spec name or harness assertion that
   holds it). An empty Fixture or Check cell is a gap, and gaps are the point.
5. **Rank the gaps.** Order by visibility times likelihood. Each gap becomes a
   fixture scenario and an assertion before it becomes a fix, so the fix has
   something to turn green.
6. **QA pass.** Run the harness against every scenario at phone and desktop,
   record the screen for the motion rows, and attach the results to the PR.
   Note the date in the index.

## How it relates to the other tools

| Tool | Holds | The matrix uses it as |
|---|---|---|
| The surface's design doc (for the chat turn, [`streaming-chat-answer.md`](../design/streaming-chat-answer.md)) | The intended choreography and the reasons | The source of the Expected column |
| `/dev/<name>` preview routes | A reproducible state with no backend | The Fixture column, by route and `?scenario=` |
| A measure harness (for the chat turn, [`measure-stream-socket.mjs`](testing-and-verification.md#the-socket-level-streaming-harness)) | Numbers: layout shift, frame cost, animations started | The Check column for motion and movement rows |
| Unit specs beside the code | One decision in one component | The Check column, by spec file and test name |

## Keeping it alive

- **Same PR.** A change to the surface's behaviour updates its matrix rows in
  the same pull request, like any doc the change contradicts.
- **Name the checks.** The Check column quotes spec names and harness flags
  exactly, so a renamed or deleted test leaves a dangling name a reviewer or a
  grep can find.
- **No defect log.** The matrix states what should be true. What is broken
  today, with file and line, goes in the issue or the PR that fixes it. The
  matrix keeps only a short Open gaps list that names missing fixtures or
  checks, and each entry leaves when its fixture lands.
