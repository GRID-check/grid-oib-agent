# UI/UX Triage — July 2026

A full heuristic evaluation of the Piloti/GRID app (excluding the marketing
page), run against Nielsen's 10 usability heuristics plus the supporting laws
(Fitts, Hick, Miller, Jakob, Gestalt, Tesler's conservation of complexity,
aesthetic–usability, peak-end) — read through *value* and *actual user flow* for
an architect doing Austrian building-compliance work under enterprise scrutiny.

Every recommendation stays inside the existing design language
(`grid-design-language.md`): warm-paper monochrome + provenance signal colors,
tokens only. This is refinement within the system, not a redesign — the app is
already unusually mature (streaming status, EU AI-Act disclosure, iOS-zoom
prevention, safe-area insets, per-session drafts, HITL, drag-drop upload).

Status legend: **[done]** landed this pass · **[backlog]** recommended, needs
product/visual sign-off on a running app, or is larger follow-up work.

## Shipped this pass

1. **Chat trust** — confidence no longer borrows the provenance palette (it now
   renders through the shared neutral `ConfidenceChip`); the invisible
   failed-upload dot (`bg-error`, an undefined utility) is restored.
2. **`ConfirmDialog` primitive** — one shared confirm component; the off-brand
   `window.confirm` for BYOK revoke and four copy-paste delete/stop modals now
   route through it.
3. **Shell** — the built-but-never-mounted `ConnectionPresenceIndicator` is now
   in the sidebar + mobile drawer, so a dropped connection is visible.
4. **Intake** — the autosaved draft moved from `sessionStorage` (dies on tab
   close) to `localStorage`, making "Entwurf gespeichert" truthful; the four
   hard-required fields now carry a required marker.
5. **Documents** — the terminal status says "Citable"/"Zitierbar" instead of a
   bare "Ready"; the chat File-Sources empty state uses the crafted `EmptyState`.
6. **Apple-tier coherence pass** — foundation-level visual craft that propagates
   system-wide: 3-layer elevation stacks (contact + mid + ambient) on the shadow
   scale; `ConfirmDialog` tinted-disc header; `EmptyState` raised light-catching
   icon disc; and the completed-answer "Ergebnis" card unified into one sectioned
   object (answer body + provenance footer divided by a hairline, no floating
   inner card). Verified in light + dark via `/dev` previews (`chat-turn`,
   `herleitung`, `confirm-dialog`).
7. **Herleitung** — the collapsed reasoning trace is now a real streamed React
   Flow node graph (framing → parallel source fan-out → assessment → branches).
   The live status phrase derives only from an *in-progress* step (a finished
   web search no longer keeps shimmering "Searching the web …" while the LLM
   composes); an "Ausgeführt:" chip row shows what actually ran (Einordnung ·
   Websuche · OIB-Korpus · RIS …) with a pulse on the active step; edges animate
   while the turn streams; and on narrow widths the source cards stack inside
   one grouped Quellen node so connectors stay straight and centred (no slanted
   or card-piercing edges). wien.gv.at (MA 37 / Baupolizei Wien) lanes as
   "Behördliche Information" (Baurecht family), never as a web hit.

Everything below marked **[backlog]** is the prioritized remainder.

---

## Cross-cutting root cause: structural DRY

The token layer is strong (shadows 100% on-token, zero emojis in UI, exemplary
`SourceSignalChip`). The failure mode is **the same concept hand-rolled many
times, each copy drifting slightly** — the root of most consistency findings.

