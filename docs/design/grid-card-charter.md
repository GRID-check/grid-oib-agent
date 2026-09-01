# Grid Card Charter

> **Relation to `grid-design-language.md`.** The design language is the product-wide law: it governs every surface in Piloti — tokens, type ramp, spacing rhythm, motion vocabulary, provenance colour, the do-nots. This charter is the **card-specific application** of that law: it takes the general rules and resolves them into per-card decisions that the design language is too broad to make, and it adds constraints that only apply to cards (the figure rule, the shape vocabulary, the export-survival criterion). **Where the two disagree, the design language wins** — a conflict is a bug in this charter, and the fix is to change this file, not to deviate. Nothing here overrides `docs/design/grid-design-language.md`; where this charter is silent, the design language still applies in full.

**Purpose.** The product owner's brief: *"really also make each of the cards truly unique and look absolutely stunning here."* Not "same box, different accent colour and icon" — that is what exists and it is the complaint. This charter's job is the tension in that instruction: **maximum per-card distinctiveness inside one coherent system.**

> **Superseding brief (2026-09).** The owner sharpened the instruction: a card
> must **read as part of the answer, never as its own object** — "cards" is the
> schema's word, not the pixels' — and the answer's native anatomy (verdict,
> takeaways, callout from the ```answer_json envelope) is not a card at all but
> answer typography. Distinctiveness therefore comes from each card's §A5 mark
> and its typography, **never from its frame**: the framed register became a
> quiet ground (§A1), and the anatomy renders flat
> (`features/chat/components/AnswerAnatomy.tsx`). Where an older line below
> reads as praise for borders or shadows, this brief wins.

**Audience.** Implementation agents work from this file as their contract. Every claim about the current state carries a `file:line` so it stays checkable.

---

## 0. Audit findings — the current state

### 0.1 There are five different chromes, not one

The complaint "same box, different content" is half wrong, and that is why it has been hard to fix. The generic cards are not one box — they are **five**, and the fact that they *look* alike while being structurally different is the actual disease:

| Chrome | Cards | Evidence |
|---|---|---|
| `SchematicCard` (kit.tsx:702) | comparison_table, typed_table, norm_chain, calculation, condition_tree, process_map, document_checklist, deadline_timeline, change_impact | ComparisonTableCard.tsx:39, TypedTableCard.tsx:85, NormChainCard.tsx:52, CalculationCard.tsx:239, ConditionTreeCard.tsx:293, ProcessMapCard.tsx:47, DocumentChecklistCard.tsx:47, DeadlineTimelineCard.tsx:38, ChangeImpactCard.tsx |
| `Card` + hand-composed `SectionLabel` | key_takeaways, follow_ups, verdict_header, callout | KeyTakeawaysCard.tsx:101–102, FollowUpsCard.tsx, VerdictHeaderCard.tsx:59–60, CalloutCard.tsx:91 |
| Flat, no chrome at all | summary, requirement_checklist, legal_basis | SummaryCard.tsx:17, RequirementChecklistCard.tsx:61, LegalBasisCard.tsx:70 |
| `ProposalShell` | memory_proposal, project_profile_patch | ProposalShell.tsx:25–38 |
| Borrowed from another feature | document_grid (FileCard/FileGrid), the 6 IFC cards | DocumentGridCard.tsx:6–8 |

Cards in group 1 and group 2 render an identical silhouette — `rounded-lg border bg-card p-5 shadow-xs`, eyebrow, 14px title, body — from two different code paths. That is the worst of both worlds: no visual variety and no shared implementation.

### 0.2 The newest cards reproduce the problem, which proves it is structural

`document_checklist`, `deadline_timeline` and `change_impact` landed in commit `67c2ee03` (2026-08-19). They are **well-built** — derived tallies, honest unknown states, no fabricated fields — and they are, at a glance, **the same card three times**: a left rail with a small round node, a 13.5px label, a 13.5px semibold second line, a status chip right-aligned, a chevron, an identical dashed-bordered disclosure panel, an identical footer.

Seen in `visual/screenshots/cards-gallery.light.png`, the three stack into one undifferentiated column. Two older cards — `process_map` (ProcessMapCard.tsx:117–213) and `condition_tree` (ConditionTreeCard.tsx:123–273) — use the same silhouette, so **five cards now share one interaction shape.**

This is the charter's central evidence. The sameness is not legacy debt in old cards; it is what a competent implementer produces *today*, because the shared pattern is the path of least resistance and nothing tells them what should differ. **A charter that only fixes existing cards fixes nothing. The rules in §A are what stop the sixth card from being the same card again.**

### 0.3 The type scale has drifted to thirteen sizes and there are no spacing tokens

Measured across `features/grid-cards/`:

| Size | Occurrences |
|---|---|
| `text-xs` (12px) | 95 |
| `text-sm` (14px) | 46 |
| `text-[11px]` | 35 |
| `text-[13.5px]` | 17 |
| `text-[10.5px]` | 4 |
| `text-[13px]` | 3 |
| `text-[15px]` | 2 |
| `text-[12.5px]` | 2 |
| `text-[10px]` | 2 |
| `text-[17px]`, `text-[14px]`, `text-[12px]`, `text-2xl` | 1 each |

Thirteen distinct sizes, ten of them arbitrary values — and note `text-[12px]` alongside `text-xs`, and `text-[14px]` alongside `text-sm`: **the same size written two ways.** Spacing drifts identically (`gap-[11px]`, `px-[22px]`, `pb-[17px]`) and there is **no `--spacing-*` token scale at all**.

**Exactly one card in the entire generic family has an element above 15px** (verdict_header, VerdictHeaderCard.tsx:63). Everything else is a flat field of 13.5px rows in a box. If the cards feel *unresolved* rather than merely samey, this is why — and establishing the scale (§A2) is worth more than any individual card concept.

### 0.4 Colour is correct but is being spent on three different axes

`statusColor()` (kit.tsx:49–60) resolves four verdict states to `--text-color-feedback-*` tokens. It is correct and used consistently. But three *other* semantic axes are each solved ad hoc:

- **Modality** (binding vs interpretive): NormChainCard.tsx:76–78 uses weight + ink + a word. Correct.
- **Currency** (applies to you vs hypothetical): ConditionTreeCard.tsx:203 uses `border-dashed bg-muted/30` against a solid tinted panel — chrome differing *in kind*. Correct and excellent.
- **Lifecycle**: ProposalShell.tsx:12 spends `border-l-warning` on "pending", which collides with `warning` meaning "close to a limit" everywhere else. **This is a live role collision.**
- **Direction** (`change_impact`): ChangeImpactCard.tsx:63–69 chose amber for `tightens` with an explicit note that red would be wrong. Correct, and it arrived at §A3 axis 4 independently — evidence the axis is real and should be written down before a sixth card guesses differently.

### 0.5 What the frontend cannot do — hard constraints

**1. Runtime validation is strictly weaker than the backend contract, and the failure is a route-level crash.**

The schema generator flattens **every** `$ref` to `z.any()` — not only arrays of nested objects, but **required scalars-of-objects**. `energyPerformanceCardSchema` (generated.ts:63) emits `"hwb": z.any()` and `"reference": z.any()`, both of which are **required** in Pydantic (models.py:546, :550). Because `z.any()` accepts `undefined`, `validateGridCards` (schemas.ts:18–34) will happily pass a card with no `hwb` at all, and the renderer then dereferences it and throws.

**There is no error boundary anywhere around `GridCards`** (documented at RequirementChecklistCard.tsx:71–73). The consequence of one malformed nested field is therefore **the whole conversation route crashing**, not a dropped card. This has been demonstrated empirically on eight schematic cards.

> **Rule.** Every read of a nested field must have a fallback, and every unknown enum value must render as the neutral/unknown case. `STATUS_ICON[item.status] ?? CircleHelp` (RequirementChecklistCard.tsx:74) and `TONES[kind] ?? TONES.hinweis` (CalloutCard.tsx:87) are the pattern; they are not defensive nicety, they are the only thing between a bad field and a white screen. **This is the single most important implementation constraint in this document.**

**2. Cards arrive whole, or not at all.** `validateGridCards` Zod-parses and drops anything that fails, so **a card never renders half-populated** and there is no card-level skeleton or partial-render state. What *does* happen mid-stream is that a `[[card:N]]` marker arrives frames before the card it names — handled by `CardMarkerOptions.count` (card-markers.ts:43–51), which renders nothing rather than letting a raw marker flash as literal text. Degradation sections in §B therefore address **missing optional fields and hostile content**, not partial hydration.

**3. Layout width — design to 636px.** The chain is message column `max-w-3xl` → answer card `w-[680px]` (AgentResponse.tsx:575) → body `px-[22px]` (AgentResponse.tsx:605, :678). **680 − 44 = 636px on desktop, ~314px on a 390px phone.**
**`/dev/cards` renders at `max-w-2xl` (`app/dev/cards/page.tsx:75`) — narrower than production.** Do not tune a layout against the gallery; it will mislead you.

**4. No charting library.** No recharts, d3, visx, chart.js, nivo. The two existing charts are hand-rolled SVG. A chart-bearing card means hand-rolled SVG or a new dependency — and §D forbids the dependency.

**5. No SVG auto-layout.** No elkjs, no dagre. All schematic layout is hand-computed via `fitScale` (kit.tsx:174). Any drawn connector in this charter must have its geometry computed explicitly.

**6. No visual-regression diffing.** Screenshots are captured and committed but **never compared**, and the coverage workflow is comment-only and cannot fail a PR. **Do not claim CI will catch a visual regression.**

**7. No render-time or bundle-size budget.** `MarkdownRenderer.spec.tsx:516–521` documents that render-time budgets were deliberately abandoned as flaky. **Do not cite CI as a guard against a heavy card.**

**8. No print path, and it constrains meaning itself.** `src/lib/answer-export/cards.ts` is a generic field walker that turns each card into tables and labelled blocks for .docx/markdown. **Anything a card expresses only through drawn geometry, colour, or spatial arrangement is lost on export.** See §D.5.

**9. Accessibility rests on hand-written tests.** Only six `jsx-a11y` rules are enabled; there is no axe or jest-axe. Keyboard operability is guaranteed only by `getByRole` assertions that someone remembered to write.

**10. Container queries are effectively unused in cards.** A responsive card responds to the viewport, not to its own box.

### 0.6 What exists and is good — build on it, do not reinvent

- **A complete dual-theme semantic token system** (`src/styles/tokens.css`, 508 lines, all oklch). Cards use **zero `dark:` variants** — the tokens carry dark mode. Dark elevation is **derived, not mirrored**: wider lightness steps plus an `inset 0 1px 0` lit top edge instead of drop shadows. **Read tokens.css:216–241 before writing anything about elevation** — it explains at length why mirroring light's ratios into dark is what made the first pass read as mud.
- **A six-family provenance colour system**: `--source-law/oib/project/office/auto/model`, each with `-tint` and `-text`, plus `--status-active`, `--status-done`, `--signal-error`. The action colour is near-black ink; blue belongs to the law signal only. Colour never travels alone — always icon plus label.
- **Radius**: one base `--radius: 0.75rem` (tokens.css:114) with a derived 6/8/12/16/20/24 scale.
- **Motion tokens** (snap 120 / quick 180 / base 240 / deliberate 320 / ambient 1600) plus a curated in-house kit at `src/components/motion/index.tsx` with four springs carrying documented travel-range contracts. Reduced motion is fully handled, **including delays**. `motion` 12.43 is installed; import from `motion/react`, never `framer-motion`.
- **`roughjs` 4.6.6** behind `schematics/rough.tsx`, SSR-safe and seed-stable.
- **Geist Sans + Geist Mono.** `tabular-nums` is an established 138-site convention and the card schema already mandates it for `mass` and `date` columns.
- **The `kit.tsx` vocabulary**: status words, Austrian number formatting, tolerance bands, the crisp measurement layer, `NormRefFooter`. This is the real shared asset and it is good.

### 0.7 Doctrine that shapes the design

Two content cards is a turn's budget, one is usual, three is too many (catalog.py `_CARD_RESTRAINT`). **So the set is rarely seen together. Design each card for solo appearance beside prose, not for a gallery.** The gallery is a debugging tool, not the product.

---

## A. The system

### A1. One shell, three registers

Collapse the five chromes to one component with three declared registers. A register is a property of the card's **job**, never of taste.

- **Framed** — `rounded-lg p-5` on a **quiet ground**: `bg-muted/40`, no border, no shadow (`CARD_SHELL` in `components/card-chrome.ts`, the one place the framedness is decided). The card is an object separable from the prose — it can be cropped and pasted into an Einreichung — but it sits in the answer the way a figure sits in a book: grouped by its ground, not fenced off. The border-and-shadow silhouette this register used to carry is retired under the superseding brief above. Default.
- **Flat** — no ground at all, sits directly on the answer surface. For blocks that are *part of the answer body*: `summary`, `requirement_checklist`, `follow_ups` — and the whole envelope anatomy (the masthead of verdict value plus the near-universal `summary` standfirst, closed by one hairline; the takeaways as the closing block; the callout as an accent-ruled aside anchored by its `[[callout]]` marker), which always renders flat via `AnswerAnatomy.tsx`.
- **Accented** — Framed plus a 2px left edge in a role colour. Means "this card makes a claim you may act on." Exactly three: `legal_basis` (source-law), `verdict_header` *as a stored card* (ink), the two proposals (lifecycle).

**A fourth register is forbidden.** A new card picks one of these or it does not ship.

### A2. Type scale — six steps, and one figure

| Step | Spec | Role |
|---|---|---|
| **Eyebrow** | `text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground` — via `SectionLabel`, never hand-rolled | card type, micro-labels, column headers |
| **Meta** | 11px / 500 / `tabular-nums` or `font-mono` | ordinals, chips, units, ± bands, counts |
| **Caption** | 12px / 400 / `leading-relaxed` | details, notes, excerpt attributions |
| **Body** | 13.5px / 400 / `leading-[1.55]` | every row of every list. The default. |
| **Title** | 14px / 600 | the card title |
| **Figure** | 20–30px / 600 / `tabular-nums` | **the one thing the card exists to say** |

**The load-bearing rule: each card carries exactly one element above 14px, and it must be the card's answer.** Not its title. Not its icon. Its answer.

Three cards satisfy this today (verdict_header at 24px, calculation at 15px, condition_tree's open outcome at 15px). Bringing the rest into compliance *is* most of this charter. Where a card has no single answer — `key_takeaways` is five equal things — the figure is spent on its **first** item and nothing else.

`summary`'s 17px title (SummaryCard.tsx:18) is exempt: it is the answer's H1, not a card figure. Cross-card rule: **when a `verdict_header` is present, `summary` drops its title to 14px.** They must not compete for the top of an answer.

**Migration.** The six steps replace thirteen sizes. `text-xs` → Caption (12px) and nothing else; its current use as body text is the drift to eliminate. `text-sm` → Title. `text-[12px]`, `text-[14px]`, `text-[13px]`, `text-[12.5px]`, `text-[10px]` are all deleted, folding into the nearest step. Migrate a card when you touch it for another reason in §C order — a flag-day rewrite of 200 call sites is not worth the review burden, but **a card that has been through a §C sprint and still carries an off-ramp size has not passed.**

Forbidden: any size not in this table.

### A3. Colour roles — four orthogonal axes, one rendering each

Chroma belongs to provenance (`grid-design-language.md` §Principles 2). These axes must never trade renderings.

**1. Verdict — "does it meet the rule?"** → the four `statusColor()` inks, always with an icon carrying `aria-label` **and** the German word. Unchanged; it is correct.

**2. Modality — "how hard does this bind?"** → **weight and ink only, zero hue.**
- binding / decisive → `text-foreground font-semibold`
- interpretive / advisory → `text-muted-foreground font-normal`
- inactive / hypothetical → `text-muted-foreground` on `border-dashed bg-muted/30`

NormChainCard.tsx:76–78 and ConditionTreeCard.tsx:203 already do this. Codify it so the next card does not invent a fifth hue family.

**3. The binding constraint — "which one decides it?"** In a set of checks, exactly one usually decides the verdict, and nothing marks it today: `LimitBar` (kit.tsx:414–519) draws every check identically. The deciding row gets a **1px `--foreground` left rule and its value at the Figure step**; every other row stays Body with no rule. One per card, or none.

**4. Direction — "which way did it move?"** → glyph + word + a borrowed verdict ink:
- `tightens` → ↑ + „strenger" in `--text-color-feedback-warning`
- `relaxes` → ↓ + „milder" in `--text-color-feedback-success`
- `unchanged` → = + „unverändert" in `--muted-foreground`

Red is forbidden here: tightening is a cost, not an error, and error red is for errors only. `ChangeImpactCard.tsx:63–69` already reasons its way to exactly this.

**Fix required:** `ProposalShell` `pending` → `border-l-warning` (ProposalShell.tsx:12). Change to ink (`border-l-foreground/40`).

### A4. Density, spacing, geometry

- Card padding `p-5` (20px). Flat register: no padding, `gap-3` from the prose.
- Between blocks inside a card: 12px (`gap-3`). Within a block: 6px (`gap-1.5`). Above the `NormRefFooter` rule: 20px. **These four values are the card spacing scale**; there is no token layer for them yet, so they are written as Tailwind steps and never as arbitrary values (`gap-[11px]` and `pb-[17px]` are drift).
- Scannable row min-height 36px, `pointer-coarse:` 44px. The expandable row that `condition_tree`, `process_map`, `document_checklist` and `change_impact` are each built from is now one exported class (`frontends/ui/src/features/grid-cards/components/card-rows.ts`, `CARD_LIST_ROW`) rather than four byte-identical copies, so the floor lands once. Rows GROW rather than take a `touch-target` catchment: stacked ~33px apart, 44px catchments overlap and the later row in the DOM takes taps meant for the one above it. A disclosure with prose around it (`CalloutCard`, `CalculationCard`) is the opposite case and takes the catchment, so the card's rhythm does not change on a phone.
- **Two gutter widths only**: 22px for a rail (ConditionTreeCard.tsx:123), 26px for a numbered node (KeyTakeawaysCard.tsx:43, ProcessMapCard.tsx:117). Rails then align when two cards stack.
- Radius: cards `rounded-lg` (12px), inner panels `rounded-md` (8px), chips `rounded-md`, status pills `rounded-full`.
- Elevation: `shadow-xs` and nothing else in the transcript. Never two shadows in one card. In dark mode elevation is carried by the token, not by a `dark:` variant — see tokens.css:216–241.
- **No card inside a card.** The opened panels in `condition_tree` / `process_map` (`rounded-md border` on the same surface) are the legal form.
- Every table and every drawing scrolls inside its own `overflow-x-auto`. Already correct at ComparisonTableCard.tsx:46 and TypedTableCard.tsx:92.
- **Design to 636px desktop / ~314px phone** (§0.5.3), not to the gallery's `max-w-2xl`.

### A5. How a card announces its type — the shape vocabulary

This is the mechanism that makes twenty voices one family. **The eyebrow is demoted to a caption; the card's first 40px of geometry does the identifying.** Each mark below belongs to exactly one card and may not be borrowed:

| Mark | Means | Card |
|---|---|---|
| dots on a vertical rail | mutually exclusive alternatives | `condition_tree` |
| numerals on a vertical rail | a sequence with a position | `process_map` |
| ordinals in a descending staircase | a ranked list | `key_takeaways` |
| folded-corner glyph column | documents with states | `document_checklist` |
| rule **above** the content | a trigger / precondition | `deadline_timeline` |
| rule **under** the content | a total | `calculation` |
| vertical rules, no horizontals | a comparison | `comparison_table` |
| horizontal rules, no verticals | a data sheet | `typed_table` |
| stepped horizontal inset | a hierarchy | `norm_chain` |
| struck-through left value | superseded | `change_impact` |
| segmented tally bar | a count of states | `requirement_checklist` |
| recessed ground + margin § column | a quotation | `legal_basis` |
| a large lone figure, no body | a ruling | `verdict_header` |
| sketched stroke | drawn from your numbers | schematics only |
| unframed chips at the end | an offer, not evidence | `follow_ups` |

**This table is the charter's most reusable artefact.** A new card must claim a mark that is not in it, or argue that an existing mark genuinely belongs to it and the incumbent should give it up. "It looks like the process map" is not a design.

### A6. Motion policy

Governed by `grid-design-language.md` §Motion vocabulary. Card-specific rulings:

- **Arrival**: `FadeIn distance={6}` at the dispatcher (GridCards.tsx:97), applied uniformly. No card animates its own entrance. The `ProposalShell` spring (ProposalShell.tsx:35) is the documented exception, because those two cards *ask* for something.
- **Nothing inside a card animates on arrival.** No staggered rows, no bars filling to their value, no counting numbers. Three reasons and they compound: a bar animating to a legal value is a legal value in motion; the design language forbids animating a § reference at all; and a card renders mid-stream while the prose above it is still arriving, so a mount animation re-fires as flicker in the middle of an answer.
- **Permitted in-card motion, exhaustively**: `Collapsible` height at `duration-base`, chevron rotation at `duration-quick`, hover `transition-colors` at `duration-quick`. All `motion-reduce:` guarded, as they already are.
- **Springs are forbidden in every card body.** The design language's own veto: anything carrying legal, evidentiary, provenance or error content is tween-only.

### A7. The drawing kit, and where `rough` stops

`kit.tsx` (731 lines) is really two modules wearing one name:

- **Shell + vocabulary** (used by everything): `statusColor`/`statusLabel`/`worstStatus` (:49–96), Austrian formatting `fmtNum`/`fmtDim`/`fmtTolerance` (:103–166), `LimitBar` (:414), `DimChecksList` (:544), `NormRefFooter` (:618), `SchematicCard` (:702).
- **Drawing layer** (schematics only): `fitScale` (:174), `SvgLabel` (:195), `ExtensionLine` (:236), `DimensionArrow` (:271), `SchematicCanvas` + `MAX_CANVAS_SCALE` (:368–400).

**Split it.** `cards/shell.tsx` and `schematics/draw.tsx`. This is not cosmetic: it makes "may I sketch here?" a question of which module you import, and it stops `SchematicCard` — the chrome nine non-drawn cards depend on — living in a file called `schematics`.

#### The ruling on `rough`: confined to the schematics, permanently

**`rough` does not extend to the generic family, and that decision is the answer to "one product or two."**

The sketch stroke is not a style. It is an **epistemic claim**, stated in rough.tsx:5–7: *"the diagrams read as 'generated schematic', not a certified CAD drawing."* The wobble says "we drew this from your numbers; do not submit it as a survey." A takeaway list, a norm chain, a Frist sequence make no such claim — there is no geometry being approximated — so a wobbly rule under them would be pure decoration, and decoration under a legal citation costs exactly the authority the product sells. The kit already draws this line *inside* the schematics: object geometry is sketched, the measurement layer is crisp (kit.tsx:7–9).

What binds the two families into one product is not the stroke. It is four other things, and they must hold without exception:

1. **The shell** — same silhouette, padding, radius, elevation.
2. **The status vocabulary** — `statusColor` + word + icon, identical in both families.
3. **The figure convention** — any measured or legal quantity is `font-mono tabular-nums`, in both families. Mono means "this is a number you could check."
4. **`NormRefFooter`** — every card resting on a norm ends the same way.

A reader should be able to tell a schematic from a generic card instantly — they are different *kinds* of evidence — and never doubt they came from the same product.

**Three named consequences** (measured across the folder):

- `AcousticCheckCard` draws **nothing at all** — canvas 0, svg 0, rough 0. It is three `LimitBar`s in a `SchematicCard` (AcousticCheckCard.tsx:71–131). It is in the drawn family under false pretences. Fix the card (§B3).
- `ParkingRequirementCard` and `EnergyPerformanceCard` use `SchematicCanvas` with **zero** rough strokes. For parking that is wrong — a slot plan is physical geometry and should be sketched. For energy it is **right, and hereby exempted by name**: the A++–G ladder quotes a printed statutory label rather than sketching a building, and its crisp strokes plus statutory colours are the correct rendering (its own argument at EnergyPerformanceCard.tsx:30–50 is sound).

### A8. Deliberately forbidden

1. No font size outside the six-step ramp in §A2.
2. No card with two elements above 14px.
3. No hand-rolled eyebrow — `SectionLabel` only. CalloutCard.tsx:111 is the one documented exception, and its reason (the eyebrow carries the tone's ink, which `cn` cannot dedupe against `SectionLabel`'s hardcoded muted) stands.
4. No colour travelling alone. Every hue carries a word or an `aria-label`ed icon. Currently unbroken — keep it that way.
5. No hex or `oklch` literal in JSX. `statusColor()` or a token. The `color-mix(in oklch, ${color} N%, transparent)` inline-style pattern (ComparisonTableCard.tsx:84, TypedTableCard.tsx:60, ConditionTreeCard.tsx:156) is the sanctioned escape hatch because Tailwind cannot compose a runtime colour — it may only ever mix a `statusColor()` result.
6. No `rough` stroke outside `SchematicCanvas`.
7. No nested card.
8. No chart with an axis the data does not have (§D.1).
9. No hardcoded user-facing string. `de/chat.ts` and `en/chat.ts` in lockstep, enforced by `key-coverage.spec.ts`. Translator keys are written as literals, never composed — a template-literal key silently ships the dot-path when it is wrong (DocumentChecklistCard.tsx:74–80).
10. No new dependency. `motion`, `roughjs`, lucide and Tailwind are the entire toolkit.
11. No serif, no display face, no third font family. Sans is prose; **mono means "a number or identifier you could go and check"** — spending it on a heading costs the product its one typographic signal.
12. No per-item field read without a fallback (§0.5.1).

---

## B. Per-card concepts

Format: **job** → **grammar** → **unmistakable** → **degradation** → **effort**.

### B1. The generic family

#### `verdict_header`
**Job.** Deliver the one number or ruling the reader came for, at the top of the answer.
**Grammar.** The card is the figure. `subject` as Eyebrow above; verdict at **30px/600/tabular-nums/tracking-tight**, `text-balance`. Confidence stops being a pill (VerdictHeaderCard.tsx:66–75) and becomes a **hairline gauge**: three 12×3px segments filled to level, plus the word — so confidence is *comparable between two answers*, which a pill is not, and three segments is exact because the enum has exactly three values. `confidence_reason` at Caption beneath. No body list at all: **the card is ~96px tall, and that height is its signature — the only card under 120px.**
**Unmistakable.** A single large number in a short accented card with nothing under it.
**Degradation.** No confidence → gauge absent, verdict rises. Long compound verdict → wraps to two lines; drop 30 → 24px above 24 characters (branch on string length, not viewport — the string is the problem, not the column). 30px survives 314px comfortably.
**Effort: S.**

#### `key_takeaways`
**Job.** The 2–5 points a skimmer leaves with.
**Grammar.** Kill `divide-y` (KeyTakeawaysCard.tsx:107) — hairlines between rows are what makes it a generic list. Replace with a **descending staircase**: item *n* indents `(n−1) × 6px`, ordinals hanging off one continuous vertical hairline in the 26px gutter. Ordinals at Meta mono in `--muted-foreground/60`. **Item 1 breaks the pattern**: its ordinal is full-weight `--foreground` and its text is **15px/600** — the card's one figure. A reader who reads nothing else reads takeaway one, which is what "most important first" is supposed to buy.
Keep verbatim: a row with no `detail` is not a button (line 58).
**Unmistakable.** Progressive indent plus one heavy first row. Nothing else indents by rank.
**Degradation.** 2 items → one step, still reads. 5 items → 24px total indent, safe at 314px. Long compounds wrap with `text-pretty` — **never truncate a takeaway**, it is the payload. Missing `text` on an item → skip the row silently (§0.5.1).
**Effort: S.**

#### `callout`
**Job.** The one sentence that changes what the reader does.
**Grammar.** The best generic card today (CalloutCard.tsx:91–146) — accent edge clipped to the radius, icon well, kind-word always written, disclosure. Two changes only:
1. **Cap the width at `max-w-[46ch]`.** A remark narrower than the prose around it reads as an aside; one that spans the column reads as a section. This single change makes it identifiable at a glance and costs one class.
2. It is the only card with **no eyebrow row of its own** — the kind word and the title share one baseline (line 106). Preserve that as identity; do not "fix" it.
**Unmistakable.** The only card narrower than the column.
**Degradation.** Unknown `kind` already falls back to `hinweis` (line 87) and must, because `kind` arrives through a `z.any()` union member. Long compound title wraps under the kind word (already `flex-wrap`).
**Effort: S.**

#### `legal_basis`
**Job.** The product's proof-of-work — a citation you can verify.
**Grammar.** It should look like a page from a Gesetzblatt, not a chat block:
- The whole card sits on **`--input-background`** — the recessed surface. A quotation is *cut into* the page, not floated on it. It becomes the only recessed card in the system.
- The law-signal rule goes to **3px, full height** (from 2px, LegalBasisCard.tsx:70).
- `article` / `section` stop being inline `Badge`s and become **marginalia**: right-aligned in a fixed 72px right column at 11px mono, the way a statute prints its § in the margin. Every other card puts metadata inline; this one puts it in a margin, and that is the difference you see before you read.
- `original_text` gets **hanging quotation marks**: a `„` at 24px in `--source-law/30` set outside the measure, with the quote at 13.5px `leading-[1.75]` and the italic dropped (italic at that measure hurts German compounds). **This is the only decorative mark permitted anywhere in the system**, granted because a quotation mark on a quotation is not decoration.
- `summary` at Body. The AI-transparency line (line 130, EU AI Act Art. 50) stays, and stays last.
**Unmistakable.** The only recessed card, the only right-margin § column, the only large quote mark.
**Degradation.** No `original_text` → header + summary; the recessed ground still identifies it. No article/section → margin column collapses to 0 and text runs full width. Below 360px the margin column moves above the law name as a chip row.

> **SCHEMA ADDITIONS — REQUESTED, NOT YET IMPLEMENTED.** Neither field exists today. The card cannot render either treatment until they land in `src/aiq_agent/cards/models.py` and are regenerated through `shared/cards/schemas.json` → `npm run generate:cards`.
>
> 1. **`lane`** — the code already states the case verbatim (LegalBasisCard.tsx:61–68): the OIB accent cannot be resolved because `legalBasisCardSchema` carries no lane, and deriving `'oib'` from the law string by hand is precisely the drift `accentForLane` exists to prevent. OIB vs RIS is the distinction architects compare most (`grid-design-language.md` §Accents vs signals). **Highest-value schema addition in this charter.**
>
> **IMPLEMENTED, and NOT in the shape this charter first asked for.** The charter specified `lane: 'oib' | 'law'`; that was wrong and the implementation correctly refused it. `accentForLane(lane, signal)` matches on `startsWith('baurecht_oib')` — the fine-lane vocabulary `norm_registry.lane_for_hit` stamps on every chunk and chip. `'oib' | 'law'` is the accent a lane RESOLVES TO (`SourceTint`), not a lane, so feeding it back in would have required a second hand-written mapping in the renderer — the exact drift the helper exists to prevent — and would have let the card and the „Belegt durch" chips disagree about one document. Shipped as `lane: Literal["baurecht_oib", "baurecht_ris"] | None`, with a `mode="before"` validator folding the other real lanes on. `baurecht_basis` is excluded by name so an unclassified upload can never inherit the RIS tier.
> 2. **`edition: str | None`** — `NormReference` carries `edition` and the schematics print it (kit.tsx:637); `legal_basis` has no such field, so the product's most authoritative card is the one citation that cannot say *which Ausgabe*. „OIB-Richtlinie 2" without „Ausgabe Mai 2023" is not verifiable.
>
> **IMPLEMENTED** as specified, optional, printed beside the identifiers exactly as `NormRefFooter` does.

**Effort: M** (plus backend work for the two fields).

#### `norm_chain`
**Job.** Which of these norms actually binds, and which only interprets.
**Grammar.** The card's subject is a *hierarchy* and it currently renders as a flat vertical list — every link at the same x (NormChainCard.tsx:58–99). Make it a **descending terrace**: horizontal inset by rank — bundesgesetz 0, landesgesetz 12, verordnung 24, oib_richtlinie 36, oenorm 48, leitfaden 60. The connector becomes an **elbow** that drops and steps right at each level change, so a reader sees "the ÖNORM sits two levels under the Verordnung" without reading a badge.
Binding links get a solid 3px left edge on their row block; interpretive links get no edge and 60% ink (§A3 axis 2 — weight and ink, no hue). The `bindingTag` caveat for `oib_richtlinie` („bindend, wo erklärt", line 43) stays as words — it is the card's most important honesty device.
**Unmistakable.** The only card with a stepped horizontal cascade.
**Degradation.** All links at one rank → flat cascade, which is *honest*; the elbow degrades to a plain rail. Unknown rank already falls back to the raw string, non-binding (line 55) — keep. Cap inset at `min(rank×12, 48)` on mobile; 6 links at 314px still leaves ~250px for the label.
**Effort: M.**

#### `requirement_checklist`
**Job.** Several criteria read against this project.
**Grammar.** Today the plainest thing in the set — a bullet list with coloured icons (RequirementChecklistCard.tsx:60–120). Its real information is **how many are open**, and nothing shows it.
- **Signature: a segmented tally bar.** Full card width, 5px tall, one segment per item in verdict colour, 2px gaps. Beside it, at the **Figure step (15px tabular-nums)**: „3 von 7 offen". Fully derived from the rows; encodes exactly the counts with no interpolation, so it asserts nothing the data does not hold.
- Rows: keep the icon. Move the verdict word out of the flow (line 100) into a **right-aligned fixed 88px column** so every verdict aligns vertically and the reader scans one column instead of hunting ragged line-ends. `needs_input` rows keep their `AskAboutChip` (line 104) — one of the best affordances in the product. Reference chip below the verdict word.
**Unmistakable.** The segmented tally bar. Sole owner of that mark.
**Degradation.** **Below 3 items, suppress the bar** — a one-segment bar is a joke. All-pass → solid green bar, „7 von 7 erfüllt". Unknown status already falls back to `CircleHelp` (line 74) and **must** (§0.5.1). Long compounds wrap; the 88px verdict column does not.
**Effort: M.**

#### `comparison_table`
**Job.** Genuinely weigh 2–3 options against each other.
**Grammar.** **Kill the `<table>`** (ComparisonTableCard.tsx:47–95). A table with a tinted cell is the archetype the brief is complaining about.
- A CSS grid of criterion-rows × option-columns with **vertical rules only** (`divide-x`), **no horizontal rules**. Each option column is headed by its name at 14px/600 over a `bg-muted/40` band that **runs the full column height at ~3% opacity** — a column becomes a legible vertical body, which is what "side by side" actually means.
- Favoured cell per row: a filled 4px dot before the value, `font-medium`, plus the existing success tint (line 84).
- **Signature: a win-tally strip** under each column header — one small dot per row that column wins, derived from `highlight_index`. A reader sees "this option wins 4 of 6" before reading a single row. Exactly the summary a table cannot give, and it needs no new field.
- `recommendation` moves out of the card footer (line 98) into the **winning column's foot**, tinted, with the ThumbsUp. It belongs to a column, not to the card.
**Unmistakable.** Vertical rules and no horizontal ones, plus the tally strip. `typed_table` is deliberately the exact inverse.
**Degradation.** Schema guarantees ≥2 options and the backend pads short rows to `''` and nulls out-of-range highlights (`_square_rows`, models.py:650–666), so the grid is always square — render '—' muted for empties (already line 88). 4+ options → `overflow-x-auto` with the criterion column `position: sticky; left: 0`. **Below 360px the card transposes**: one option per block, criteria as rows inside it. That transposition is the mobile *design*, not a fallback — three columns at ~100px each with „Brandabschnittsfläche" in them is unreadable at any type size.
**Effort: L.**

#### `typed_table`
**Job.** The tabular long tail where every row is true at once.
**Grammar.** It should look like a table — that is its job, and it is the deliberate foil to `comparison_table`. Make it look like a **data sheet**:
- Horizontal hairlines only (already `divide-y`), **no vertical rules ever**. A **1px `--foreground` rule under the header row**, replacing the current hairline (line 95).
- Column headers move from 12px normal to **Eyebrow** — the header band reads as a legend, not as a first row.
- Numeric columns get `font-mono tabular-nums` (currently only `tabular-nums`, line 72).
- **The one chart this card earns**: a 2px **magnitude underline** beneath each cell of a `mass` column, scaled to that column's own max. Drawn only when *every* cell in the column parses as a number; otherwise nothing. It sits under a printed figure, so it adds no precision the number does not already carry. Hand-rolled SVG or a styled div — there is no charting library (§0.5.4).
**Unmistakable.** Mono figures with sub-cell magnitude rules; sole owner of that mark.
**Degradation.** Unparseable column → no bars, plain sheet. This must be the *common* case, not an error state. Unknown verdict word already renders a neutral chip (line 50) — keep, it is right. Wide table → `overflow-x-auto` (already) plus a sticky first column, which is the whole mobile design.
**Effort: M.**

#### `condition_tree`
**Job.** The answer forks on one factor; here is your branch, and here is what the others would say.
**Grammar.** **This is the best card in the product.** Four independent markings of the active branch (ConditionTreeCard.tsx:24–42), Konjunktiv vs Indikativ in the German itself, the correcting sentence *inside* the croppable rectangle. Keep all of it. Two changes:
1. **The root connector is a straight rail** (line 303), so a fork does not look like a fork. Replace with an **SVG brace**: one stem from the root splitting into *n* elbows at a single junction y — the classic decision-tree bracket. Drawn, not typeset, because a border-based rail cannot express a junction. Geometry hand-computed; there is no auto-layout (§0.5.5). This is the one place the generic family draws a connector, and it stays crisp (§A7).
2. The active branch's outcome is the card's figure: **15px/600 in the row itself**, not only inside the panel. Today the row truncates it (line 169), which puts the answer behind a click on the one card whose answer must survive a crop.
**Unmistakable.** Already is. The brace makes it so at 40px.
**Degradation.** No `active` → nothing marked, tree opens closed (line 288) — never pick a case for the reader. **Live mobile bug worth naming:** the condition chip is `shrink-0` (line 160); a long condition („Gebäudeklasse 5 mit Fluchtniveau über 22 m") squeezes the outcome to nothing at 314px. Let the chip wrap, with the outcome claiming a `flex-[1_1_9rem]` basis — the same fix ProcessMapCard.tsx:156–161 already documents for its own row.
**Effort: M.**

#### `calculation`
**Job.** The Rechenweg, auditable by looking rather than by re-deriving.
**Grammar.** The operand-over-label stack (CalculationCard.tsx:98–116) is already the right idea — that is how a Rechenweg is written on paper. Two changes make it unmistakable:
1. **Draw the rule.** A worked derivation draws a line before the total. Give the final step a 1px `--foreground` rule above its result, and set the result at the **Figure step: 24px/600 mono tabular** (from 15px, line 163). The final number is what the card is for; it should be the largest thing in it.
2. **Bind the limit to the result.** The limit currently sits in its own line under the card (`LimitLine`, :193–219). Put the result and the limit on **one baseline with the `≤`/`≥` between them, both at 24px**, so the comparison reads as arithmetic rather than as two separate facts. The limit's label and reference drop to Caption beneath.
Untouched, and untouchable: no `result` on the wire, `resultDecimals` precision escalation, tolerance-band propagation, the straddle sentence at `warning`. That is the card's soul (:10–35).
**Unmistakable.** The only card with a horizontal rule inside a computation and a 24px mono figure.
**Degradation.** Missing operand → already italic „fehlende Angabe" (line 104), result undecidable (line 181). The rule and figure still draw, but the missing phrase renders at **15px, not 24px** — a missing value must never be the biggest thing on screen. Operand labels truncate at 11rem with a `title` (line 112); drop to 7rem below 360px. More than 4 operands in a step → **stack them vertically, one term per line**, which is also how a long Rechenweg is written on paper.
**Effort: M.**

#### `process_map`
**Job.** The Verfahren, and where this project stands in it.
**Grammar.** Excellent already (ProcessMapCard.tsx). The rail is vertical and reads as a list; a Verfahren is a *route*. Two changes:
1. **Progress spine.** The rail above the current node draws solid `--foreground/40` (already, line 126); the rail **below** it draws **dashed**. Travelled and untravelled at a glance — the entire meaning of `current_step`.
2. **Signature: a progress cap** at the top of the card — a 3px hairline track with the filled portion = `currentIndex / (steps−1)`, and „Schritt 3 von 5" at Meta beside it. Derived, never sent.
Keep: `duration` chips carry the Bauordnung's own words and are never a computed date (:35–37).
**Unmistakable.** Solid-above/dashed-below spine plus the step-of-n cap. It shares a rail with `condition_tree` and `deadline_timeline`, so codify the distinction and never violate it: **numerals mean sequence, plain dots mean alternatives** — and `deadline_timeline` must vacate the numeral (see §B2).
**Degradation.** No `current_step` → no cap, no dashes, everything neutral (:32–33). That rule is correct and must not be softened. The row already has the wrap fixes for a narrow column (:156–187); do not regress them.
**Effort: S–M.**

#### `follow_ups`
**Job.** Hand the reader their next question, already phrased.
**Grammar.** **Drop the card.** Today: chips inside a `Card` with an eyebrow (FollowUpsCard.tsx). The chips are right; the frame around them is wrong. This card closes *every subject-matter answer by default* (catalog.py `_FOLLOW_UPS_RULE`), so it is the single most-seen card in the product — and it puts a bordered box at the bottom of every answer. **A large share of the "everything is a box" feeling is this one card's frame, seen a hundred times.**
Flat register: Eyebrow + chips directly on the answer surface, 20px above, nothing else. The chips already carry their own border and shadow (CHIP, lines 52–59).
Rationale beyond aesthetics: this is the one card that is **not evidence** and must never be screenshotted into a submission. Making it the only unframed trailing block is honest as well as recognisable.
**Unmistakable.** The only thing at the end of an answer with no frame.
**Degradation.** Keep one line per chip with the whole question in `title` (:82–84). At 314px set `min-w-[12rem]` and let the row wrap — „Wie wird das Hauptgeschoß…" is still useful, „Wie…" is not. Empty `items` → render nothing at all, not an empty eyebrow.
**Effort: S.**

#### `summary`
**Job.** The answer's headline and intro, flat on the result surface.
**Grammar.** Nearly correct already (SummaryCard.tsx:17–30). The key-point rule is `border-border` (line 23), the same hairline every disclosure panel uses — promote it to **2px `--foreground/20`**; these are the answer's own emphasis, not a nested aside. Apply the cross-card rule from §A2: **with a `verdict_header` present, the title renders at 14px/600.**
**Degradation.** No `content` → title + points. No `key_points` → title + intro, and the rule is absent rather than empty.
**Effort: S.**

#### `document_grid` (system card)
**Job.** The project files this answer leaned on.
**Grammar.** **Leave it.** It borrows `FileCard`/`FileGrid` from the documents feature (DocumentGridCard.tsx:6–8) and its distinctiveness is precisely that it looks like the Files page — a file should look the same everywhere in the product. Its unresolved and error states (document-surface.tsx:24–79) are already better-designed than most of the generic family. One check only: it must be **flat register**, because a frame around a grid of file cards is a card-in-card (§A4). Unframe if framed.
**Effort: S.**

#### `memory_proposal` / `project_profile_patch`
**Job.** Ask the user to commit something.
**Grammar.** Correct and already unique — the only cards with buttons and the only ones whose appearance changes after you act (`ProposalShell`, lifecycle-tracking accent). One fix, from §A3: `pending` must stop spending `--warning` (ProposalShell.tsx:12). Use `border-l-foreground/40`.
**Effort: S.**

#### IFC cards (`ifc_viewer`, `ifc_schedule`, `ifc_element`, `ifc_diff`, `ifc_compliance`, `ifc_model_picker`)
**Job.** Point at the actual building.
**Grammar.** Leave the interiors alone. They are a coherent family already, and their identity is structural: they contain live data the agent never supplied (IfcDataCards.tsx:5–11). Only ask: adopt the common shell so the reader does not meet a sixth chrome.
**Effort: S each, shell swap only.**

### B2. The three newest cards — built 2026-08-19, and what remains

All three landed in commit `67c2ee03`. **They are well-built**: derived tallies with no summary field on the wire, honest three-state unknowns, no fabricated values, correct wrap treatment for the narrow column. Nothing below asks for a rewrite. What they lack is **differentiation from each other and from `process_map`** — see §0.2. Each needs its §A5 mark and its §A2 figure, and nothing else.

#### `document_checklist`
**Job.** The Einreichliste as *states*, not names.
**As built.** `SchematicCard`; rows with a status icon (`CircleCheck` / `Circle` / `CircleHelp` for present / missing / unknown, DocumentChecklistCard.tsx:65–69); a derived count row at 13px mono (`Count`, :92–99); condition printed in the row for conditional documents (:145–148); independent per-row disclosure using a `Set` rather than one-at-a-time, correctly reasoned (:34–36). The three-state face including a distinct "unknown" is exactly right and must not be collapsed (:60–63).
**What remains.**
1. **Claim the mark**: replace the round status icon with the **folded-corner document glyph** in a 32px column — filled for `present`, outlined for `missing`, hairline-dashed for unknown. Three states legible without colour, which matters because unknown is the most common.
2. **Indent conditional rows 16px.** The card then reads as two tiers — always-required and it-depends — which is the reader's actual first question. Nothing else in the set indents by requirement kind.
3. **The tally becomes the figure**: „4 von 11 vorhanden · 3 offen · 4 unbekannt" at **15px tabular-nums**, up from 13px, with each count carrying its glyph inline.
**Degradation (already handled, keep).** No status anywhere → a sentence rather than a „0 von 5" progress line that would be a claim about the project (:22–27). 16 items → cap at 8 rows with an „alle 16 anzeigen" disclosure (local state, presentational). Long compounds wrap; the issuer column collapses under the label below 360px.
**Schema:** fully served. No addition needed.
**Effort: M.**

#### `deadline_timeline`
**Job.** Several Fristen in the order they run, each with what starts its clock.
**As built.** `SchematicCard`; an evenly-spaced rail with **numbered round nodes** (DeadlineTimelineCard.tsx:80–94); label at 13.5px, `period` at 13.5px semibold, `starts_from` under it behind an Eyebrow label (:112–124); a footer stating out loud that the rail is not to scale and no date is computed. The refusal to scale the rail is correct and load-bearing (:21–25) — a bar whose length meant anything would claim that four weeks and four years sit on one timeline.
**What remains.**
1. **Vacate the numeral.** Numbered round nodes are `process_map`'s mark (§A5), and side by side the two cards are indistinguishable. Replace the rail with the **ratchet**: each Frist is a block whose **top edge is a solid 2px rule** carrying `starts_from`, with **dashed spine between blocks**. The dash states that the gap is unknown — the same honesty the footer currently carries in prose, moved into the drawing where it cannot be skipped.
2. **`period` becomes the figure**: 20px/600, up from 13.5px semibold. It is what the reader came for.
3. `consequence` moves onto the block's bottom edge prefixed `→`, in warning ink with its word (a lapsed Frist is a cost, not an error — no red).
**Unmistakable.** The only card that puts a rule **above** its content, and the only stack of 20px figures down a dashed spine.
**Degradation.** 2 deadlines is the schema minimum → two blocks and one dash; still reads. **Guard:** `period` at 20px for ≤18 characters, 16px above, so „binnen vier Jahren ist mit dem Bau zu beginnen" (a real fixture value) cannot dwarf the card.
**Schema:** fully served. No addition needed.
**Effort: M.**

#### `change_impact`
**Job.** What one moved fact costs.
**As built.** `SchematicCard`; a header panel carrying `factor: from → to` at 13.5px medium with the derived direction tally beneath (ChangeImpactCard.tsx:212–245); rows of `aspect` at 13.5px over `after` at 13.5px semibold, a direction glyph, a direction chip, a disclosure holding `before`, `detail` and the required Fundstelle. **`tightens` is amber with an explicit note that red would be wrong (:63)** — it arrived at §A3 axis 4 independently. The absent-`from_value` case is handled in words rather than by inventing a plausible value (:27–31), which is exactly right.
**What remains.**
1. **The hinge becomes the figure**: `from_value → to_value` on one baseline at **20px/600** with the arrow at 20px muted. When `from_value` is absent the left slot renders as an **empty dashed outline** with the existing caption — an absent origin must be *visible as an absence*, because the card is a delta and a delta with an unknown origin is a materially different claim.
2. **Claim the mark: strike the superseded value.** Bring `before` out of the disclosure into a left ledger column, **struck through** wherever direction ≠ `unchanged`. A struck value is the clearest possible "this no longer applies" and costs zero colour. Nothing else in the system strikes text. Where `before` is absent the column shows the existing „bisher nicht bekannt".
3. `reference` is **required on this card and optional almost everywhere else** — so this is the only card where every row is cited. Give it a permanent right-margin 11px mono column rather than hiding it in the disclosure, and let that always-populated column be part of the card's look.
**Degradation.** 1 consequence is the minimum and still earns the card. All `before` absent → ledger collapses to a single cited list; the hinge still carries the change. `unchanged` rows (validator guarantees `before == after`, models.py:1640–1650) → **print the value once, centred, with „unverändert"** — never twice. Below 360px the ledger stacks per row: aspect, then before → after on its own line.
**Schema:** fully served. No addition needed.
**Effort: M.**

### B3. The schematics — honest judgement

**Eleven are genuinely good and need nothing but the shell and token pass.** Saying so plainly is part of the job; manufacturing work here would cost the schematics the quality they already have. Verified by reading the code and by looking at `visual/screenshots/cards-gallery.{light,dark}.png` and `.mobile.*`.

| Card | Verdict | Raise | Effort |
|---|---|---|---|
| `dimension_diagram` | **Excellent.** Six real architectural templates, arrows placed where each dimension is actually measured — lichte Durchgangsbreite, not Stocklichte. 619 lines and it shows. | None | S |
| `stair_diagram` | **Excellent.** Section + plan + Lauflinie + the architectural „17 Stg 17,6/28 cm" notation. Real drafting. | None | S |
| `guardrail_check` | **Excellent.** Balusters drawn at the *actual* max opening, shaded Kletterschutzbereich, Absturzhöhe surfaced below the deck because it decides 100 vs 110 cm. | None | S |
| `daylight_incidence` | **Excellent.** Real trigonometry — the 45° line, the obstruction pierce condition, the verdict colouring the cone. | None | S |
| `building_section` | **Strong**, and correctly plain — it carries one claim (height against thresholds) and carries it perfectly. | None | S |
| `thermal_envelope` | **Strong.** A real section with wall thickness and openings, status leaders outside the drawing so a failing Dach reads without the drawing turning into crayon. | None | S |
| `setback_plan` / `fire_access_plan` | **Strong**, and their deliberately shared drawing language (street band, north arrow, hachured footprint) is a feature, not duplication. | None | S |
| `fire_compartment` | **Strong.** Hachured bands proportional to area with a bold Brandwand separator. | None | S |
| `egress_diagram` | **Strong.** Polyline honouring each run's turn over a corridor underlay. | None | S |
| `elevator_requirement` | **Strong**, and correctly refuses to render the requirement as a pass/fail verdict — it is a fact, not a judgement. | None | S |
| `energy_performance` | **Good and distinctive.** The A++–G ladder, statutory-colour exception well argued at :30–50. Crisp strokes are *correct* here — it quotes a printed label. | **Exempt from the rough rule by name** | S |

**Three need real work:**

| Card | Verdict | Raise | Effort |
|---|---|---|---|
| `acoustic_check` | **A drawing in name only.** Measured: canvas 0, svg 0, rough 0. Three `LimitBar`s in a `SchematicCard` (:71–131). The widest gap in the product between promise and delivery. | Draw the real thing: **two rooms separated by the building part under test, with the sound path drawn** — an airborne arrow *through* the wall for DnT,w / Rw,res, a footfall arrow *down through the slab* for LnT,w. The drawing then does visually what the card currently explains in words (`lowerIsBetter` / `higherIsBetter`, :100–104): direction. Keep the margin figure („Reserve +3 dB") and promote it to the card's figure at 15px. | **L** |
| `parking_requirement` | Slot grid is a decent idea, but drawn crisp with **zero rough** — it reads as an icon field, not a plan. | Draw a real **Stellplatz plan**: parallel bays at the standard 2.5 × 5.0 m proportion, sketched; missing bays as dashed voids in the same row. Keep the count bars. | **M** |
| `density_check` | Honest and clever (√-scaled footprint keeps the *area* ratio true) but thin — one small box plus two bars, and the drawing carries no number. | Annotate the shaded footprint with its ratio **inside the box** („25 % bebaut"), so the drawing states the fact the bars measure. | **S** |

---

## C. Ranking

Axis: **(visual poverty today) × (how often the model emits it)**. Frequency is read off the trigger table (catalog.py:80–107) and the doctrine: `follow_ups` closes *every* subject-matter answer by default; the generic answer shapes fire on almost any OIB question;

> **Since this was written:** `follow_ups` is retired — the model emits none, and the post-answer STAGE produces the questions instead, rendered below the answer rather than inside it (`docs/architecture/post-answer-stages.md` §7.10). The ranking below is left as the record of a decision already taken and shipped; `FollowUpsCard.tsx` still draws every stored card and the rail, so §B1's flat register is still what a reader sees. a schematic fires only when the question names its geometry; IFC cards fire only with a model loaded.

Poverty was assessed by reading the JSX **and by looking at the captured gallery** (`visual/screenshots/cards-gallery.{light,dark}.png`, desktop and mobile) — the three-newest-cards finding in §0.2 came from looking, not from reading.

| # | Card | Why here | Effort |
|---|---|---|---|
| 1 | **follow_ups** | Highest frequency of anything in the product — it closes every answer — and its frame is a large share of the "everything is a box" feeling. One-class fix, biggest aggregate effect. | S |
| 2 | **comparison_table** | The brief's archetype: a table with a border. Fires whenever two options are weighed, which is constant. | L |
| 3 | **requirement_checklist** | Very frequent (three-plus criteria is a common answer shape) and currently the plainest card in the set. | M |
| 4 | **key_takeaways** | Frequent, and the centre of gravity of the "same box" complaint. | S |
| 5 | **legal_basis** | Frequent, and it is the product's proof-of-work — the card that most needs to look authoritative and currently looks like a left rule and two badges. Carries the two schema requests. | M |
| 6 | **verdict_header** | Frequent, cheap, and it sets the top of an answer. | S |
| 7 | **deadline_timeline** | Newly built and **currently indistinguishable from `process_map`** (§0.2). Fixing it now, while it is days old, is far cheaper than after it has tests and screenshots pinned to the numeral rail. | M |
| 8 | **change_impact** | Newly built; „was passiert, wenn X sich ändert" is a constant planner question, and the hinge is one figure away from being the most distinctive card in the set. | M |
| 9 | **norm_chain** | Its flat list actively contradicts its own subject — the one card whose form denies its content. | M |
| 10 | **document_checklist** | Newly built and competent; needs its glyph column and its tier indent to stop reading as the other two. | M |
| 11 | **acoustic_check** | Low frequency, but zero visual content inside the family whose entire promise is drawings. Highest-value schematic work. | L |
| 12 | **typed_table** | The tabular long tail — frequent-ish, currently competent but generic. | M |
| 13 | **calculation** | Moderate frequency, already good; the 24px result plus bound limit is a cheap large win. | M |
| 14 | **condition_tree** | Frequent, but already the best card. The brace and the un-truncated active outcome are refinements — plus one live mobile bug. | M |
| 15 | **process_map** | Moderate frequency, already good. Spine plus cap. | S–M |
| 16 | **parking_requirement** | Low frequency, but a real gap against the family's stroke contract. | M |
| 17 | **summary** | Frequent but nearly correct — one rule weight, one composition rule. | S |
| 18 | **callout** | Frequent, nearly correct, one width cap. | S |
| 19 | **proposals** (memory / patch) | Low frequency, one colour-role fix. | S |
| 20 | **density_check** | Low frequency, one annotation. | S |
| 21 | **document_grid** | System-emitted, correct as is. Register check only. | S |
| 22 | **the eleven strong schematics** | Shell and token hygiene only. **Do not redesign them.** | S each |
| 23 | **the six IFC cards** | Shell alignment only. | S each |

**Sprint shape.**

- **Sprint 1 — the cheap frequent ones.** Items 1, 4, 6, 17, 18, 19. All S, all in the top half, all touching every answer. Ship them together: they establish the §A2 figure rule and the §A3 colour-role fixes in real code, which every later card then builds against.
- **Sprint 2 — the three newest cards** (7, 8, 10) while they are days old. Differentiating them now costs three mornings; after they accumulate tests and pinned screenshots it costs a week.
- **Sprint 3 — `comparison_table` alone** (2). Its transposing mobile layout is the hardest single thing in this charter, and everything after it is easier.
- Then §C order.

---

## D. Anti-goals

**1. No chart whose axis the data does not have.**
`deadline_timeline` is the test case: bars proportional to „binnen vier Wochen" against „vier Jahre" would assert a shared timeline that does not exist — the card's own implementation already refuses this (DeadlineTimelineCard.tsx:21–25) and the charter's dashed spine exists to state the gap is unknown. The same veto covers sparklines over `typed_table` rows that are not a series, pie charts of `requirement_checklist` statuses, and any radial gauge anywhere. A segmented bar with one segment per item is legal because it encodes exactly the counts; a bar whose *length* interpolates is not.

**2. No animated numbers, no bars that fill on arrival.**
A bar animating to a legal value is a legal value in motion. The design language forbids animating a § reference at all, and forbids counting numbers outright. It also fights streaming: a card renders while the prose above it is still arriving, and a mount animation that re-fires on re-render reads as flicker in the middle of an answer.

**3. No decoration that is not derived.**
Every mark on a card must be computable from the card's own fields. Exactly one exemption is granted — the `legal_basis` quotation mark — because a quotation mark on a quotation is not decoration. No texture, no watermark, no ornamental corner, no background illustration, no gradient, no emoji.

**4. No card slower to read than the sentence it accompanies.**
The acceptance test for every design here: **a reader extracts the card's headline claim in under two seconds without reading a row.** If a concept cannot pass that, it has failed regardless of how it looks. This is what the §A2 figure rule and the §A5 shape vocabulary exist to buy, and it is the rule that would kill an otherwise beautiful design.

**5. No meaning that lives only in the pixels.**
`src/lib/answer-export/cards.ts` is a generic field walker: it turns each card into tables and labelled blocks for .docx and markdown. **Anything expressed only through drawn geometry, colour, or spatial arrangement is lost on export.** Every concept in §B must therefore name a field or a word that carries its meaning in the export. Worked examples of the rule being satisfied:

- `change_impact`'s struck-through `before` → `direction` is a wire field, and the export translates it through `answerExport.values.direction`, so „verschärft" — not `tightens` — reaches the document. The same map covers every other closed vocabulary a card carries (`operation`, `requirement`, `provenance`, `status`, …), and `label-coverage.spec.ts` derives the members from the card schema, so a member added to a `Literal` fails the build rather than shipping an English word.
- `norm_chain`'s stepped terrace → `rank` is a wire field, and its word carries the tag with it: `answerExport.values.rank` spells `verordnung` as „Verordnung (bindend)" and `oenorm` as „ÖNORM (auslegend)". The terrace is a picture of that parenthesis; the export states it.
- `requirement_checklist`'s tally bar → the derived sentence „3 von 7 offen" is text and exports; the bar is redundant reinforcement.
- `deadline_timeline`'s dashed spine → the footer sentence saying the rail is not to scale exports.
- `condition_tree`'s active branch → carried four ways including the Konjunktiv/Indikativ distinction in the German itself, which survives export, greyscale and cropping.

**A design whose meaning cannot survive the field walker must be redesigned, not documented around.**

**6. No colour carrying a signal alone, and no colour role reused across axes.**
Both are live: colour-alone is currently unbroken and must stay that way; role-reuse is broken once, at ProposalShell.tsx:12.

**7. No sixth chrome.**
A new card uses the shell and picks one of three registers, or it does not ship. Five chromes is how the set got here, and §0.2 shows the drift is still active.

**8. No card that restates the prose beside it.**
Already doctrine (catalog.py `_CARD_RESTRAINT`) and also a design rule: a card that is a restatement cannot be made beautiful, only bigger. If a proposed redesign only works by giving the card more to say, the card should not have been emitted.

The test is FORM, not facts — a scope the doctrine states out loud since two field transcripts were cut by the broad reading. An answer whose prose already enumerates its cases shares every fact with the card that would show them, so "says what the prose says" vetoed exactly the answers a card helps most. Three Lagen with their Anforderung and Fundstelle as a table is not three sentences said again; it is three sentences the reader no longer has to align by hand. Same words in the same shape still loses the card.

**9. No sketch stroke on anything that is not physical geometry** — and no crisp stroke on physical geometry inside the schematics. The rule cuts both ways, which is why `parking_requirement` is on the fix list and `energy_performance` is exempted by name.

**10. No new dependency.**
A charting library would import a visual language that is not this one, arriving with its own type scale, palette and motion. `motion`, `roughjs`, lucide and Tailwind are the whole toolkit; everything in this charter is achievable with them.

**11. No per-card font, no serif, no display face.**
Two families exist. Sans is prose. **Mono means "a number or an identifier you could go and check"** — which is why it appears on § references, measured values and tolerance bands and on nothing else. Spending it on a heading costs the product its one typographic signal.

**12. Do not claim CI will catch it.**
There is no visual-regression diffing, no render-time budget and no bundle-size budget (§0.5.6, §0.5.7), and only six `jsx-a11y` rules (§0.5.9). A card is verified by a human looking at `npm run screenshots` output in both themes at both widths, and by hand-written `getByRole` assertions for anything keyboard-operable. **Write the assertions; nothing else will.**

---

## E. Status

**Last updated: 2026-09-01.** Sprint 1 has shipped (`b82f23e1`): the §A2 type ramp, the §A3 colour-role fix, and items 1, 4, 6, 17, 18, 19. Everything else below is still a design contract, not a description of shipped work — read the Status column per row rather than assuming either way.

**Type-ramp sprint 2 (2026-09-01)** put `schematics/kit.tsx` and the two table cards on the ramp, out of the sprint order above, for a reason worth recording. The trigger was a stakeholder report — „Textgröße teilweise viel zu klein, zu viele Typo-Arten, insgesamt zu unruhig (z. B. bei Vergleichstabellen-Output-Cards)" — which is §0.3 observed from the outside, and it named the exact card §C had scheduled last.

`kit.tsx` went first because it is the chrome for NINE cards: eyebrow, title, note and norm footer. One migration moves all of them, and every schematic card migrated after it starts from a compliant shell.

The tables were the substance. `comparison_table` rendered **thirteen distinct type treatments, none above 14px**, with its entire content at 12px — the CAPTION step — inside a 16px answer. That is a misreading of this document rather than a limit in it: §A2 defines Body as "every row of every list. The default." and a comparison table's rows are rows of a list. The whole table is now one size, with weight and ink carrying the hierarchy that size had been spending itself on. `typed_table` had the same defect and took the same fix. Only the type scale moved; the transposing mobile layout §C calls the hardest single thing in this charter is untouched and still Pending.

**Note what this sprint did NOT settle.** The ramp tops out at 13.5px Body while the prose it interrupts is 16px (`MarkdownRenderer`, `text-base`), so a migrated card is still systematically smaller than the paragraph above it. Every step is *internally* consistent and *externally* undersized. Whether to re-base the ramp against the prose baseline is a product decision affecting all 35 cards at once, and it is open.

### Implemented
*(none)*

### Pending — system

| Item | Section | Status |
|---|---|---|
| Split `kit.tsx` into `cards/shell.tsx` + `schematics/draw.tsx` | A7 | Pending |
| One shell, three registers | A1 | Pending |
| Six-step type ramp + migration off the other seven sizes | A2 | Pending |
| Figure rule (one element above 14px, and it is the answer) | A2 | Pending |
| Colour-role axes written down; `ProposalShell` pending-tone fix | A3 | Pending |
| Card spacing scale (12 / 6 / 20, no arbitrary values) | A4 | Pending |
| Shape-vocabulary table adopted as the gate for new cards | A5 | Pending |
| Motion policy (no in-card entrance, no springs in card bodies) | A6 | Pending |

### Pending — per card

| # | Card | Section | Effort | Status |
|---|---|---|---|---|
| 1 | follow_ups | B1 | S | **Done** (Sprint 1, `b82f23e1`) — frame dropped; `title` deliberately KEPT, see note below |
| 2 | comparison_table | B1 | L | **Type scale done** (ramp sprint 2, 2026-09-01) — one size for the table, weight/ink for hierarchy. The transposing mobile layout is still Pending |
| 3 | requirement_checklist | B1 | M | Pending |
| 4 | key_takeaways | B1 | S | **Done** (Sprint 1, `b82f23e1`) |
| 5 | legal_basis | B1 | M | Pending — schema now LANDED (`284b2625`), so no longer blocked; the recessed ground / margin § column / hanging quote marks remain |
| 6 | verdict_header | B1 | S | **Done** (Sprint 1, `b82f23e1`) — gauge shipped as three 5px squares, NOT 12×3 bars; see note below |
| 7 | deadline_timeline | B2 | M | Pending |
| 8 | change_impact | B2 | M | Pending |
| 9 | norm_chain | B1 | M | Pending |
| 10 | document_checklist | B2 | M | Pending |
| 11 | acoustic_check | B3 | L | Pending |
| 12 | typed_table | B1 | M | Pending |
| 13 | calculation | B1 | M | Pending |
| 14 | condition_tree | B1 | M | Pending (includes the `shrink-0` mobile bug) |
| 15 | process_map | B1 | S–M | Pending |
| 16 | parking_requirement | B3 | M | Pending |
| 17 | summary | B1 | S | **Done** (Sprint 1, `b82f23e1`) |
| 18 | callout | B1 | S | **Done** (Sprint 1, `b82f23e1`) |
| 19 | proposals (memory / patch) | B1 | S | **Done** (Sprint 1, `b82f23e1`) — accent kept at `foreground/40`; verified legible at pixel level, an amendment to /60 was considered and declined |
| 20 | density_check | B3 | S | Pending |
| 21 | document_grid | B1 | S | Pending (register check only) |
| 22 | the eleven strong schematics | B3 | S each | Pending (hygiene only — **do not redesign**) |
| 23 | the six IFC cards | B1 | S each | Pending (shell alignment only) |

### Sprint 1 — what shipped, and where it departed from this charter

Landed in `b82f23e1`: the §A2 type ramp, the §A3 colour-role fix, and items 1, 4, 6, 17, 18, 19.

**The ramp is `@layer components`, not `@utility`.** A type step sets four or five
properties and a card legitimately overrides one of them. In the utilities layer,
which of `card-title` and `font-semibold` wins depends on Tailwind's internal
ordering; in the components layer the ramp is a base every utility beats, by layer
order rather than by luck. Enforced by a new `grid/card-type-scale` eslint rule,
switched on per file through `CARDS_ON_THE_TYPE_RAMP` in `eslint.config.mjs` — the
compliant set is real project state and belongs in config, not in an exemption list
inside the rule, which would report "clean" with eleven cards still off the ramp.

**Two deliberate departures, both upheld on review:**

1. **The confidence gauge is three 5px squares, not three 12×3px bars.** As specified
   the mark failed at the top of its own range: a meter filled to full and a rule are
   the same picture, so at „hohe Sicherheit" it read as a decorative em-dash and the
   comparability the gauge exists for was exactly what it lost. Tightening the gaps
   and grooving the unlit cells did not fix it, because the problem is the cell
   SHAPE — a square is a token, a bar is a stroke. ▪▪▪ reads as three-of-three;
   ▪▪▫ and ▪▫▫ still read as levels.

2. **`follow_ups` keeps its `title`.** §B1 says "Eyebrow + chips … nothing else",
   which read literally deletes a wire field the backend describes as an optional
   headline. Every sentence of that entry argues about the FRAME; none argues about
   the field. Silently discarding model output is not a change this charter makes,
   so the frame went and the field stayed.

**One thing measured rather than assumed:** the Accented register's 2px
`foreground/40` edge is invisible in a downscaled screenshot and legible at pixel
level, clearly heavier and darker than the hairline. It stays at /40.

### Pending — schema requests (backend)

| Field | Card | Justification | Status |
|---|---|---|---|
| `lane` (fine-lane keys) | legal_basis | LegalBasisCard.tsx:61–68 states the case verbatim; OIB vs RIS is the distinction architects compare most | **IMPLEMENTED** — as `Literal["baurecht_oib", "baurecht_ris"] \| None`, NOT the `'oib' \| 'law'` this charter asked for; see §B1 |
| `edition: str \| None` | legal_basis | `NormReference` has it and the schematics print it (kit.tsx:637); without it the product's most authoritative card cannot say which Ausgabe | **IMPLEMENTED** as specified |

Both require a change to `src/aiq_agent/cards/models.py`, regeneration of `shared/cards/schemas.json` via `scripts/generate_card_schema.py`, then `npm run generate:cards`.

### Known defects surfaced by this audit (not charter work, but should be filed)

| Defect | Evidence | Severity |
|---|---|---|
| Every `$ref` flattens to `z.any()`, so a card missing a **required** nested field passes validation and crashes the route — no error boundary exists | generated.ts:63 vs models.py:546, :550; RequirementChecklistCard.tsx:71–73 | **High** |
| `condition_tree` condition chip is `shrink-0`; a long condition squeezes the outcome to nothing on a phone | ConditionTreeCard.tsx:160 | Medium |
| `ProposalShell` spends `--warning` on the pending lifecycle state, colliding with "near a limit" | ProposalShell.tsx:12 | Low |
