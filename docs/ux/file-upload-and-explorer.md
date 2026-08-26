# File upload, progress, and the document explorer

**Date:** 2026-08-11
**Status:** Implemented
**Surfaces:** project Files workspace, org Büroarchiv, chat-session uploads
**Screenshot evidence:** `frontends/ui/visual/screenshots/upload-tray.*.png` (`/dev/upload-tray`)

## The complaint

> "The uploads progress bar is not really a progress bar. It always gets stuck on
> the same thing."

It was literally true. The bar's value was:

```ts
const value = file.progress > 0 ? file.progress : isFailed ? 0 : 15
```

`15` is not a measurement. It was a constant standing in for a number nobody had
taken, because the upload went out over `fetch`, and **`fetch` cannot report
request-upload progress** — the browser exposes no event for bytes leaving the
machine, only for bytes arriving. So for the entire upload the bar sat at 15%.
Then `progress` started arriving from the ingest job, which reports in bursts as
the backend works through a queue, so the bar held one value for a long time and
then jumped.

Two different unmeasurable phases were being drawn on one determinate track. That
is a modelling fault, not a rendering one, and no amount of easing fixes it.

## The rule

> **A percentage is drawn only where bytes are actually moving.**

Everything else — waiting for an upload slot, waiting for the backend to read a
document — gets motion and an elapsed time instead. That is not a smaller
promise; it is the true one. `lib/upload-progress.ts` encodes it as
`isDeterminate(phase)`, and every bar on the surface asks it before choosing a
track. The accessible half is the same: an indeterminate `role="progressbar"`
omits `aria-valuenow`, which is exactly what ARIA reserves it for.

The phase model:

| phase | what the user is waiting for | measurable? |
|---|---|---|
| `queued` | a free upload slot | no — elapsed only |
| `uploading` | bytes leaving the machine | **yes** — real byte percentage |
| `processing` | the backend reading and indexing | no — sweep + elapsed |
| `ready` / `failed` / `canceled` | nothing | terminal |

`queued` and `uploading` are told apart by `uploadStartedAt`, not by the byte
count: with a bounded number of slots most of a large batch is genuinely
waiting, and a file that has a slot but has not fired its first progress event is
still uploading. Guessing from bytes conflates the two and makes the ninth file
of nine look stalled at zero.

The batch bar tracks **bytes, not file count**. A typical batch is one 150 MB IFC
model and a dozen 200 KB PDFs; a count-based bar leaps to 92% and then appears to
hang for a minute — the same lie in a different costume.

## What changed in the transport

| | before | after |
|---|---|---|
| Progress | none (`fetch`) | real bytes (`lib/http/xhr-upload.ts`) |
| Concurrency | serial `for … await` | 3 in flight (`lib/upload-queue.ts`) |
| Cancel | none at all | per file and whole batch |
| One file fails | batch aborts at that file | that row fails, the rest continue |
| Client upload paths | two (XHR *and* `fetch`, drifted) | one shared helper |

The serial loop was the expensive part. Each POST also writes to object storage,
checks the org storage quota and dispatches to the ingest API, so a twelve-file
Einreichung took the **sum** of twelve round trips on a link that was idle for
most of each one. Three at a time collapses wall-clock toward the slowest single
file. Three, not more: browsers allow six connections per host and the
ingest-status poll shares that budget, and beyond three the per-file rate just
divides — a single upload already saturates a typical office uplink.

Progress events are coalesced (`shouldEmitProgress`) to one percent of the file,
floored at 64 KB. The browser fires them every ~50 ms per request; without the
gate, three concurrent uploads meant sixty store writes a second to move a bar by
a third of a pixel.

## Nielsen's heuristics, applied

The surface was designed against the ten usability heuristics rather than
decorated afterwards. Where each one landed:

1. **Visibility of system status.** The whole point. Real byte percentage, phase
   named in words, transfer rate, ETA, elapsed time; the headline sits in an
   `aria-live="polite"` region so phase changes are announced while the
   per-second byte counter never is.
2. **Match between the system and the real world.** "Waiting", "Sending",
   "Reading", "Citable" — not `pending`, `ingesting`, `success`. "Citable"
   answers the question a compliance user is actually asking. Sizes, speeds and
   durations are formatted in the app's locale, not the runtime's.
3. **User control and freedom.** Cancel one file, cancel the batch, retry one,
   retry all failed, dismiss. Before this change there was **no way to cancel an
   upload at all** — a 150 MB model uploaded by mistake had to be waited out.
4. **Consistency and standards.** The same extension chip identifies a document
   in the tray, in the explorer list and in the preview header. Status wording
   comes from the one `document-status` map. Indeterminate progress follows the
   ARIA pattern rather than inventing one.