| Pattern | Inline copies | Primitive |
|---|---|---|
| Destructive confirm dialog | 5 copy-paste modals + 1 `window.confirm` | **`ConfirmDialog`** [done] |
| Page header (`<header><h1>…`) | 15–16×, drifted 5 ways | `PageHeader` [backlog] |
| Eyebrow / section label | ~39×, 4 tracking values | `SectionLabel` [backlog] |
| Numeric stat tile | 11 sites, inconsistent `tabular-nums` | `StatCard`/`StatValue` [backlog] |
| Project-section nav list | 2–3 drifted configs (rail ≠ ⌘K) | shared `PROJECT_SECTIONS` [backlog] |
| Async load→error→skeleton→content | ~7× hand-rolled in admin cards | `useResource`/`AsyncCard` [backlog] |
| Files vs Archiv workspace | ~80% duplicated | `useDocumentWorkspace` [backlog] |
| Inline `Loader2` | ~75× (bypasses `Spinner` a11y) | adopt `Spinner` [backlog] |
| Pill/chip variants | 9+ overlapping | fold into `Chip` + `SourceSignalChip` [backlog] |

The doc↔code radius contradiction (doc says `rounded-lg`; primitives ship
`rounded-2xl`/`rounded-3xl`; inline cards use 3 radii + 17 arbitrary
`rounded-[Npx]`) is **[backlog]** — it needs one visual decision on a running
app before changing 118 sites. Once `PageHeader` exists, the `text-2xl` vs
documented `text-xl` title-size question becomes a single knob.

---

## Chat — the core value loop (priority)

- **[done] P0 · Provenance colors hijacked to encode confidence.** `CONFIDENCE_SIGNAL`
  painted high-confidence green and medium gold — the exact colors that mean
  *Projektwissen* / *Büroarchiv* provenance everywhere else, laundering a model's
  self-assessment in the visual language of sourced evidence. Now renders through
  the shared neutral `ConfidenceChip`; `--source-*` is reserved for real citations.
- **[done] P2 · Invisible failed-upload dot** (`bg-error` → `bg-danger`).
- **[backlog] P0 · Answer is center-aligned** while its question (right) and
  reasoning (left) are not — the peak moment is spatially orphaned and breaks the
  left-aligned-assistant convention. High visual blast-radius; wants a
  running-app look first.
- **[backlog] P1 · No retry when an answer errors** (`ErrorBanner` is dismiss-only) —
  add an `onRetry` wired to a last-user-message resend.
- **[backlog] P1 · Empty state has a greeting but no example questions**;
  **ungrounded answers hide their lack of sources** (render an honest
  `--source-auto` gap row); **composer fully disabled while busy** (allow
  drafting, gate only send); **`AgentPrompt` still uses old bubble anatomy**;
  two source-chip vocabularies; `SIGNAL_ICON` defined 3×.
- **[backlog] componentization** · `AgentResponse` inline/default variants
  duplicate ~130 lines → `AnswerBody`/`ViewReportButton`/`AnswerProvenanceFooter`;
  `ChatArea` per-turn derivation → `useTurnState`.

## Navigation / shell / mobile

- **[done] P1 · Orphaned `ConnectionPresenceIndicator`** — now mounted in the
  sidebar + mobile drawer (was built, tested, never rendered).
- **[backlog] P1 · Rail and ⌘K palette are two drifted nav configs** — ⌘K can't
  reach Workflows; same destinations use different icons. Unify onto one shared
  `PROJECT_SECTIONS`.
- **[backlog] P1 · "Resume where you left off" is half-wired** — the section is
  recorded on every nav (`useRecordProjectSection`) but every entry point
  hardcodes `/chat`, and `useResumeProjectHref` has no callers. The project-card
  inline comment cites spec §5 ("always lands on Chat"), which *contradicts*
  resume — so this needs a product decision: wire `useResumeProjectHref` into the
  card/switcher, or delete the write-only recording. Not guessed here.
- **[backlog] P1 · Collapsed rail erases project identity** (switcher hidden when
  collapsed); **Archiv is a context-ejecting doorway** with no divider.
