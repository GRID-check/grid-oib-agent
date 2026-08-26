# Grid Card Charter

> **Relation to `grid-design-language.md`.** The design language is the product-wide law: it governs every surface in Piloti — tokens, type ramp, spacing rhythm, motion vocabulary, provenance colour, the do-nots. This charter is the **card-specific application** of that law: it takes the general rules and resolves them into per-card decisions that the design language is too broad to make, and it adds constraints that only apply to cards (the figure rule, the shape vocabulary, the export-survival criterion). **Where the two disagree, the design language wins** — a conflict is a bug in this charter, and the fix is to change this file, not to deviate. Nothing here overrides `docs/design/grid-design-language.md`; where this charter is silent, the design language still applies in full.

**Purpose.** The product owner's brief: *"really also make each of the cards truly unique and look absolutely stunning here."* Not "same box, different accent colour and icon" — that is what exists and it is the complaint. This charter's job is the tension in that instruction: **maximum per-card distinctiveness inside one coherent system.**

**Audience.** Implementation agents work from this file as their contract. Every claim about the current state carries a `file:line` so it stays checkable.

**Sources.** §A and §B were rewritten in August 2026 against a design canvas in which the product owner rebuilt all forty-five card shapes side by side; it is recorded, with what was and was not taken from it, in [`output-cards-redesign.md`](output-cards-redesign.md). Where that canvas and this charter disagreed, the resolution is written into the section that resolves it — a decision that is not in this file did not happen.

---

## 0. Audit findings — the state on 2026-08-19

> **This section is a dated record, not a description of today.** It is the
> evidence the rules in §A were written against and it is left standing because
> §0.2 in particular is the argument for the whole charter. Some of what it
> reports has since been fixed — read **§E** for what is actually built.

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

> **Revision, 2026-08-26.** §A1–§A5 are rewritten against the design canvas
> recorded in [`output-cards-redesign.md`](output-cards-redesign.md). Where the
> canvas and the previous text disagreed, the disagreement is named at the end
> of the section that resolves it — this file is the contract, so a decision
> that is not written here did not happen.

### A1. One shell, three registers

Collapse the five chromes to one component with three declared registers. A register is a property of the card's **job**, never of taste.

- **Framed** — `rounded-lg border bg-card p-5 shadow-xs`. The card is an object separable from the prose: it can be cropped and pasted into an Einreichung and still make sense. Default.
- **Flat** — no border, no ground, sits directly on the answer surface. Only for blocks that are *part of the answer body*: `summary`, `follow_ups`, and — newly, from the canvas — `callout`, which is a stack of recessed panels with no outer frame at all.
- **Accented** — Framed plus a role mark. Exactly three cards, and the canvas shows the mark takes **two forms** depending on what the accent is about:
  - a **2px left edge in ink** when the card makes a claim you may act on — `legal_basis` (source-law), `verdict_header` (ink);
  - the **whole 1px border in the lifecycle tint** when the card is asking you for something and its appearance must change after you answer — the two proposals.

  A left edge says "read this first". A tinted perimeter says "this is not settled yet". They are not interchangeable, and neither is available to a fourth card.

**A fourth register is forbidden.** A new card picks one of these or it does not ship.

### A2. Type scale — seven steps, and one figure

| Step | Spec | Role |
|---|---|---|
| **Eyebrow** | `text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground` — via `SectionLabel`, never hand-rolled | **Retired inside cards** (see below). Still the product-wide section label everywhere else |
| **Meta** | 11px / 400 / `tabular-nums` or `font-mono` | ordinals, units, ± bands, counts, small print |
| **Caption** | 12px / 600 | pill and chip text — the only place 12px appears |
| **Body** | 13.5px / **500** / `leading-[1.55]` | every row of every list, every label. The default |
| **Prose** | 15px / **400** / `leading-relaxed` | running sentences: `summary`, the proposals' lede, `project_impact` |
| **Title** | 14px / 600 / `tracking-[-0.01em]` | the card title — **and every row title inside it** |
| **Value** | 15px / 600 / `tabular-nums` / `tracking-[-0.01em]` | a measured quantity sitting in a row |
| **Figure** | 20px / 600 / `tabular-nums` / `tracking-[-0.02em]` | **the one thing the card exists to say** |

**The load-bearing rule: each card carries exactly one element at the Figure step, and it must be the card's answer.** Not its title. Not its icon. Its answer. Where a card has no single answer, it spends no figure at all rather than picking one arbitrarily.

**Weight is a rule, not a preference.** Labels and list rows are 500; running sentences are 400. This is most of why the canvas reads firmer than what ships: a field of 400-weight 13.5px rows has no internal hierarchy, and every card was one.

**The eyebrow is gone from cards.** The canvas carries no uppercase label on any of its 45 sections — the title does the identifying, helped by the card's §A5 mark. §A5 already demoted the eyebrow to a caption; the canvas finishes the sentence. `SectionLabel` remains correct everywhere outside a card, and `SchematicCard`'s default eyebrow — fifteen drawings all saying the same word — is exactly the case that proves it earned nothing.

> **Where this departs from the previous text, and why.**
>
> **The figure was 20–30px and one element above 14px; it is now exactly 20px and one element at 20px.** Two changes, one reason. The canvas reaches its hierarchy by **lowering the floor rather than raising the ceiling** — no uppercase eyebrow, no pill badges, body rows that recede — so a 20px figure in a 636px column lands harder than 30px did in a column that shouted at every level. The old rule's arithmetic also failed against the canvas: `calculation` legitimately carries 15px formulas, a 20px result and a 15px limit. That is not three figures, it is one figure and two values, which is why **Value** is now a step with a name instead of an arbitrary size to be argued about.
>
> **Consequence:** `verdict_header` drops from 30px to 20px, and `.card-figure-24` / `.card-figure-30` lose their last callers and are deleted. `.card-figure-15` becomes `.card-value`.
>
> **`summary`'s 17px exemption is withdrawn.** The canvas sets it at Value over Prose — 15px both, one at 600 and one at 400 — and the cross-card rule survives as a demotion: **when a `verdict_header` is present, `summary`'s title drops to Body/600 in muted ink**, a lead-in label rather than a second headline. `card-set.tsx` already carries `hasVerdictHeader`; only what it switches changes. `.card-headline` is deleted.

