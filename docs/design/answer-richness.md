# Answer richness: the plan

Status: adopted 2026-09-28, Phase A in progress. Decision record:
[ADR-0069](../adr/0069-the-answer-is-markdown-and-a-card-must-earn-its-place.md).

Produced by six design lenses (the planner's jobs, information design outside
AI chat, project-aware answers, living and interactive answers, long-horizon
architecture, a critic) and one synthesis. The lead's adjustments come first;
the synthesis follows below them.

## Lead's adjustments

- **Priority inside Phase A:** the trust mechanics ship before new blocks:
  the splitter fix, computed-outcome-wins reconciliation and `:projekt[key]`
  binding first, then `:::massnahmen` and `:::fehlanzeige`.
- **Guardrails 1, 5, 7 and 11 are acceptance criteria**, not aspirations: a
  block that breaks one does not merge.
- **Deep research waits for the PDF.** A report is filed as a PDF, and the
  PDF pipeline prints a `:::` line as text. The deep writer is taught the
  dialect in Phase B, together with the PDF renderer that draws the blocks;
  until then reports stay plain GFM with mermaid.
- **From `claude/relaxed-rubin-pvwcsn` (not merged; it deepened the retired
  `legal_basis` card):** two of its ideas join Phase A. `:::subsumtion` lays a
  ruling out as Norm (the verified quote line) → Sachverhalt (`:projekt[…]`
  facts, their origin shown by the chip) → Ergebnis (a status). And every
  quote line `> „…" [N]` gets a server-side location stamp (its
  `cards/legal_proof.py` `verification_for`, reused): „Wortlaut belegt [N]"
  and „Stelle öffnen" with the sentence marked, never on the model's word.
- **Measured, not asserted:** every wave reruns the before/after probe on the
  real static prompt: rich blocks per answer up, duplicate forms at zero, and
  a negative set of short factual questions answered with no block at all.

---

# Piloti answers: the plan for richer blocks

## 1. The vision

1. An answer is a page with a masthead: the verdict value, then a thin Projektbezug strip showing the facts it rests on ("Wien · GK 4 · Fluchtniveau 10,8 m · Wohnen"). The renderer draws those values from the project record, and a fact the answer needs that is still missing shows as a hatched "fehlt – ergänzen" chip.
2. Below it are a one-step-larger lead sentence, then at most one or two blocks chosen by the shape of the content. Each block carries its own `[N]`, and the renderer computes whatever it can: status, bars, the matching case, measured values.
3. On wide screens the evidence sits in a margin level with the claim: Randziffern, source notes with edition and "bindend", and the verified excerpt with its decisive words glossed by the project's own value. On a phone the margin folds back into chips.
4. Every open item ends in an action. A Maßnahmen list names roles, Fristen and Fundstellen. Each open row offers "Dazu fragen" and "Als Aufgabe", and each proposal sits inside the row it would change.
5. The whole page files, prints and copies as a document an office would sign: resolved values, a Grundlagen list with editions, and no handles. Because the renderer derives the drawn values and a validator checks them, the richness adds trust instead of spending it.

## 2. The block system

Five primitives (matrix, sequence, disclosure, excerpt, chip) sit behind the names below. Every name is one registry row.

**Project binding (inline). The model names a key; the renderer prints the value.**

- **`:projekt[key]`**
  - *Renders:* a value chip from the profile. Solid means confirmed, dashed with "Annahme" means an agent assumption, hatched amber "fehlt · ergänzen" means unknown and opens a `project_profile_patch`.
  - *Data:* profile facts with source and `updatedAt` (`lib/project-profile/types.ts`), and the unknowns and assumptions in `project_context.py`.
  - *Use:* whenever a sentence turns on a project fact.
  - *Don't:* type the number yourself. An unknown key renders as plain text.
  - *Merged:* the `:offen`, `:bezug` and `:wert{aus=…}` ideas are folded into this.
  - *Cut:* `:wert[10,8 m]{aus=…}`. It lets the model type a value and then needs a server check to catch it; `:projekt` removes the typed value altogether.