- **[done] M · Mobile touch targets < 44px** — this was never only the core
  loop. An audit of all 67 preview surfaces at 390×844 with touch emulation
  found ~210 controls under the floor, 92 of them at exactly 32px, because the
  shared primitives are sized for a cursor (Button `h-9`/`h-8`/`size-9`, Select
  `h-10`/`h-8`, dialog close `size-8`, menu rows `py-1.5`, tabs `h-9`) and every
  surface inherits it. Fixed in the primitives on a `pointer-coarse` axis, with
  a `touch-target` utility (globals.css) for controls that must STAY small — a
  16px checkbox, a 20px chip — which get a 44px catchment instead of a 44px box.
  The five earlier `md:`-based sites are converted onto the same axis, so
  `md:` means layout and `pointer-coarse:` means input device. 15 of 67 surfaces
  still report, all deliberate: inline mention pills and citation markers in
  running prose (the WCAG 2.2 inline exception), a 24×24 source chip that meets
  the AA minimum, and one chip-internal icon button capped at 36px by its chip.
  Guarded by `src/components/ui/touch-target.spec.ts`.

  **Corrected by the pass below.** "All deliberate" did not survive re-measuring.
  The Herleitung's source row — the control the whole surface exists to offer —
  was 290×19 because a `p-0` override on the shared chip stripped away the
  padding that had been its target, and it was not on anybody's exception list.
  More to the point, the audit that produced this entry measured SIZE, so it
  could only find defects that are about size; the reachability and layout
  failures below were invisible to it.
- **[done] M · The three mobile failures a size audit cannot see** — a second
  pass over the customer-facing surfaces (chat, projects, Archiv, Postfach,
  files; not Plattform) at 390×844, with `visual/touch-audit.mjs` — the harness
  that pass produced, and the reason the numbers here are measured rather than
  read off the markup.

  1. **Reachable at all.** `opacity-0 group-hover:opacity-100` is the whole
     affordance of a reveal, and a touch device cannot generate a hover. Copying
     your own message and deleting an attached source were mounted, focusable and
     permanently invisible on a phone. `project-memory-panel` already had the
     escape (`pointer-coarse:opacity-100`); two sites had never adopted it.
  2. **Laid out at all.** The Files/Archiv list rendered its Name column 437px
     wide inside a 308px wrapper: `truncate` cannot fire under `table-layout:
     auto`, because auto layout sizes a column to its content's minimum and a
     filename does not wrap. The Table primitive's `overflow-x-auto` caught the
     overflow, so nothing looked broken — the reader simply had to drag the list
     sideways to read a filename. `table-fixed` is the fix. The PDF viewer's
     toolbar was the same shape of bug at page level (445px inside 390).
  3. **The keyboard.** `enterKeyHint` appeared nowhere in `src/`. The composer's
     return key was drawn as a newline and wired to send; search fields ran a
     semantic search off a key labelled "go". Three raw `<input>`s were under
     16px, which makes iOS Safari zoom the page in on focus and never zoom back
     out — including the field that renames the conversation you are reading.
     Search fields also inherited the phone's autocapitalize and autocorrect,
     which edit a query on its way into a matcher.

  Plus the bespoke controls in `features/` that the primitive-level pass could
  not reach: citation markers, mention pills, card disclosures, the four
  card list rows (now one `CARD_LIST_ROW`), the report outline, sort headers,
  file chips. Inline markers in prose grow but stay under 44 on purpose — 44px
  catchments on two adjacent citations overlap, and the later one in the DOM
  takes every tap meant for the earlier, which is worse than a small target.
  See the note in `CitationMarker.tsx`.

  Ratcheted by `src/components/ui/mobile-affordances.spec.ts` (hover reveals need
  a touch escape; hand-written fields need the 16px floor; the shared molecules
  declare their `enterKeyHint`) and by `task fe:touch-audit`, which is the
  measurement half and is deliberately not in `verify`.
- **[done] M · Mobile drawer focus trap** — `app-sidebar.tsx` cycles Tab and
  Shift-Tab inside the panel, restores focus to the opener on close, closes on
  Escape and locks background scroll. (Noted here because the line above claimed
  otherwise long after it shipped.)
- **[backlog] M · Shell chrome leftovers** — top bar shows the section but not
  the project; **dead `heading` prop on `OrgTopbar`**; two shell frames differ
  in height (h-16 vs h-14).

## Project intake wizard