**Migration.** The steps replace thirteen sizes. `text-xs` → Caption and nothing else; its use as body text is the drift to eliminate. `text-[12px]`, `text-[14px]`, `text-[13px]`, `text-[12.5px]`, `text-[10px]` all fold into the nearest step. A card migrates when it goes through its §C slice; a card that has been through a slice and still carries an off-ramp size has not passed, and `grid/card-type-scale` is switched on for it at the end of that slice so it cannot drift back.

Forbidden: any size not in this table.

### A3. Colour roles — five orthogonal axes, one rendering each

Chroma belongs to provenance (`grid-design-language.md` §Principles 2). These axes must never trade renderings.

**1. Verdict — "does it meet the rule?"** → the `statusColor()` inks, always with an icon carrying `aria-label` **and** the German word. Unchanged; it is correct.

**2. Modality — "how hard does this bind?"** → **weight and ink only, zero hue.**
- binding / decisive → `text-foreground font-semibold`
- interpretive / advisory → `text-muted-foreground font-normal`
- inactive / hypothetical → `text-muted-foreground` on `border-dashed bg-muted/30`

**3. The binding constraint — "which one decides it?"** In a set of checks, exactly one usually decides the verdict. The deciding row gets a **1px `--foreground` left rule and its value at the Figure step**; every other row stays Body with no rule. One per card, or none.

**4. Direction — "which way did it move?"** → glyph + word + a borrowed verdict ink:
- `tightens` → ↑ + „strenger" in `--text-color-feedback-warning`
- `relaxes` → ↓ + „milder" in `--text-color-feedback-success`
- `unchanged` → = + „unverändert" in `--muted-foreground`

Red is forbidden here: tightening is a cost, not an error, and error red is for errors only.

**5. Where each of the four is allowed to land — the canvas's sharpest rule, and it was never written down.**

> **Provenance colours pills. Status colours the icon and the status word, and nothing else.**

A card therefore carries at most two hues and they can never be confused, because they occupy different *shapes*: a tinted rounded rect with a border is always a source, a bare coloured glyph-plus-word is always a verdict. This is what lets `requirement_checklist` put a red cross and a blue OIB pill in the same row without the row becoming a traffic jam.

Corollaries, all of them load-bearing:
- **A status never becomes a pill.** `StatusBadge`'s tinted rounded-full chip is retired; a verdict is an icon and a word in the status ink, sitting in the card's header row or under the row it judges.
- **A source pill is never coloured by anything but its lane**, resolved through `accentForLane` (`features/chat/lib/source-kinds.ts`) and never from a document name by hand.
- **A tinted background is not a signal.** The recessed panel ground (`--input-background`) is a surface, carries no meaning and may appear in any card.

### A4. Density, spacing, geometry

- Card padding `p-5` (20px). Flat register: no padding, `gap-3` from the prose.
- Between blocks inside a card: 12px (`gap-3`). Within a block: 6px (`gap-1.5`). Above the source footer's rule: 20px. **These four values are the card spacing scale**; they are written as Tailwind steps and never as arbitrary values (`gap-[11px]` and `pb-[17px]` are drift).
- Scannable row min-height 36px, `pointer-coarse:` 44px, through the one exported `CARD_LIST_ROW` class (`features/grid-cards/components/card-rows.ts`) rather than four byte-identical copies. Rows GROW rather than take a `touch-target` catchment: stacked ~33px apart, 44px catchments overlap and the later row in the DOM takes taps meant for the one above it. A disclosure with prose around it (`CalloutCard`, `CalculationCard`) is the opposite case and takes the catchment.
- **Two gutter widths only**: 22px for a rail, 26px for a numbered node. Rails then align when two cards stack.
- Radius: cards `rounded-lg`, inner panels `rounded-md`, chips and pills `rounded-md`, action buttons `rounded-full`.
- Elevation: `shadow-xs` and nothing else in the transcript. Never two shadows in one card. In dark mode elevation is carried by the token, not by a `dark:` variant — see tokens.css:216–241.
- **The recessed inner panel is the one legal nesting.** `bg-[--input-background]` + hairline + `rounded-md`, optionally with a Meta caption above it. It is a *surface*, not a card, and it is how `calculation`, `change_impact`, `callout` and every schematic's drawing frame are built. **No card inside a card** still holds absolutely.
- Every table and every drawing scrolls inside its own `overflow-x-auto`.
- **Design to 636px desktop / ~314px phone** (§0.5.3). The canvas is set to 760px − 28px, roughly 70px wider than production: every two-column row taken from it is re-checked against 636px before it ships, and `/dev/cards`' `max-w-2xl` is no better a measure in the other direction.

### A5. How a card announces its type — the shape vocabulary

This is the mechanism that makes twenty voices one family. **The card's first 40px of geometry does the identifying**, now that the eyebrow is gone (§A2). Each mark below belongs to exactly one card and may not be borrowed:

| Mark | Means | Card |
|---|---|---|
| numbered accordion rows on a recessed ground that lightens when opened | ranked points you can unfold | `key_takeaways` |
| recessed calculation panels, each ending in a 20px result | a worked derivation | `calculation` |
| a status glyph in the left gutter with its word beneath the row it judges | criteria read against this project | `requirement_checklist` |
| numbered nodes on a continuous rail, one 20px figure per block | durations in the order they run | `deadline_timeline` |
| a completion glyph and a right-hand state column, **no rail** | a sequence with a position | `process_map` |
| one large figure under a title and nothing else, 2px ink edge | a ruling | `verdict_header` |
| stacked recessed panels with no outer frame | remarks beside the answer | `callout` |
| grid rows with one tinted column | a comparison | `comparison_table` |
| the active row breaking out through the card's own padding | mutually exclusive alternatives | `condition_tree` |
| a blockquote rule and a two-pill footer | a quotation | `legal_basis` |
| a three-column count header over a document list | documents with states | `document_checklist` |
| a recessed „before → after" hinge with the target at 20px | a delta | `change_impact` |
| a fully tinted perimeter and two buttons | an offer you must answer | the proposals |
| horizontal rules, no verticals | a data sheet | `typed_table` |
| stepped horizontal inset | a hierarchy | `norm_chain` |
| framed chips with no card around them | an offer, not evidence | `follow_ups` |
| sketched stroke | drawn from your numbers | schematics only |