- **`:messwert[M3]`**
  - *Renders:* a measured value with its tolerance and a provenance tag (gemessen, deklariert, or a hollow "vermutlich"). Hovering lights the source elements. It is a display link and never a citation.
  - *Data:* `tools/bim/measurement_sources.py` and `MeasurementFacts` exist. Missing: a handle in the tool output, and a lookup from handle to record on the wire.
  - *Unknown handle:* renders "nicht gemessen" in red, never text the model wrote.
- **`:klasse[B]`:** stays as it is.

**Matrix blocks, with column roles declared in the registry:**

- **`:::pruefung`**
  - *Use when:* three or more criteria each have a status.
  - *Renders:*
    - a tally line ("7 erfüllt · 2 offen · 1 nicht erfüllt");
    - rows sorted by margin to the limit, each as a bullet graph with the reserve in tabular figures;
    - IFC element chips in the Nachweis cell (`ifc-element-chip.tsx`);
    - when every row passes, the rows collapse to "4 von 4 erfüllt".
  - *Status:* when the renderer can compute the outcome (`quantities.ts` `meetsLimit`), that outcome wins. If the model's word disagrees, the row shows "Widerspruch – prüfen" and the tally reads "ungeklärt".
  - *Later (Phase B):* rows headed `:regel[id]` get their Ist, Soll, status and missing CAD property from `lib/bim/rules.ts`. This replaces the `ifc_compliance` card in prose answers.
- **`:::faelle{nach=gebaeudeklasse|fluchtniveau_m}`**
  - *Use when:* there are two or more mutually exclusive cases and the deciding factor is known or explicitly open.
  - *Marking:* with `nach` set, the renderer marks "trifft zu" from the profile. A model-written `:trifft` that disagrees is dropped and logged.
  - *Schwellen-Lineal:* when the case column parses as numeric ranges, the renderer draws a scale with the class ticks and a pin at the project's value, e.g. "0,2 m unter GK 5". If it doesn't parse, the table stays a table.
  - *Don't:* use it for a single conditional; write the condition in prose.
- **`:::kennzahlen`**
  - *Use when:* there are 2–4 figures, each with a limit or a comparison.
  - *Contract:* the same pill-versus-bar reconciliation as `:::pruefung`. Values should be `:projekt`, `:messwert` or `calculation` results.
  - *Placement:* in the first block, it joins the masthead as a stat strip.
- **`:::vergleich{art=varianten|abweichung|aenderung}`**
  - *Use when:* there are two or more columns on three or more attributes.
  - *Modes:*
    - `varianten` puts the recommended variant (`:empfohlen`) in a highlighted column, and requires a reason in the prose.
    - `abweichung` strikes the OIB value through next to the Land's value; both citations are required.
    - `aenderung` draws a slopegraph when the values are numeric and falls back to a table with status marks otherwise.
  - *Merged:* `:::abweichung` and `:::aenderung` were cut as separate names; each is a mode here.
- **`:::massnahmen`** (new)
  - *Renders:* a table Wer | Was | bis | Fundstelle.
  - *Wer:* roles only (Planer, Bauwerber, Behörde, Statiker). A person's name is refused.
  - *"Als Aufgabe":* pre-fills the composer so that the agent's `create_task` (ADR-0051) creates it. It adds no new write path.
  - *Use:* for Prüfung, Verfahren, Fehlanzeige and project questions that have open items.

**Sequence:**

- **`:::verfahren`**
  - *Use when:* three or more ordered steps carry an actor or a Frist.
  - *`:aktuell`:* only kept when the project or the conversation establishes the step; otherwise it is stripped and logged.
  - *`:::details[Unterlagen]`:* becomes a table marked vorhanden/fehlt, matched against the project files (Phase B).
  - *Dates:* no Frist projections. Dates appear only where a document states them.

**Documented negative:**

- **`:::fehlanzeige`** (new)
  - *Renders:* three panes: "Gesucht in", "Nächstliegende Regel" and "Entscheidet".
  - *"Gesucht in":* filled from the turn's tool trace (`Transparency.tsx`), not written by the model.
  - *Use:* only when the verdict is "Nicht geregelt" or partial.

**Overview:**