- **[done] P0 · "Entwurf gespeichert" was a broken promise** — draft moved from
  `sessionStorage` to `localStorage`.
- **[done] P0 · Required fields carried no signal** — added the required marker.
- **[backlog] P0 · Consistency check fires only at the very end** — run the
  deterministic checks per-stage as calm in-context help; **no exit / save-and-
  leave** (a room with one door, acute in edit mode).
- **[backlog] componentization** · the 1601-line monolith → extract field
  renderers, `BauwerkStage`, `ReviewStep`, `ConflictFindings`, `IntakeStepper`,
  and `useIntakeDraft`/`useStageValidation`/`useIntakeSubmit`. Reuse the `Chip`
  primitive instead of the hand-rolled `Segmented`/`ChipMultiSelect`. Share a
  `FactGrid` between `project-brief` and the wizard Review.

## Documents / knowledge / archiv

- **[done] P0 · Status wording never said "citable"** — reworded from "Ready".
- **[done] P1 · Chat File-Sources empty state was bare text** — now `EmptyState`.
- **[backlog] P0 · Ingestion completion is silent** — the instant a document
  becomes citable fires no confirmation; add a provenance-correct success toast.
  Best landed with the `useDocumentWorkspace` extraction so it fires once across
  both the project and Archiv workspaces (currently ~80% duplicated).
- **[backlog] P0 · Grid has no live status once the client orchestrator is gone** —
  a doc still ingesting server-side shows a "Processing" badge that never
  advances; add polling / a refresh affordance.
- **[backlog] P1 · Delete button is mis-composed** — `DeleteDocumentButton` is
  authored `w-full mt-2` but rendered inline in an `items-center` header row;
  move it to the metadata action column. Download-failure dead-end (no retry);
  `Sparkles` leans generic-AI; semantic relevance UI is provenance-blind.
- **[backlog] componentization** · `file-preview-pane` (663L) → `DocumentTagsSection`
  + `usePreviewDocument`; Files/Archiv workspaces → `useDocumentWorkspace` +
  `DocumentWorkspaceShell`.

## Organization / platform admin (enterprise safety)

- **[done] P1 · `window.confirm` for credential revoke** — now the shared
  `ConfirmDialog`.
- **[backlog] P0 · Turning OFF Zero-Data-Retention is a silent one-tap toggle** —
  gate the *disable* path behind a consequence-spelling confirm (now trivial with
  `ConfirmDialog`).
- **[backlog] P1 · Runtime model rollback/reset applies instantly, whole-org, with
  no confirm** (while the reversible authoring path *is* gated — inverted
  friction); **ingestion polling ends silently after its ceiling**; **binding-OIB
  delete has the same friction as any upload**; **norm editor is a 20-field wall**
  (no progressive disclosure); **nested Card** violates the guardrail;
  **credential/URL entry isn't forgiving** (untrimmed key, unnormalized base URL).
- **[backlog] P2 · Page titles are `text-2xl`** (doc says `text-xl`); negative
  budget limits silently swallowed; no unsaved-changes guard.
- **[backlog] componentization** · shared `useResource`/`AsyncCard`,
  `SettingsCard`, `ListRow`/`MicroStat`; split `base-knowledge` (814L),
  `budget-usage-card` (706L), `norm-registry` (953L) into composition.

---

## Recommended follow-up sequence (post-this-pass)

1. `ConfirmDialog` is now available → land the admin safety confirms (ZDR disable,
   whole-org model rollback) — small, high-value.
2. Chat: answer left-alignment + example-question chips + error-retry — with eyes
   on a running app.
3. `PageHeader` + `SectionLabel` + `StatCard` primitives, then roll out (settles
   the title-size question as one knob).
4. `useDocumentWorkspace` extraction → then the ingestion-completion toast + grid
   live-status land once, for both workspaces.
5. Intake per-stage consistency + save-and-leave, then the wizard componentization.
6. Nav-config unification; mobile touch-target + focus-trap sweep; radius
   source-of-truth decision.