**This table is the charter's most reusable artefact.** A new card must claim a mark that is not in it, or argue that an existing mark genuinely belongs to it and the incumbent should give it up. "It looks like the process map" is not a design.

> **Where this departs from the previous text, and why.**
>
> The previous table gave numbered nodes to `process_map` and ordered `deadline_timeline` to „vacate the numeral". The canvas does the opposite, and reading it settled the question better than either: **`process_map` vacates the rail.** Its steps become plain divided rows carrying a completion glyph and a state column; `deadline_timeline` keeps the rail and gains the 20px `period` figure the previous text asked for anyway. The two are then distinguishable at a glance because one has a rail and one does not — which is what the rule wanted — instead of by counting whether the circles have numbers in them, which it turns out nobody does.
>
> Marks that were specified and never built (`key_takeaways`' descending staircase, `requirement_checklist`'s segmented tally bar, `comparison_table`'s vertical-rules-only grid, `change_impact`'s struck-through ledger, `legal_basis`' right-margin § column) are replaced by what the canvas shows. They were good ideas argued from the code; these are good ideas argued from the whole set seen at once, which is the better vantage point for a rule about *distinctiveness*.

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

1. No font size outside the seven-step ramp in §A2, and no weight outside 400 / 500 / 600.
2. No card with two elements at the Figure step.
3. **No eyebrow inside a card at all** (§A2). `SectionLabel` stays the product-wide section label everywhere else; a card that feels it needs a type label has not claimed its §A5 mark.
4. No colour travelling alone. Every hue carries a word or an `aria-label`ed icon. Currently unbroken — keep it that way.
5. No status rendered as a tinted pill, and no source rendered as a bare coloured word (§A3 axis 5). The shape is what tells them apart.
6. No hex or `oklch` literal in JSX. `statusColor()` or a token. The `color-mix(in oklch, ${color} N%, transparent)` inline-style pattern (ComparisonTableCard.tsx:84, TypedTableCard.tsx:60, ConditionTreeCard.tsx:156) is the sanctioned escape hatch because Tailwind cannot compose a runtime colour — it may only ever mix a `statusColor()` result.
7. No `rough` stroke outside `SchematicCanvas`.
8. No nested card. The recessed inner panel (§A4) is the one legal form of nesting and it is a surface, not a card.
9. No chart with an axis the data does not have (§D.1).
10. No hardcoded user-facing string. `de/chat.ts` and `en/chat.ts` in lockstep, enforced by `key-coverage.spec.ts`. Translator keys are written as literals, never composed — a template-literal key silently ships the dot-path when it is wrong (DocumentChecklistCard.tsx:74–80).
11. No new dependency. `motion`, `roughjs`, lucide and Tailwind are the entire toolkit.
12. No serif, no display face, no third font family. Sans is prose; **mono means "a number or identifier you could go and check"** — spending it on a heading costs the product its one typographic signal.
13. No per-item field read without a fallback (§0.5.1).

---

## B. Per-card concepts

Format: **job** → **grammar** → **unmistakable** → **degradation** → **effort**.

### B1. The generic family

#### `verdict_header`
**Job.** Deliver the one number or ruling the reader came for, at the top of the answer.
**Grammar.** The card is the figure, and it is deliberately the shortest thing in the set. Title at Title step; the verdict directly under it at the **Figure step (20px)**, `text-balance`. A 2px ink left edge (§A1 Accented). Below a hairline rule, the source pill and nothing else. **No body list, no eyebrow, no prose** — the card is ~110px tall and that height is its signature.
Confidence is **not** dropped even though the canvas omits it: three 5px squares sit at the right of the title row, because a level is the only thing that makes two answers comparable and a pill never was. `confidence_reason` at Meta beneath the verdict.
**Unmistakable.** A single large number in a short accented card with nothing under it but one pill.
**Degradation.** Three shapes, all shown by the canvas and all required:
- **a value** (canvas §05) — the ordinary case;
- **a sentence** (canvas §22, `verdict_header_long`) — a compound ruling renders at the **Value step (15px/600)** rather than 20px, branching on string length and not on viewport, because the string is the problem;
- **no reference** (canvas §23, `verdict_header_bare`) — a figure read out of the project files with no rule behind it. The pill row is **absent**, replaced by a Body line saying where it came from. A card that invents a Fundstelle for a project measurement is the worst failure this card can have.

No confidence → the squares are absent and nothing shifts.
**Effort: S.**

#### `key_takeaways`
**Job.** The 2–5 points a skimmer leaves with.
**Grammar.** Each takeaway is its own **recessed panel with a hairline and `rounded-md`**, stacked with 8px between them — not rows in a divided list, which is what made the card generic. A row opens on click: chevron at the left in muted ink, then the ordinal at Meta in a fixed 18px column, then the title at **Title step**. The panel's ground **lightens from recessed to card white when it opens** — the disclosure state is carried by the surface, so an open row is legible before you read it.
Open body: the detail at Body, then the source pill, both indented to clear the ordinal column (66px).
Keep verbatim: a row with no `detail` is not a button.
**Unmistakable.** Separate recessed panels that lighten on open. Nothing else in the set changes ground on disclosure.
**Degradation.** 2 items still reads. Long compounds wrap with `text-pretty` — **never truncate a takeaway**, it is the payload. Missing `text` → skip the row silently (§0.5.1).

> **This replaces the descending staircase** specified in the previous revision and shipped in Sprint 1 (`b82f23e1`). The staircase encoded rank in indentation, which the export cannot carry (§D.5) and which a two-item card cannot show at all. The panel encodes *disclosure*, which is what the card actually does. The `lead` flag stops driving a type change — no card spends a figure on one of five equal things (§A2).

**Effort: S.**

#### `callout`
**Job.** The one sentence that changes what the reader does.
**Grammar.** **Flat register — no outer card at all.** The callout *is* its panel: recessed ground, hairline, `rounded-md`, `p-3`, a 21px icon well at the left in the tone's ink, the text at Body. Several callouts stack at 10px with no frame around the stack.
The disclosure stays: a Meta-sized „Mehr dazu" / „Weniger anzeigen" with a rotating chevron, the extra text at Meta beneath it, indented to clear the chevron.
The kind word and the title share one baseline; **the card has no eyebrow row of its own** and never did — preserve that, it is now the house rule rather than the exception.
Cap the measure at `max-w-[46ch]`: a remark narrower than the prose around it reads as an aside, one that spans the column reads as a section.
**Unmistakable.** The only block that is a bare recessed panel with an icon well and no card around it.
**Degradation.** Unknown `kind` falls back to `hinweis` and must, because `kind` arrives through a `z.any()` union member. Long compound title wraps under the kind word.
**Effort: S.**

#### `legal_basis`
**Job.** The product's proof-of-work — a citation you can verify.
**Grammar.** Framed, with a 2px source-law left edge (§A1 Accented). Title at Title step. The `original_text` is an actual `<blockquote>`: a 2px muted left rule, 16px of padding, the quote at **Prose step (15px/400, `leading-[1.65]`)** in full-strength ink — not muted, not italic. Italic at that measure hurts German compounds, and a quotation that is greyed out reads as an aside rather than as the law.
Below a hairline rule, a **two-pill footer**: the source pill carrying „OIB-Richtlinie 2 · Art. 3.1.1" with an external-link glyph and, beside it, a neutral outline pill „Zitat kopieren" with a copy glyph. Both `rounded-full`, because they are actions rather than labels. `edition` prints beside the identifier. `summary` at Body above the rule. The AI-transparency line (EU AI Act Art. 50) stays, and stays last.
`lane` resolves the OIB accent through `accentForLane`; it shipped as `Literal["baurecht_oib", "baurecht_ris"] | None` and is never re-derived from the law's name.
**Unmistakable.** The only card whose body is a real blockquote and the only one whose footer is two pills.
**Degradation.** No `original_text` → title + summary; the accent edge still identifies it. No article/section → the pill carries the law name alone. No corpus file behind the citation → the copy pill stands alone.

> **This replaces the recessed ground, the right-margin § column and the hanging quotation marks** of the previous revision, none of which were built. The margin column cannot survive 314px, and it was the one place the charter granted a decorative mark; the canvas gets the same authority out of a full-strength quotation and two honest actions, and it exports (§D.5) because both pills are text.

**Effort: M.**

#### `norm_chain`
**Job.** Which of these norms actually binds, and which only interprets.
**Grammar.** The card's subject is a *hierarchy* and it currently renders as a flat vertical list — every link at the same x (NormChainCard.tsx:58–99). Make it a **descending terrace**: horizontal inset by rank — bundesgesetz 0, landesgesetz 12, verordnung 24, oib_richtlinie 36, oenorm 48, leitfaden 60. The connector becomes an **elbow** that drops and steps right at each level change, so a reader sees "the ÖNORM sits two levels under the Verordnung" without reading a badge.
Binding links get a solid 3px left edge on their row block; interpretive links get no edge and 60% ink (§A3 axis 2 — weight and ink, no hue). The `bindingTag` caveat for `oib_richtlinie` („bindend, wo erklärt", line 43) stays as words — it is the card's most important honesty device.
**Unmistakable.** The only card with a stepped horizontal cascade.
**Degradation.** All links at one rank → flat cascade, which is *honest*; the elbow degrades to a plain rail. Unknown rank already falls back to the raw string, non-binding (line 55) — keep. Cap inset at `min(rank×12, 48)` on mobile; 6 links at 314px still leaves ~250px for the label.
**Effort: M.**

#### `requirement_checklist`
**Job.** Several criteria read against this project.
**Grammar.** Framed. Title, then rows divided by hairlines with no rule under the last one. Each row: a **status glyph in the left gutter** at the top-left, coloured in the status ink and carrying an `aria-label` — check, cross, or a question glyph for „Angabe fehlt". Then the title at Title step, the note at Body, and — **only when the status is not `ok`** — the status word at Body/600 in the status ink beneath. A satisfied row states its verdict through the glyph alone; spelling out „erfüllt" on every passing row is what turns the card into a wall.
Right-aligned in the row, the source pill. `needs_input` rows keep their `AskAboutChip`.
This card is the clearest case of §A3 axis 5: a red cross and a blue OIB pill sit in the same row and cannot be confused, because one is a bare glyph and one is a tinted rect.
**Unmistakable.** The only card with a status glyph in a left gutter and a source pill hard right on the same row.
**Degradation.** Unknown status falls back to the question glyph (§0.5.1) — and that is not an error state, it is the most common one. Long compounds wrap; the pill does not.

> **This replaces the segmented tally bar** of the previous revision. The bar was never built, it suppresses itself below three items, and „3 von 7 offen" is a sentence the card can simply say. It stays available as a derived Body line above the rows when the set is long; it is no longer the card's mark.

**Effort: M.**

#### `comparison_table`
**Job.** Genuinely weigh 2–3 options against each other.
**Grammar.** A CSS grid — `minmax(0,1.2fr)` for the criterion column, `minmax(0,1fr)` per option — with **horizontal hairlines only**, including one above the header row. Column headers at Title step; criterion cells at Body in muted ink, hard left with no left padding; value cells at Body in full ink.
**The mark is the tinted column**: the option that governs *this* project carries `bg-muted/40` down its whole height and its cells go to 600. A tinted band running the full height is what "side by side" actually means, and it is one derived decision rather than a favoured cell per row.
A legend under the grid states it in words: a 9px swatch plus „Getönte Zellen: die für dieses Projekt maßgeblichen Werte". The tint is then §D.5-safe, because the sentence exports even though the band does not.
**Unmistakable.** The only card with a tinted vertical band.
**Degradation.** Schema guarantees ≥2 options and the backend squares short rows, so render '—' muted for empties. 4+ options → `overflow-x-auto` with the criterion column `position: sticky; left: 0`. **Below 360px the card transposes**: one option per block, criteria as rows inside it. That transposition is the mobile *design*, not a fallback — three columns at ~100px each with „Brandabschnittsfläche" in them is unreadable at any type size. No governing option → no band, and the legend is absent rather than empty.

> **This replaces the vertical-rules-only grid and the win-tally strip** of the previous revision. The tally strip counted `highlight_index` wins per column, which reads as a scoreboard for a decision that is usually not a contest — most comparisons have one column that applies to you and one that does not. `typed_table` keeps horizontal rules too, and the two are told apart by the band and by mono figures, not by rule direction.

**Effort: L.**

#### `typed_table`
**Job.** The tabular long tail where every row is true at once.
**Grammar.** It should look like a table — that is its job. Make it look like a **data sheet**:
- Horizontal hairlines only (already `divide-y`), **no vertical rules ever**. A **1px `--foreground` rule under the header row**, replacing the current hairline (line 95).
- Column headers move to **Title step**, matching every other card's column header; the 1px rule under them is what makes the band read as a legend rather than as a first row. (The eyebrow is retired inside cards, §A2.)
- Numeric columns get `font-mono tabular-nums` (currently only `tabular-nums`, line 72).
- **The one chart this card earns**: a 2px **magnitude underline** beneath each cell of a `mass` column, scaled to that column's own max. Drawn only when *every* cell in the column parses as a number; otherwise nothing. It sits under a printed figure, so it adds no precision the number does not already carry. Hand-rolled SVG or a styled div — there is no charting library (§0.5.4).
**Unmistakable.** Mono figures with sub-cell magnitude rules; sole owner of that mark. `comparison_table` also rules horizontally — the two are told apart by that card's tinted vertical band and by this one's mono figures, not by rule direction.
**Degradation.** Unparseable column → no bars, plain sheet. This must be the *common* case, not an error state. Unknown verdict word already renders a neutral chip (line 50) — keep, it is right. Wide table → `overflow-x-auto` (already) plus a sticky first column, which is the whole mobile design.
**Effort: M.**

#### `condition_tree`
**Job.** The answer forks on one factor; here is your branch, and here is what the others would say.
**Grammar.** **This is the best card in the product.** Keep the four independent markings of the active branch, the Konjunktiv/Indikativ distinction in the German itself, and the correcting sentence inside the croppable rectangle.
Branches are divided rows under a hairline: the case at Title step in a fixed 88px column, then the outcome; the note at Body indented to clear the case column.
**The mark: the active row breaks out through the card's own padding.** It takes the recessed ground and negative horizontal margins equal to `p-5`, so it runs edge to edge of the card while every other row is inset. Its outcome goes to the **Value step (15px/600)** while the inactive ones stay at Title, and it carries „gilt hier" with a check in the project-green ink, right-aligned. A reader sees which branch is theirs from across the room, and the breakout survives greyscale and cropping.
The card closes with a recessed panel carrying the deciding factor in one sentence — „Maßgeblich ist die Gebäudeklasse — sie ergibt sich aus dem obersten Fluchtniveau."
**Unmistakable.** The only card where one row is wider than the others.
**Degradation.** No `active` → nothing breaks out, nothing is marked, and no case is picked for the reader. **Live mobile bug to fix here:** the condition chip is `shrink-0` (ConditionTreeCard.tsx:160); a long condition squeezes the outcome to nothing at 314px. Let the chip wrap with the outcome claiming a `flex-[1_1_9rem]` basis.

> **This replaces the SVG brace** of the previous revision. A brace draws the *shape* of a fork; the breakout draws the *answer*, which is what the reader came for, and it needs no hand-computed geometry (§0.5.5).

**Effort: M.**

#### `calculation`
**Job.** The Rechenweg, auditable by looking rather than by re-deriving.
**Grammar.** Framed, with the verdict as a glyph and word in the header row, right of the title (§A3 axis 5).
Each step is its own **recessed panel**: the step label at Title step, then the arithmetic on one baseline — the formula at the **Value step**, a muted `=`, the result at the **Figure step (20px)** — and the legend beneath at Body („2 × Steigung + Auftritt · zulässig ≤ 0,60"). All of it `tabular-nums`, and every quantity `font-mono`: mono is the product's claim that a number is checkable, and this is the card that most needs to make it (§A8.12).
Under a hairline, the limit row: „Zulässig" at Body muted, the band at the **Value step**, then the source pill hard right. The limit sits on the card's own baseline rather than inside a step, because it applies to the derivation and not to one line of it.
Untouched, and untouchable: no `result` on the wire, `resultDecimals` precision escalation, tolerance-band propagation, the straddle sentence at `warning`. That is the card's soul.
**Unmistakable.** The only card built out of stacked recessed panels each ending in a 20px number.
**Degradation.** Missing operand → the existing italic „fehlende Angabe", and the result is undecidable. The panel and the layout still draw, but the missing phrase renders at the **Value step, never at the Figure step** — a missing value must not be the biggest thing on screen. Operand labels truncate at 11rem with a `title`; 7rem below 360px. More than 4 operands in a step → stack them one term per line, which is also how a long Rechenweg is written on paper.
**Effort: M.**

#### `process_map`
**Job.** The Verfahren, and where this project stands in it.
**Grammar.** **The rail goes.** Steps become plain rows under a hairline, divided by hairlines. Each row: a 20px mark in the left gutter — a **check glyph in project green when the step is done**, otherwise a hairline circle carrying the step number at Meta — then the title at Title step with the `duration` chip beside it at Body muted, the note at Body beneath, and the state word right-aligned at Body/600, green when done and muted otherwise.
Keep: `duration` carries the Bauordnung's own words and is never a computed date.
**Unmistakable.** A completion glyph and a right-hand state column, with no rail anywhere.
**Degradation.** No `current_step` → every mark is a numbered circle, every state word muted, and nothing claims to know where the project stands. That rule is correct and must not be softened. Keep the existing wrap fixes for a narrow column.

> **This is the resolution of the `deadline_timeline` collision** (§A5). The previous revision ordered `deadline_timeline` to give up the numeral; the canvas gives up the rail here instead, which separates the two cards at a glance rather than by counting. `process_map` also loses the progress cap it was specified to gain — „Schritt 3 von 5" over a filled track is a second rendering of the state column, and the card only needs one.

**Effort: S–M.**

#### `follow_ups`
**Job.** Hand the reader their next question, already phrased.
**Grammar.** Flat register, as shipped: the optional `title` at Title step, then chips directly on the answer surface. Each chip is its own bordered `rounded-md` plate, `w-fit`, with a return-arrow glyph in muted ink and the question at Body. This is the one card that is **not evidence** and must never be screenshotted into a submission; being the only unframed trailing block is honest as well as recognisable.
**Unmistakable.** The only thing at the end of an answer with no frame around it.
**Degradation.** One line per chip with the whole question in `title`. At 314px set `min-w-[12rem]` and let the row wrap — „Wie wird das Hauptgeschoß…" is still useful, „Wie…" is not. Empty `items` → render nothing at all, not an empty heading.
**Effort: S.** Shipped in Sprint 1; the canvas confirms it.

#### `summary`
**Job.** The answer's headline and intro, flat on the result surface.
**Grammar.** Flat register. Title at the **Value step (15px/600)**, the content at the **Prose step (15px/400)** in full ink. Key points hang off a **2px `--foreground/20` left rule** at Body in muted ink — these are the answer's own emphasis, not a nested aside, so the rule is heavier than the hairline every disclosure panel uses.
**Cross-card rule (§A2): when a `verdict_header` is present, `summary`'s title demotes to Body/600 in muted ink** — a lead-in label rather than a headline. Two headlines at the top of one answer is the failure this rule exists to prevent, and demotion solves it without discarding a field the model filled. Dropping it outright was considered and refused for the reason the charter already gave about `follow_ups`' title: every sentence of this entry argues about **competing for the top**, none argues about the field. `card-set.tsx` carries `hasVerdictHeader`; only what it switches changes.
**Degradation.** No `content` → title + points. No `key_points` → title + intro, and the rule is absent rather than empty.
**Effort: S.**

#### `document_grid` (system card)
**Job.** The project files this answer leaned on.
**Grammar.** **Leave it.** It borrows `FileCard`/`FileGrid` from the documents feature (DocumentGridCard.tsx:6–8) and its distinctiveness is precisely that it looks like the Files page — a file should look the same everywhere in the product. Its unresolved and error states (document-surface.tsx:24–79) are already better-designed than most of the generic family. One check only: it must be **flat register**, because a frame around a grid of file cards is a card-in-card (§A4). Unframe if framed.
**Effort: S.**

#### `memory_proposal` / `project_profile_patch`
**Job.** Ask the user to commit something.
**Grammar.** Accented register in its second form (§A1): **the whole 1px border carries the lifecycle tint**, not a left edge. A perimeter is right here and an edge is not — the card is asking for something, and the state it is in belongs to the whole object rather than to its first column.
`memory_proposal`: title at Title step with the memory kind as a source-tinted pill on the same baseline; the proposition at the **Prose step**; under a hairline the scope question at Body and two `rounded-full` actions, „Verwerfen" outlined neutral and „Merken" in the lifecycle tint.
`project_profile_patch`: title, the reasoning at Prose, then a three-column grid — Feld / Vorher / Nachher — with hairlines top and bottom, the field at Title step, the old value at Body muted and **the new value at Body/600 on a recessed ground**. The recess marks the cell that would change; nothing is struck through, because the patch has not been applied yet and a strike would claim it had.
Disabled state (no project in context) keeps the button visible and muted with the reason spelled out beside it, never hidden.
**Unmistakable.** The only cards with a fully tinted perimeter, and the only ones with buttons.
**Degradation.** `pending` must not spend `--warning`; it collides with "near a limit" everywhere else. Post-decision the perimeter goes neutral and the buttons are replaced by the outcome in words.
**Effort: S.** The `--warning` fix shipped in Sprint 1; the perimeter and the patch grid are new.

#### IFC cards (`ifc_viewer`, `ifc_schedule`, `ifc_element`, `ifc_diff`, `ifc_compliance`, `ifc_model_picker`)
**Job.** Point at the actual building.
**Grammar.** Leave the interiors alone. They are a coherent family already, and their identity is structural: they contain live data the agent never supplied (IfcDataCards.tsx:5–11). Only ask: adopt the common shell so the reader does not meet a sixth chrome.
**Effort: S each, shell swap only.**

### B2. The three cards of 2026-08-19

All three landed in commit `67c2ee03`. **They are well-built**: derived tallies with no summary field on the wire, honest three-state unknowns, no fabricated values, correct wrap treatment for the narrow column. Nothing below asks for a rewrite. What they lacked is **differentiation from each other and from `process_map`** — §0.2, the finding that started this charter. Each now has its §A5 mark and its §A2 figure, and needs nothing else.

They stay in their own section rather than being folded into §B1 because §0.2 is the charter's central evidence: three competent cards, built on one afternoon by someone following the shared pattern, arriving as the same card three times. The rules in §A exist to stop the next one, and this section is what they were written against.

#### `document_checklist`
**Job.** The Einreichliste as *states*, not names.
**Grammar.** Framed. Title, then **the mark: a three-column count header** — „erforderlich 3 · bedingt 2 · vorhanden 1" — ruled top and bottom, each column a Body label over a **Value-step** number, divided by vertical hairlines, the „vorhanden" figure in project green. It is derived entirely from the rows and asserts nothing the data does not hold. Below it the documents as divided rows: a status glyph in the left gutter (present / missing / unknown — three faces, and the distinct unknown must not be collapsed), title at Title step, note at Body, and the requirement tag as a pill right-aligned.
Conditional rows indent 16px, so the card reads as two tiers — always-required and it-depends — which is the reader's actual first question.
**Unmistakable.** The only card that opens with a ruled three-column count band.
**Degradation.** No status anywhere → the count band is **absent** and a sentence takes its place; a „0 von 5" line would be a claim about the project. 16 items → cap at 8 rows with an „alle 16 anzeigen" disclosure (local state, presentational). Long compounds wrap; the issuer column collapses under the label below 360px.
**Schema:** fully served.
**Effort: M.**

#### `deadline_timeline`
**Job.** Several Fristen in the order they run, each with what starts its clock.
**Grammar.** Framed. **The mark: numbered nodes on a continuous rail** — a 19px hairline circle carrying the ordinal at Meta, on a 1px vertical line that runs from block to block and **stops halfway through the last one**, so the sequence visibly ends rather than trailing off. The rail keeps the numeral now that `process_map` has given up the rail entirely (§A5).
Each block: the label at Body muted, `period` at the **Figure step (20px)**, „ab {starts_from}" at Body, then the source pill. `consequence` sits on the block's last line prefixed `→` in warning ink with its word — a lapsed Frist is a cost, not an error, so no red.
The rail is **never scaled to duration** and the footer says so out loud. A bar whose length meant anything would claim that four weeks and four years sit on one timeline; the refusal is load-bearing and the footer sentence is what carries it into the export (§D.5).
**Unmistakable.** The only stack of 20px figures down a numbered rail.
**Degradation.** 2 deadlines is the schema minimum → two blocks, still reads. **Guard:** `period` at 20px for ≤18 characters, at the Value step above that, so „binnen vier Jahren ist mit dem Bau zu beginnen" cannot dwarf the card.
**Schema:** fully served.
**Effort: M.**

#### `change_impact`
**Job.** What one moved fact costs.
**Grammar.** Framed. **The mark: a recessed hinge panel at the top** — the factor's name at Body muted, then `from_value → to_value` on one baseline with the old value at the **Value step in muted 400**, a muted arrow, and the new value at the **Figure step (20px)**. The weight and size difference *is* the delta; nothing is struck through, because a strike says "deleted" where the card means "superseded".
Under a hairline, the derived direction tally in words — „**3** verschärft · **1** unverändert" at Body with the counts in full ink. Then the consequences as divided rows: `aspect` at Title step with the direction tag as a pill on the same baseline, and `before → after` beneath at Body with the after value at 600.
`reference` is required on this card and optional almost everywhere else, so **every row is cited** — that always-populated pill is part of the card's look.
**Unmistakable.** The only card that opens with a recessed before/after hinge.
**Degradation.** When `from_value` is absent the left slot is an **empty dashed outline** with the existing „bisher nicht bekannt" — an absent origin must be visible as an absence, because a delta with an unknown origin is a materially different claim. 1 consequence is the minimum and still earns the card. `unchanged` rows (validator guarantees `before == after`) → print the value once with „unverändert", never twice. Below 360px the hinge stacks: factor, then before → after on its own line.
**Schema:** fully served.
**Effort: M.**

### B3. The schematics — honest judgement

**Eleven are genuinely good and need nothing but the shell and token pass.** Saying so plainly is part of the job; manufacturing work here would cost the schematics the quality they already have. Verified by reading the code and by looking at `visual/screenshots/cards-gallery.{light,dark}.png` and `.mobile.*`.

> **What the 2026-08 canvas contributes here, and what it does not.** It supplies the **outer anatomy** — title with the verdict as a glyph and word in the header row, the drawing inside a recessed panel under a Meta caption, limit rows as label / value / limit on one baseline over a 7px track, a source pill to close. That is §A applied, and it lands through `SchematicCard` and `LimitBar` rather than card by card.
>
> It supplies **no geometry.** `stair_diagram` stands in the canvas at 15 SVG primitives against 619 lines of real architectural templates in the code; it illustrates what the card says, it does not specify it. The eleven strong drawings are untouched.
>
> Two canvas sections go **backwards** and are deliberately not followed: `acoustic_check` (§24) and `energy_performance` (§25) are drawn there as plain bar rows. The first is the defect this section names below; the second removes a ladder that is correct and exempted by name. A design source is evidence, not an instruction, and this is where it is overruled.

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
| `acoustic_check` | **A drawing in name only.** Measured: canvas 0, svg 0, rough 0. Three `LimitBar`s in a `SchematicCard` (:71–131). The widest gap in the product between promise and delivery. | Draw the real thing: **two rooms separated by the building part under test, with the sound path drawn** — an airborne arrow *through* the wall for DnT,w / Rw,res, a footfall arrow *down through the slab* for LnT,w. The drawing then does visually what the card currently explains in words (`lowerIsBetter` / `higherIsBetter`, :100–104): direction. Keep the margin figure („Reserve +3 dB") and promote it to the **Value step**. | **L** |
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

**Sprint shape.** Sprint 1 (items 1, 4, 6, 17, 18, 19) shipped in `b82f23e1` and
established the ramp and the colour-role fix in real code. The 2026-08 revision
reopens several of those cards — that is a revision and not a regression, and
what it costs is stated in §E.

What follows is organised by **what shares a shell**, not by card, because §A2's
ramp and §A3's axis 5 land once in `SchematicCard` / `LimitBar` / the source
pill and restyle twenty-four cards before a single card file is opened.

- **Sprint 2 — the shared shell.** Split `kit.tsx` (§A7). Drop the eyebrow row
  and move the title into the header (§A2). Retire `StatusBadge`'s pill for a
  glyph and a word (§A3 axis 5). Replace `NormRefFooter` with the source pill
  atom, tinted through `accentForLane` and never by hand. Rebuild `LimitBar` on
  the one-baseline shape, leaving the tolerance and straddle logic untouched.
  Extend the ramp with **Prose** and **Value**, delete `.card-figure-24/30`.
  Nothing here is a card, and everything after it is cheaper.
- **Sprint 3 — the answer's top.** `summary`, `verdict_header` and its two
  shapes, `key_takeaways`, `callout`, `follow_ups`. Every answer opens and
  closes with these; they are also where §A1's registers get proved.
- **Sprint 4 — the reasoning.** `calculation`, `condition_tree`,
  `requirement_checklist`, `legal_basis`, then `comparison_table` last. Its
  transposing mobile layout is the hardest single thing in this charter.
- **Sprint 5 — sequence and inventory.** `deadline_timeline`, `process_map`,
  `document_checklist`, `change_impact`. `process_map` gives up its rail in the
  same commit `deadline_timeline` keeps one, or the two are briefly identical.
- **Sprint 6 — the rest.** `norm_chain`, `typed_table`, `diagram`,
  `document_grid`, the proposals, the fifteen schematics (anatomy only) and the
  six IFC cards (shell only).

A card falls under `grid/card-type-scale` at the end of the sprint that touches
it — that is the ratchet, and it is why the allow-list lives in
`eslint.config.mjs` rather than inside the rule.

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

**Last updated: 2026-08-26.** Two things have happened to this file.

**Sprint 1 shipped** (`b82f23e1`, 2026-08-19): the type ramp, the §A3 colour-role
fix, and items 1, 4, 6, 17, 18, 19.

**§A1–§A5 and most of §B were rewritten** against the design canvas recorded in
[`output-cards-redesign.md`](output-cards-redesign.md). That revision **reopens
four cards Sprint 1 had closed** — `key_takeaways`, `verdict_header`, `summary`
and `callout` — and it is worth being plain about the cost: roughly a morning of
shipped work is being redone. It is worth it because Sprint 1 designed those
four cards one at a time against the code, and the canvas designed forty-five at
once against each other, which is the only vantage point from which a rule about
*distinctiveness* can actually be checked. Three of the four changes are also
simplifications (a staircase becomes a panel, 30px becomes 20px, a shrunken
title becomes no title).

Below, **Pending** means designed and not built; **Done** means built and
matching this file as it now stands; **Reopened** means built, shipped, and
superseded by the 2026-08 revision.

### Pending — system

| Item | Section | Status |
|---|---|---|
| Split `kit.tsx` into `cards/shell.tsx` + `schematics/draw.tsx` | A7 | Pending |
| One shell, three registers (two accent forms) | A1 | Pending |
| Type ramp: add **Prose** and **Value**, delete `.card-figure-24/30` | A2 | Pending |
| Weight rule (rows and labels 500, running sentences 400) | A2 | Pending |
| Figure rule at 20px, one per card | A2 | Partly — rule written, `verdict_header` still at 30px |
| Eyebrow retired inside cards; `SchematicCard`'s default eyebrow removed | A2 | Pending |
| Axis 5: provenance colours pills, status colours glyph + word | A3 | Pending — `StatusBadge` is still a tinted pill |
| Source pill atom resolved through `accentForLane`, replacing `NormRefFooter` | A3 | Pending |
| `LimitBar` on the one-baseline shape | A3 / B3 | Pending |
| `ProposalShell` pending-tone fix (no `--warning`) | A3 | **Done** (Sprint 1) |
| Card spacing scale (12 / 6 / 20, no arbitrary values) | A4 | Pending |
| Recessed inner panel named as the one legal nesting | A4 | Pending |
| Shape-vocabulary table adopted as the gate for new cards | A5 | Pending |
| Motion policy (no in-card entrance, no springs in card bodies) | A6 | Pending |

### Pending — per card

| # | Card | Section | Effort | Status |
|---|---|---|---|---|
| 1 | follow_ups | B1 | S | **Done** — frame dropped; `title` deliberately KEPT, see note below. Canvas confirms |
| 2 | comparison_table | B1 | L | Pending — tinted column, not the vertical-rules grid |
| 3 | requirement_checklist | B1 | M | Pending — glyph gutter, not the tally bar |
| 4 | key_takeaways | B1 | S | **Reopened** — recessed panels that lighten on open, replacing Sprint 1's staircase |
| 5 | legal_basis | B1 | M | Pending — blockquote + two-pill footer, not the margin § column. Schema landed (`284b2625`) |
| 6 | verdict_header | B1 | S | **Reopened** — 20px not 30px, three shapes incl. `bare`. Confidence squares KEPT against the canvas |
| 7 | deadline_timeline | B2 | M | Pending — keeps the numbered rail, gains the 20px figure |
| 8 | change_impact | B2 | M | Pending — recessed hinge, no strike-through |
| 9 | norm_chain | B1 | M | Pending — canvas silent, previous design stands |
| 10 | document_checklist | B2 | M | Pending — three-column count band |
| 11 | acoustic_check | B3 | L | Pending — canvas goes backwards here and is overruled (§B3) |
| 12 | typed_table | B1 | M | Pending — canvas silent, previous design stands |
| 13 | calculation | B1 | M | Pending — recessed step panels, 20px results |
| 14 | condition_tree | B1 | M | Pending — the breakout row, not the SVG brace. Includes the `shrink-0` mobile bug |
| 15 | process_map | B1 | S–M | Pending — **gives up the rail**; ship with #7 |
| 16 | parking_requirement | B3 | M | Pending |
| 17 | summary | B1 | S | **Reopened** — drops its title outright under a `verdict_header` |
| 18 | callout | B1 | S | **Reopened** — flat register, no outer card |
| 19 | proposals (memory / patch) | B1 | S | Partly — `--warning` fix done; tinted perimeter and patch grid pending |
| 20 | density_check | B3 | S | Pending |
| 21 | document_grid | B1 | S | Pending (register check only) |
| 22 | the eleven strong schematics | B3 | S each | Pending (anatomy only — **do not redesign**) |
| 23 | the six IFC cards | B1 | S each | Pending (shell alignment only) |

### Sprint 1 — what shipped, and where it departed from this charter

Landed in `b82f23e1`. Two departures were argued and upheld on review; both are
recorded because the reasoning outlives the code.

**The ramp is `@layer components`, not `@utility`.** A type step sets four or five
properties and a card legitimately overrides one of them. In the utilities layer,
which of `card-title` and `font-semibold` wins depends on Tailwind's internal
ordering; in the components layer the ramp is a base every utility beats, by layer
order rather than by luck. Enforced by `grid/card-type-scale`, switched on per
file through `CARDS_ON_THE_TYPE_RAMP` in `eslint.config.mjs` — the compliant set
is real project state and belongs in config, not in an exemption list inside the
rule, which would report "clean" with eleven cards still off the ramp.

**`follow_ups` keeps its `title`.** §B1 said "Eyebrow + chips … nothing else",
which read literally deletes a wire field the backend describes as an optional
headline. Every sentence of that entry argued about the FRAME; none argued about
the field. Silently discarding model output is not a change this charter makes,
so the frame went and the field stayed. The canvas shows the same headline and
settles it.

**The confidence gauge is three 5px squares, not three 12×3px bars.** As first
specified the mark failed at the top of its own range: a meter filled to full and
a rule are the same picture, so at „hohe Sicherheit" it read as a decorative
em-dash and the comparability the gauge exists for was exactly what it lost. The
problem is the cell SHAPE — a square is a token, a bar is a stroke. ▪▪▪ reads as
three-of-three; ▪▪▫ and ▪▫▫ still read as levels. **The 2026-08 canvas drops the
gauge entirely and is overruled** (§B1 `verdict_header`): it is the only thing
that makes two answers comparable, and its cost is three squares.

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