- **`:::ueberblick`** (Phase B)
  - *Renders:* a tile index of the parts of a Regelwerk, each with a "betrifft Ihr Projekt" badge and its `[N]`.
  - *Relevance:* computed from `common/applicability.py` (mirrored in `lib/oib/applicable-standards.ts`), not claimed by the model.
  - *Rule:* replaces the mindmap in the same answer, never sits beside it.

**Disclosure and excerpt:**

- **`:::details`:** unchanged. Print output shows it open.
- **Excerpt** `> „…" [N]`
  - Adds `==decisive words==`, which the server strips before the verbatim check (ADR-0067); an unbalanced mark is rejected.
  - An optional `:projekt[key]` right after the quote becomes the gloss in the margin.

**Diagrams and cards:**

- **Mermaid:** kept.
- **Schematics, calculation, IFC, proposal, draft, task and surface cards:** all stay. Each becomes a registry entry with a required Markdown fallback.

**Leaf directives the renderer resolves:**

- **`::stand{seit=vorige}`** (Phase B): revision delta, rules whose verdict changed, and confirmations that do not carry over to the new revision. Data: `revision-series.ts` and `compliance-diff`.
- **`::ansicht[M3]`** (Phase C): a plan cut with the affected elements highlighted. It needs a new plan endpoint (ADR-0055).

**Cut:**

| Idea | Why |
|---|---|
| `:::entwurf` | The `document_draft` card already holds the draft. Give it the paper styling instead, which keeps one form per fact. |
| Case lens GK toggle | A rehearsal state that a reader can mistake for the project state, and it needs a limit column per class. |
| Pin-block | Filing covers it. |
| Frist calendar | When a Frist starts depends on the procedure, and the prompt already forbids computed dates. |
| Authored `:::rand` or grid layouts | That brings back the model designing pages (option 4, which ADR-0069 rejected). |
| `:::laender` | Deferred to Phase C. It needs a curated table of Land × Richtlinie × edition, and stale data drawn as authority is worse than none. |

## 3. Answer-level composition

**The frame.** The renderer composes the page from the registry's placement rules; the model never writes layout. From top to bottom:

1. Masthead: the value, the topic and the summary.
2. Projektbezug strip. It shows the facts the answer read through `:projekt`, plus any the masthead lists in its `projekt:` field. When the profile has changed since the answer (by `updatedAt`), it shows "Projektstand seit dieser Antwort geändert".
3. Lead sentence.
4. Blocks, with Randziffern in the gutter.
5. Margin column at 900px or wider: source notes with Punkt, edition and binding status, excerpts, and `:::details[Fundstelle]`.
6. Maßnahmen.
7. Grundlagen: the source register with editions and the RIS Fassung.
8. Follow-ups.

**The Schriftfeld** (project, GK, the IFC model checked and its revision, editions, Stand) appears only when the answer has a `:::pruefung` or an `ifc_*` card.

**Budget by kind:**

| kind | Primary blocks | Diagrams |
|---|---|---|
| `direct` | 0 | 0 |
| `ruling` | at most 1, plus the excerpt | 0 |
| `walkthrough` | at most 2 | at most 1 |

A second block of the same type gets merged.

**Layout by answer type:**

| Type | Sequence |
|---|---|
| Ruling / Grenzwert | masthead → strip → one subsumption sentence → `:::faelle{nach}` with the scale → annotated excerpt → Rechtskette ribbon (Phase B) |
| Prüfung | masthead "1 Mangel" → strip → Schriftfeld → `:::pruefung` → schematic for the one failing geometric row → `:::massnahmen` |
| Verfahren | masthead → `:::verfahren` with `:aktuell` → sequence diagram only if the parties matter → `:::massnahmen` |
| Überblick | masthead → `:::ueberblick` → `:::details` per part |
| Vergleich | masthead with the recommendation → `:::kennzahlen` of the deltas → `:::vergleich` → schematics in `surface` tabs → "Entscheidung festhalten" |
| Project question | masthead → strip with missing-fact chips → schematic or `ifc_element` card → a short `:::pruefung` → `:::massnahmen` |
| Fehlanzeige | masthead "Nicht geregelt" → `:::fehlanzeige` → closest rule as an excerpt → `:::massnahmen` |
| Drafting | a short frame → `document_draft` card |