5. **Error prevention.** Validation still runs before a byte is sent; the
   concurrency cap keeps the connection pool from starving the status poll; a
   per-file abort handle means cancelling one file cannot cancel another.
6. **Recognition rather than recall.** Every file the user dropped appears as a
   named row immediately — before any network call — so nobody has to remember
   what was in the selection. The explorer's sorted column is marked with an
   arrow *and* `aria-sort`.
7. **Flexibility and efficiency of use.** Three views (cards / list / folders),
   remembered per browser. The list is fully keyboard-navigable with a roving
   tabindex, and sorts filenames with a numeric collator so `Plan_2` precedes
   `Plan_10` — a set of drawings is numbered, and lexicographic order scatters it.
8. **Aesthetic and minimalist design.** A settled row collapses to a single line,
   so a batch visibly gets quieter as it lands instead of holding twelve
   animating bars. A wholly successful batch retires itself after six seconds.
   The preview pane lost a footer band that restated the page count already in
   the rail.
9. **Recognize, diagnose, recover.** The server's own reason ("File exceeds the
   100 MB upload limit") lands on the row that owns it, with retry beside it. A
   cancelled file reads as a decision, not a failure — it never colours red.
10. **Help and documentation.** The processing line says *"Indexing — no time
    estimate, you can keep working"*, which is the help a user needs at exactly
    the moment they would otherwise sit and watch.

Beyond Nielsen:

- **Doherty threshold.** Rows appear on drop, before the collection is even
  resolved — the acknowledgement is never behind a network call.
- **Goal-gradient.** Byte-based batch progress moves smoothly rather than
  jumping, so the sense of approach is continuous.
- **Peak–end rule.** The journey ends on a confirmation ("12 documents added",
  plus the per-document *citable* toast) rather than on a bar that vanishes.
- **Jakob's law.** The tray is the transfer panel every browser and file manager
  already has; the detail view is the Explorer/Finder list every professional
  already knows.
- **Fitts's law.** Row actions and list rows grow their targets under
  `pointer-coarse`. So do the sort headers, the upload tray's expand control and
  the preview's tag field — all of which were mouse-sized until they were
  measured rather than read.
- **The list truncates rather than scrolls.** The detail view is a real `<table>`
  and it is `table-fixed`, which is what makes the `truncate` on every filename
  cell mean anything: under the browser's default auto layout a column is sized
  to its content's minimum, a filename does not wrap, so the Name column laid out
  437px wide inside a 308px phone wrapper and the reader had to drag the list
  sideways to find out what a document was called. Dropping the reference
  columns at `sm`/`md`/`lg` never touched that — it removes the columns that were
  not the problem. Anything added to this table declares a width, or it is the
  one `w-auto` column that absorbs what is left.

## The preview pane

Same lens, applied to the surface that opens when a document is clicked:

- **The AI summary is promoted.** It is the answer to "does the agent actually
  understand this file" and it used to be one more 12.5px paragraph read at the
  same weight as the MIME type. It now sits on its own raised card under its own
  section label.
- **One fact list, not two.** Type and size used to sit in a separate block
  *below the tags*, divorced from the page count they belong with, purely because
  one group was behind a feature flag and the other was not. The flag now gates
  **rows**, which is what it was always about.
- **The document sits on something.** A soft vertical ground with the page raised
  on a real shadow, instead of a flat grey box — which is what a drawing on a
  desk looks like, and the reason this column exists rather than a download link.
- **The fake page is gone.** The "no inline preview" state used to draw skeleton
  paragraph bars — permanently, for a file whose contents cannot be shown at all.
  That is decoration pretending to be content; on a compliance surface a reader
  glancing at it sees "a document" and moves on. Skeleton bars now appear only
  while a preview is genuinely loading.

## The card of a document that is still being read

**Screenshot evidence:** `frontends/ui/visual/screenshots/file-browser-uploading.*.png`
(`/dev/file-browser?variant=uploading`)

> "Whilst uploading, but the preview is already available, it looks weird."

The preview being there was never the problem — a PDF thumbnail is produced at
upload time while the rest of ingestion runs after it, so a card can legitimately
show its page render under a *Processing* badge. What looked wrong was the tile
around it.

An unsettled document has **no AI summary yet**. Its settled neighbours do, so
they are taller, and a CSS grid row is as tall as its tallest cell — every other
cell stretches to match. `FileCard` filled that stretched cell with a
fixed-height content block, so the leftover height collected at the *bottom*:
the `size · time` footer floated in the middle of the tile with a band of dead
surface underneath it, and the footers in a row did not line up. The card looked
half-drawn at exactly the moment the user was watching it most closely.

Two things changed, and the order matters:

- **The description slot is held, not left blank.** Two skeleton bars occupy the
  two lines the summary will land on, exactly as the thumbnail well shows a
  skeleton while its request is in flight. An empty gap reads as a card that
  failed to render; a skeleton says the sentence is coming. It is `aria-hidden`
  — the badge beside the thumbnail already says *Processing* in words, and a
  screen reader should hear that once rather than twice. It is shown only for a
  settling status: a `failed` document shows its reason, and a settled document
  with genuinely no summary shows nothing rather than a bar that will never fill.
- **The raised white block is `flex-1`**, so it absorbs whatever height the
  stretched cell has left and the footer tab sits on the bottom edge of every
  card. A skeleton is close to the height of the sentence it stands in for but
  never exactly it, and a two-line summary next to a one-line one has the same
  problem — so the row still needs the block to grow. The same block in
  `DocumentGridCard`'s unresolved tile got the same treatment, for the same
  reason. This is a property of the shared card, so the Büroarchiv library (a
  thin wrapper over `FileCard`) is fixed by the same change.

**The second half of the same moment:** the thumbnail cache treated "no
thumbnail" as permanent. If the page rendered a second before the backend
produced the preview, the card cached that miss for the whole page lifetime and
kept the sketch placeholder until a reload — the settling poll refreshed the row
but never re-asked the route. A miss for a document whose status is still
settling (`isSettlingStatus`, now shared with the poll in
`document-status.tsx`) is now provisional: it is evicted, and the status
transition to `ready` re-asks. Terminal statuses keep the cached miss, so a
document that genuinely has no thumbnail still costs one request.

## One byte formatter, one byte convention

There were two functions computing the same quantity differently:
`formatBytes` (decimal, 1000-based) and `formatFileSize` (binary, 1024-based).
So a 1,048,576-byte document read as **1.0 MB** on its card and contributed
**1 MB** to the org's storage figure, and an administrator's 1 GB quota rendered
as 0.93 of itself. Each copy looked locally correct, which is what makes a fork
like this survive.

The mismatch went deeper than display. Upload ceilings were computed as
`MB * 1024 * 1024`, so `FILE_UPLOAD_MAX_SIZE_MB=100` actually admitted
104.9 MB — while the storage quota beside it used `BYTES_PER_GB = 1e9`. The
binary formatter then printed that binary limit as "100.0 MB", so the two errors
cancelled and the inconsistency stayed invisible. Fixing either half alone makes
the enforced limit and the sentence describing it disagree, so both moved:

- `formatBytes` is now the only byte formatter (`lib/format.ts`), absorbing the
  nullable input and the `0 B` zero case the deleted one handled. The byte tier
  is the one place Intl does not own the unit word — CLDR's short form for
  `byte` is the literal word ("878 byte"), which reads as a typo in a column of
  "4.8 MB".
- `BYTES_PER_MB = 1e6` (`shared/config/request-body-limit.ts`) now backs the
  document ceiling, the IFC ceiling, the transport limit and the client-side
  fallback constants, matching `BYTES_PER_GB` on the storage side.

**Behavioural consequence, stated plainly:** the effective upload ceiling drops
~4.9% (104.86 MB → 100.00 MB for a deployment configured at 100), and likewise
the IFC ceiling (262.1 MB → 250.0 MB). That is the limit becoming the number the
administrator actually configured. Raise the env var if the old headroom was
being relied on.

## Where the code lives

| Concern | Module |
|---|---|
| Byte-level upload transport (the only XHR in the app) | `src/lib/http/xhr-upload.ts` |
| Phase model, batch summary, rate/ETA estimator | `src/features/documents/lib/upload-progress.ts` |
| Bounded-concurrency batch runner | `src/features/documents/lib/upload-queue.ts` |
| Explorer ordering (numeric collator, status rank) | `src/features/documents/lib/file-sort.ts` |
| Upload surface | `src/features/documents/components/upload-tray.tsx` |
| Explorer detail view | `src/features/documents/components/file-list-view.tsx` |
| The shared document card (grid anatomy, thumbnail loading) | `src/features/documents/components/file-card.tsx` |
| Status semantics + the settling predicate both the poll and the card read | `src/features/documents/components/document-status.tsx` |
| Orchestration (validation, fan-out, cancel, polling hand-off) | `src/features/documents/hooks/use-file-upload.ts` |

The logic is in plain modules with their own fast specs rather than inside the
components, per the note on `InputArea.spec.tsx` in `AGENTS.md`: the entire
progress model is exercised without a clock, a DOM or a React tree.

## What this does not change

- The backend ingest pipeline and its job-status API are untouched. The
  `progress_percent` it reports is still stored on the tracked file; it is simply
  no longer drawn as a bar, because it is not a position.
- Session (chat) uploads still send the whole batch as one multipart request —
  that is the collection API's contract. The single progress stream is split back
  out per file in wire order (`distributeBatchBytes`), which is not an
  approximation: multipart sends its parts in order.
- Validation, quotas, tenancy and authorization are unchanged.