## 4. Project-aware and interactive features, ranked

1. **`:projekt`, the strip and `faelle{nach}`.** No write path. A missing chip opens the existing `project_profile_patch` card, which stays under ADR-0030.
2. **Row actions.**
   - "Dazu fragen" exists already.
   - "Als Aufgabe" pre-fills the composer, then the agent's `create_task` runs and a `task_created` card appears.
   - "Im Prüfbuch öffnen" appears only on a verified `:regel` id.
   - Never "Im Prüfbuch bestätigen" from chat. That verdict is a signature against a revision the person must have opened.
3. **`:messwert` and `:regel` rows.** The renderer resolves both; they are read-only.
4. **Proposals anchored to the row they change.**
   - The `project_profile_patch` card gains an optional `anchor: {blockKey, subject}`, and its controls draw inside that row.
   - The anchor is drawn only after the block is final. An unmatched anchor falls back to the card slot.
   - The ADR-0030 decision key does not change.
5. **"Entscheidung festhalten"** on the recommended `:::vergleich` column emits a `memory_proposal` of kind `decision` (the kind exists, `cards/models.py:217`). Nothing is written until the person accepts it.
6. **Filing a block.**
   - Generalise `use-diagram-filing.ts`, made idempotent on (answer, source hash, producer) as migration 0065 already does for diagrams.
   - Add a `?block=` parameter to `messages/[messageId]/export`.
   - A filed document carries resolved values, with revision labels.
7. **"Living values."**
   - An old answer shows an amber tag on the block, "Projekt geändert: 10,8 → 11,4 m · neu prüfen".
   - The trigger is comparing the `updatedAt` of each bound key.
8. **Follow-ups anchored to a block.** An optional `anchor` in follow-ups payload v1. Hovering the chip outlines the block; the chip never goes inside the block, because that would reflow text already read.
9. **Compact/full toggle.** View state per viewer in `localStorage`.

**Substrate for items 4–8:** `blockKey = name + ordinal + hash(source)`, carried over while streaming only when the block is byte-identical.

## 5. Architecture

- **Registry.**
  - One file, `shared/answer/dialect.json`, with these fields per entry: name, kind, primitive, body roles, typed attrs, allowed markers and parents, status vocabulary, strip mode, `teach` text, since.
  - Generated from it: the TS constants and Zod schemas (replacing `answer-directives.ts`), the Python tables, the RICH BLOCKS section of `piloti_static.md` (as a Jinja variable), the `catalog.py` refusal strings, and a docs page.
  - CI: `fe:dialect:check`, next to `fe:cards:check`.
- **Conformance corpus.**
  - `shared/answer/dialect-fixtures/`, run by both vitest and pytest.
  - It includes the adversarial cases (`10:30`, `Hinweis:Achtung`, `:::` inside code) and every streaming prefix of every fixture.
  - First fix: `splitMarkdownBlocks` must never cut inside an open container. The architecture lens confirmed that a 25-row `:::pruefung` gets split and its tail rows are lost. The fix reuses the depth tracking in `normalizeDirectiveFences` instead of adding another scanner.
- **Server validator.**
  - Runs after `verify_citations` and before `sanitize_report`, parsing with markdown-it-py and the `container` and `attrs` plugins from mdit-py-plugins.
  - It unwraps unknown names and never deletes content.
  - It checks each body against its contract, and checks that every `[N]` inside a block resolves.
  - It strips markers without provenance and applies the budget.
  - It mirrors `meetsLimit` to catch pill-versus-bar contradictions.
  - It adds `drop_restated_blocks`, the sibling of `drop_restated_mindmaps`.
  - It rewrites fences canonically.
  - Repairs go into `ReportSanitizationResult`; the census goes to trace metadata.
- **Streaming.**
  - The tally and the bars wait for the closing fence, and their space is held from the start.
  - A spec renders every prefix and asserts the block's height never shrinks.
- **Copy, export and print.**
  - Handles become their resolved values.
  - Bars carry numeric labels and an accessible name ("57 dB, Grenzwert ≥ 55 dB, erfüllt").
  - `:::details` prints open, and nothing prints twice.
- **Telemetry.** The server census by kind and skill, plus client events: "Dazu fragen", opening a `details`, filing, copying. A block nobody opens is ballast; a block the validator repairs often has a bad `teach` text.
- **Eval** (`scripts/turn_census/suite.py`).
  - `_has_shape` learns the directive names.
  - Two scores: shape-fit (≥90%) and wrong-shape rate (<5%).
  - A 12-question negative set of short factual questions where any block is wrong.
  - Duplicate forms must stay at 0; pill-versus-bar contradictions at 0, blocking.
  - Output tokens and `first_text_s` may not regress by more than ~10%.
  - A PR may not raise richness by raising duplication.
  - A 5-person findability test (how quickly a reader can name the value and its Fundstelle) gates Phase B.

## 6. Roadmap

**Phase A: this PR, fitted to the dialect being built (L overall).**

| Item | Effort |
|---|---|
| Fixtures and the splitter fix | S |
| Pill-versus-bar reconciliation and an honest tally in `:::pruefung` and `:::kennzahlen` | S |
| The registry and its generators, deleting the hand copies | M |
| Minimal server validator: unknown-name unwrap, marker provenance, budget, census | M |
| `:projekt[key]`, the Projektbezug strip and `:::faelle{nach}` with the Schwellen-Lineal | M |
| Bullet graphs, row sort and the all-clear collapse | S |
| `:::massnahmen` | S–M |
| `:::fehlanzeige` with "Gesucht in" from the trace | S |
| Typographic rhythm: lead, tabular figures, narrow space before units, mono § and Pkt, figure captions | S |
| Print CSS and the print/export parity spec | S |
| Suite shapes, the negative set, and a baseline taken before the prompt change | S |

**Phase B (about 3–4 weeks).**

- Block keys (S).
- Margin column with Randziffern, and the Schriftfeld (M).
- Annotated excerpt with `==…==` (M).
- Rechtskette ribbon, printing "Edition verbindlich: offen" until the Land table exists (M).
- `:messwert` (M).
- `:regel` rows, retiring `ifc_compliance` from prose (M).
- `:::ueberblick` (S–M).
- `::stand` (M).
- `:::vergleich` modes (S).
- Anchored proposals and "Entscheidung festhalten" (M).
- Filing a block (M).
- Living-value tags (S).
- Anchored follow-ups (S).
- Unterlagen status against the project files (M).
- The primitive refactor of `directive-shape.ts` (M).
- The duplication metric in the suite (M).

**Phase C.**

- `::ansicht` with a plan endpoint (L).
- GK small multiples, after a constants file of cited thresholds (M).
- A curated Land × Richtlinie × edition table, then `:::laender` (L).
- Parcel geometry from BEV DKM, bought as a service, not built (L).
- Cards moved to primitives with Markdown fallbacks (L).

## 7. The critic's guardrails (non-negotiable)

1. When the renderer can compute a value, it wins. The model's word never contradicts the drawing: a disagreement shows as a contradiction, never as both.
2. A block is used only where the content has that shape (the R1 thresholds), within the budget for its kind. A `direct` answer gets no blocks.
3. Colour means status, and status is rare. An all-clear collapses to its tally.
4. Every drawn value also exists as text: in the accessible name, in copy, and in print.
5. Markers (`:aktuell`, `:trifft`, `:empfohlen`) need provenance. A marker without it is stripped on the server and logged.
6. Every block keeps its `[N]` inside it, or it does not render as a block. Measurements never raise confidence.
7. The model never types a project value or a GlobalId. It writes keys and handles, and an unknown one degrades visibly.
8. Validation repairs and unwraps. It never deletes content, and it logs every repair.
9. Streaming never jumps: space is held, and the height never shrinks.
10. The phone layout is part of done: each block is checked at 390px in light and dark mode.
11. A commitment always goes through a typed, persisted card (ADR-0030), or through the agent's own tool. A button generated from Markdown never commits anything.
12. The eval scores "better", not "more": zero duplicates, shape-fit, the negative set, a token budget, and the findability test.
