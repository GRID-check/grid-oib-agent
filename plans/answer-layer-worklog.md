# Answer-layer overnight worklog

Persistent memory for the recursive improvement loop toward ONE goal:
**better, richer, nicer answers.** Survives context compaction — every wake-up
reads this first, updates it, and re-arms.

## Operating rules (learned the hard way)
- **Finish by asking "anything else that would make this better?"** (standing
  instruction from the user). Landing the task is not the end of the task. Every
  sprint closes with that question asked deliberately and ANSWERED — either with
  the next item, or with a stated reason the surface is done. The best findings
  of this run came from asking it: the deep path's disclaimer, the inert
  `grid-agents: deep_researcher`, and the gallery rendering in English were all
  found after the work that preceded them was already "done".
- **Max 2 concurrent build agents.** Three at once exhausted the account
  session limit (21:10 UTC) and killed an agent mid-flight with no output.
- **Explicit file ownership per agent**, disjoint. Concurrent agents in this
  tree have twice swept up each other's files; `git add -A` is banned.
- **Every agent captures its own test baseline first.** The suite total moves
  when develop merges land, so a hardcoded number goes stale.
- Full `vitest run` OOMs in this container — run changed specs only. CI shards.
- Rebase onto `origin/claude/nifty-galileo-n0cw74` before pushing; a maintainer
  merges develop into it periodically.

## Done (this branch)
| commit | what |
|---|---|
| 6302033a | card catalogue L1/L2 split + `describe_card` (~5,200 → ~700 tok/turn) |
| f37b7ccb | card schema documents itself in English |
| c2bf8498 | standard skills are APPLIED (forced); `piloti-voice` seeded (0053) |
| 0b646beb | four builtin OIB genre skills, each carrying its cards |
| 422766d4 | trust signals survive the backend persist path |
| 40d96785 | inline card placement (`[[card:N]]` + remark plugin) |
| 5adcfb18 | cards/skills docs realigned |
| a40ff86e | DOCX export, no new dependency |
| e9c9259f/eb84c156/4d7ee37c/0d136276 | clarifier picker options, `ask_user`, wire fix |
| 5e839b41 | binding status (`rank` + `binding_status`) to the client |
| acd240b2 | verdict_header, condition_tree, typed_table, norm_chain |
| 67a1da97 | `grid-hidden` flag + reasoning-view preference |
| 96608f5e | binding pill in the peek + house voice muted in disclosure |
| 6ea82566 | preference fetched once, not per answer (CI shard-1 fix) |
| a07fba4c | ConditionTreeCard redesigned: real tree, click-to-expand |
| 54d546bf | `ifc_model_picker` — click a tile, viewer opens, no LLM round-trip |
| 47ecc019 | `<answer_shape>` (inverted pyramid) on both writers + card markers taught up front (B2-prompt, B7) |
| dfd2b576 | genre skills rewritten in English, German terms kept as terms of art (B6) |
| 4be91c2d | lede typesetting for a long answer (B2, frontend half) |
| 929a6c69 | `<answer_shape>` scoped to research turns |
| 45cd9f07 | `key_takeaways` + `callout` — the two GENERIC cards; `summary` restyled |
| 8878f678 | trace step labels: no CamelCase span name reaches the reader, both locales |
| da5108de / 5cc3657b | worklog + `docs/architecture/cards.md` brought back to 33 types, `[[card:N]]` documented |

## In flight
- `follow_ups` card (B1) — chips that prefill the composer
- answer action row (B3) — copy answer / copy with citations

## Governing principle (user's own words, distilled)
> "nicht zurück zum LLM … ich klick das und sehe mehr"

**Interactive PRESENTATIONAL cards.** Click reveals more, client-side. Never a
second model turn. This is the pattern every new card should follow.

## Backlog — see "Research grounding" below for why each is here
(ordered; loop takes from the top, re-orders as evidence arrives)

| # | item | why it is here | owner |
|---|---|---|---|
| B1 | **post-answer follow-up chips** — 2–4 agent-written next questions under every answer, anchored to facts the answer itself stated, prefilling the composer via the existing `setComposerPrefill` path | strongest externally-evidenced gap: ~40% of Perplexity users click related questions. Shallow path emits none today; only `suggested_follow_up_queries` exists, deep-path only (`subagent_contracts.py:165`) | — |
| B2 | **answer lede** (prompt half done 47ecc019; frontend typesetting open) — first paragraph of a long answer typeset as a lede (larger, calmer), so the answer opens with a claim instead of a wall | Harvey/NN-g: the "inverted pyramid" is what makes a long legal answer skimmable; we already ask for a verdict but never typeset one | — |
| B3 | **answer actions** — save as Prüfvermerk / adopt into project brief / copy citation block, sitting with the existing export | closes the loop from *read* to *use*; DOCX export (a40ff86e) proved the appetite and the plumbing | — |
| B4 | **`process_map` card** — generic: an ordered procedure (Einreichung, Abnahme, Bauverfahren) with a current-step marker, click a step to see what it requires | user asked for MORE cards like the Entscheidungsbaum, "nicht so extrem spezifisch". Procedure is the second-most-common shape after a fork | — |
| B5 | **`fact_sheet` card** — generic: label/value pairs with provenance per row (from your project profile / from OIB / assumed), click a row for the source | makes the answer's *inputs* auditable, which is the thing a Ziviltechniker actually re-checks; also kills the "where did that number come from" round-trip | — |
| ~~B6~~ | ~~**skill authoring pass**~~ (done dfd2b576) — rewrite the four genre skills against the Agent Skills guide: name/description as the only always-loaded surface, procedural body, no restated facts | user: "wie man skills macht … extremst viel verbesserungen"; the guide's own rule is that the description is the router and the body is the procedure | — |
| ~~B7~~ | ~~**card-marker discipline in the prompt**~~ (done 47ecc019) — the answer prompt never tells the model that `[[card:N]]` exists; only the tool return does | placement only works if the model plans for it *before* it emits; a tool-return-only instruction arrives too late to shape the paragraph | — |
| B8 | **empty/short-answer floor** — a one-line answer with no card and no citation currently renders as a bare sentence in a large empty pane | the worst-looking answers are the shortest ones, and they are common (yes/no questions) | — |

## Research grounding
(appended per wave — never add an item without a reason recorded here)

### Wave A (follow-ups, lede, actions)
- **Follow-up chips.** Perplexity reports ~40% of users click a related
  question; the pattern is 2–4 chips, contextually anchored to specific facts
  in the answer just given, with *diverse* types (clarifying / depth probe /
  comparison / action nudge / export) rather than four rephrasings of the same
  question. Anchoring matters more than count: generic chips ("tell me more")
  measure far worse than ones naming a term the answer introduced.
  → B1. Reuses `setComposerPrefill`, already proven by the welcome chips
  (`ChatArea.tsx`), so this is zero new interaction machinery and zero LLM
  round-trip — it satisfies the governing principle.
- **Inverted pyramid.** Both Harvey's published design principles and long-form
  legal-UX practice put the conclusion first and typeset it differently from
  the reasoning that follows, because the reader's question is "what is the
  answer" and the reasoning is the audit trail they read second. We ask the
  model for a verdict but render every paragraph at one weight. → B2.
- **From read to use.** Anthropic's "writing tools for agents" argument
  generalises: the output is only finished when it lands in the artefact the
  user was going to produce anyway. → B3.

### Wave B (generic cards)
- User instruction, verbatim: *"machst du mehr so cards wie den
  entscheidungsbaum bitte welche die nicht so extrem spezifisch sind sondern
  das ergebnis einfach schöner machen."* The card census shows the vocabulary
  is heavily *substantive* (stair, egress, thermal, fire) and thin on
  *rhetorical* shapes. `key_takeaways` and `callout` (in flight) are the first
  two; a procedure and a provenance sheet are the next two most common shapes
  an OIB answer actually takes. → B4, B5.

### Wave C (prompt + skill hygiene)
- **Agent Skills.** The description is the only text always in context; it is a
  router, not documentation. Bodies should be procedural ("when X, do Y, emit
  Z"), never restatements of domain facts the model already has or that could
  go stale — a skill that asserts a numeric OIB limit is a liability. → B6.
- **Progressive disclosure cuts both ways.** We moved card shapes to L2
  (`describe_card`), which is right, but the *placement* contract now lives
  only in the L1 tool return — i.e. the model learns markers exist only after
  it has already committed to a paragraph. → B7.

## Picked up along the way (small, unowned, do when nothing else holds the file)
- `docs/architecture/cards.md` says **27 types**; it is 32 model-facing + 2 system.
  `verdict_header`, `condition_tree`, `typed_table`, `norm_chain`,
  `ifc_model_picker`, `key_takeaways`, `callout` are all undocumented.
- `thinking.herleitungSummary` interpolates `{sources}` unconditionally, so a
  measurement answer reads "Herleitung · 3 Schritte · 0 Quellen". Also
  un-pluralised: "1 Schritte". Needs a no-sources variant + plural handling in
  both dictionaries. (i18n files were owned by another agent when found.)
- Two comments now describe old behaviour: `features/skills/lib/skill-activity.ts:18`
  and `features/chat/lib/live-activity.ts:10`.
- **`verdict_header` vs the new lede.** `<answer_shape>` now demands the first
  sentence BE the ruling, and `verdict_header` puts the ruling in a card at the
  top — so an answer doing both says it twice. `_CARD_DOCTRINE` has to say which
  one wins: the card is for a ruling that is a VALUE worth showing large
  (number + status), the lede is the sentence that qualifies it, and they must
  not be the same words. Blocked while another agent owns `register.py`.

## Considered and REJECTED (do not re-propose)
- **Click-to-expand on schematic check rows.** Looked like the highest-leverage
  application of "ich klick das und sehe mehr" — 15 cards at once. It is not:
  `DimChecksList` (`schematics/kit.tsx`) already prints label, value, ± band,
  provenance chip and the limit inline, and `DimensionCheckData` carries no
  per-check reference, so there is nothing left to reveal. Moving the band or
  the provenance behind a click would be a REGRESSION — the code comment there
  argues, correctly, that „2,47 m ±5 mm" is what decides whether a 2,50 m
  minimum is held, and a reader who has to click for it will not.
- **Visual redesign of the schematic cards.** ~~Reviewed the rendered gallery…~~
  **CORRECTED at `de23eb69`.** I diagnosed the English "LEGAL BASIS" eyebrow as
  "the gallery running the EN dictionary, not a German-UI leak" and filed it as
  harmless. The diagnosis was right and the conclusion was wrong: the GALLERY IS
  THE EVIDENCE SURFACE, and evidence rendered in the wrong language cannot show
  a language bug. „Ask about this" was sitting in the middle of a German
  Anforderungsliste in the committed screenshot and nobody could see it, because
  the cards with hardcoded German copy looked right — and the newest cards are
  exactly the translated ones. `/dev/cards` and `/dev/chat-turn` are now pinned
  with `fixedLocale`, which the doc had already documented as a required gotcha.
  **Lesson: never file a finding about the evidence surface as "not a product
  bug" — an instrument that reads wrong is the first thing to fix.**
  The schematic geometry did hold up at desktop width, which was the other half
  of that review and stands.

## Backlog additions
| # | item | why it is here | owner |
|---|---|---|---|
| B9 | **report outline for deep-research reports** — a section list built from the markdown headings, sticky beside `ReportTab`, click to jump | a deep report is a long document rendered in a side panel with NO navigation at all. Every long-form legal/research surface (Harvey, Perplexity Pages) has an outline; ours makes the reader scroll to find out what is in it. Note: needs i18n keys, so it serialises after the answer-actions agent releases the dictionaries | — |

---

# Sprints

The loop runs in sprints from here. A sprint is 2 subagents max (the session
limit killed a third once), each with a disjoint OWN-ONLY file list, launched
together, landed together, pushed together, then the next sprint is planned from
what they found. I plan and verify; the agents implement.

## Sprint 3 — landed
- `ea18a437` `follow_ups` — 2–4 chips, each anchored to something the answer
  introduced, click prefills the composer via `setComposerPrefill`. Nothing is
  sent; `presentational` in `CARD_INTERACTIVITY`. The product owner's verdict:
  "truly something new and exactly the idea we were going for" — so this is the
  SHAPE to look for, not a one-off. See the follow-ups-direction backlog.
- `5bd4a04c` answer actions — the answer can leave the app.

## Sprint 4 — landed
**S4-A · the hidden presentation skill.** `piloti-cards`: DB-owned like
`piloti-voice` (migration, `delivery: 'standard'` so it is always applied,
`grid-hidden: "true"` so it never shows in the skills disclosure but still emits
its activation event). Its `grid-cards` metadata names the GENERIC cards —
`key_takeaways`, `callout`, `follow_ups`, `verdict_header`, `condition_tree`,
`typed_table`, `norm_chain` — which makes `_preferred_cards_block` inline those
SHAPES on every turn, so the cards that fire on an ordinary answer never pay a
`describe_card` round-trip. Body is the presentation procedure: when an answer
earns a takeaway block, when it earns exactly one callout, when it earns
follow-ups, and — the open conflict — how `verdict_header` and the new lede
divide the ruling between them without saying it twice.
Why DB-owned rather than builtin: this is output STYLE, tunable without a
deploy, which is the same argument that put `piloti-voice` in the database.
The genre skills stay builtin because they encode domain procedure.

**S4-B · no internal vocabulary reaches a reader.** (Prompt half landed as
`674a6510`: the agent may no longer write "shelf" or any translation of it; the
four levels keep their product names.) "Shelf" is a dev word.
`chat.thinking.status.documents.several` says „Unterlagen aus Ihren Ablagen"
/ "Reviewing documents from your shelves" — the only real leak in the
dictionaries, but the agent can also say it in prose, because
`<knowledge_shelves>` in `researcher.j2` opens "four nested document shelves".
The four have real user-facing names (Basiswissen, Büroarchiv, Projektwissen,
Private Sitzung); those are what a reader may see. Sweep the whole user-facing
surface for the same class of leak (corpus/Korpus, registry, payload, node,
marker, card type names) and add a prompt line forbidding the container word.

## Backlog — the follow-ups DIRECTION (user: "exactly the idea we were going for")
What made `follow_ups` right: the reader gets a way forward without having to
phrase it, the app already had the mechanism (`setComposerPrefill`), and the
click costs nothing. Same shape, other surfaces:

| # | item | why |
|---|---|---|
| B10 | **`condition_tree` branch switching** — click a branch that is NOT the active one and see its outcome, already authored, no round-trip | the card already carries every branch's outcome and shows only one. "Was gilt bei GK 3?" is answered by data on screen |
| B11 | **`needs_input` rows become a question** — a checklist or schematic row the answer could not decide gets a chip that prefills "Das fehlende Maß ist …" | the card already names exactly what is missing; today the reader has to retype it |
| B12 | **any card row → composer** — generalise the follow-up mechanism so a row that names a term can ask about it | one mechanism, many surfaces; this is the reusable version of B10/B11 |
| B13 | **measurement provenance peek** — click a number that came from `ifc_measure` to see method, tolerance and the GlobalIds, the way `[N]` peeks a citation | citations already peek; measured numbers do not, and they are the ones a reader most needs to defend |

## Context budget — measure it every sprint, it creeps
Taken at `d4f5ced0`:

| what | ~tokens, every turn |
|---|---|
| `_CARD_DOCTRINE` | 1,194 |
| `render_card_index()` | 892 |
| `emit_card` HOW preamble | ~190 |
| **`emit_card` description total** | **2,272** |
| `render_card_details()` for the seven generic types | 1,835 |

The L1/L2 split cut this from 5,209 to ~700. It is back at 2,272 because every
card added a trigger line AND a paragraph of craft, and `piloti-cards` would add
1,482 more. **Rule from here: the tool description holds the CONTRACT (trigger
table, negative default, `[[card:N]]` placement) and nothing else; the craft
lives in `piloti-cards`, which is DB-owned and editable without a deploy.**
Follow-up commit after S4-A lands: move the craft paragraphs out of
`_CARD_DOCTRINE` and re-measure.

## Sprint 5 — planned
- **S5-A · the follow-ups mechanism, generalised** (grid-cards). Branch
  switching on `condition_tree` (every branch's outcome is already on the card,
  only one is shown), and a reusable "ask about this" affordance so a
  `needs_input` row — which already names exactly what is missing — becomes a
  prefilled question instead of something to retype.
- **S5-B · report outline** (B9, `layout/ReportTab`). A deep report is a long
  document in a side panel with no navigation at all.

### Budget, re-measured with tiktoken (cl100k_base — chars/4 was wrong both ways)
After `55d53e5f` (the skill) and `3f8c8e4a` (the split):

| what | tok/turn |
|---|---|
| `_CARD_DOCTRINE` | 1,089 → **708** |
| `emit_card` description | 2,126 → **1,745** |
| `piloti-cards` inlined shapes (5 types, not 7) | **1,199** |
| **total cards cost per turn** | **2,944** |

Seven types would have been 1,945 → 3,690 total. `norm_chain` (375) and
`typed_table` (269) are the most expensive AND the narrowest, so they are taught
in the skill body but left to a `describe_card` round-trip on the rare turns
they fire. A ceiling test in `test_tool_description.py` now fails if the
description drifts past 2,300 — deliberately slack, so it catches creep and not
a single added trigger line.

**Rule, now enforced by tests on both sides:** a new card type adds a TRIGGER
LINE to `_CARD_DOCTRINE` and its PARAGRAPH to `piloti-cards`. The two halves are
asserted against each other, because deleting a paragraph and forgetting to
write its replacement is invisible in review.

## Sprint 4 — result
- `55d53e5f` `piloti-cards` seeded. Settles verdict_header vs the lede as a
  SPLIT: the card carries the VALUE (copyable — a number, a class, „Nicht
  geregelt"), the prose carries the SENTENCE that qualifies it. Cover one, the
  other must still be incomplete. Same words in both → the card goes, not the
  sentence. Five inlined types, not seven (`norm_chain` 375 tok and
  `typed_table` 269 tok are the most expensive AND the narrowest).
- `3f8c8e4a` craft moved out of `_CARD_DOCTRINE`; ceiling test added.
- `600ea144` de-jargon sweep — far wider than the one line: the knowledge page
  told a Ziviltechniker about a Korpus, an Ingestion, chunks and a Backend; 15
  schematic cards wore an English "Schematic" eyebrow above German titles; the
  deep-research panel enumerated our planner/researcher/writer tiers and offered
  „Gedankenkette und Inferenzaktivität des LLM". 12 specs updated with it.

## Sprint 5
- **S5-A landed `21d2de45`.** Branch switching is a SELECTION model (one open at
  a time, active open by default). The screenshot hazard — a reader capturing
  the wrong case — is defended in four independent layers, and the two that
  matter survive cropping and greyscale: the active row keeps „trifft zu" and
  `aria-current` no matter what else is open, and the GRAMMAR carries it
  („Für dieses Projekt gilt:" indicative vs „Bei GK 5 würde gelten:" Konjunktiv
  II). A previewed panel also names the case that actually holds, inside its own
  rectangle. `AskAboutChip` is the reusable form of the `follow_ups` mechanism —
  one component, two call sites (`RequirementChecklistCard`, `DimChecksList`),
  building the sentence itself so the two cannot drift into two phrasings.
- **S5-B landed `010ab256`.** A sticky collapsible bar across the top of the
  report's scroll box, not a rail — the report column is ~580–670px on desktop
  and ~360px on mobile, and a readable rail needs ~200px of it. Collapsed by
  default, and the collapsed row already prints the section in view, so "you are
  here" is delivered without opening anything. Threshold 4 entries. Stays away
  entirely while the report streams (a half-arrived heading slugs to an id that
  stops existing a token later). `slugify` moved verbatim to
  `MarkdownRenderer/utils.ts` as `headingAnchorId` so outline and renderer
  cannot drift; a spec renders through the REAL renderer and asserts every id
  resolves. The `## Quellen` section — the one readers jump to most — is lifted
  out by `splitReportSources` and had no id at all; it does now.

## Sprint 6 — candidates (found by the sweep, not yet scheduled)
- **`{workflow}` renders a raw kebab-case id** in `research.thoughtCard.via` /
  `toolCallCard.via` — "über researcher-agent". Same class as the CamelCase span
  names fixed in `8878f678`; needs a name map like `chat.thinking.nodeName`, so
  it is a component change, not a string change.
- **`thinking.activity.usingSkillUnnamed`** („Skill wird angewendet …") fires
  when no skill can be named, so it names the mechanism to a reader who may
  never have opened the Skills page. Weakest surviving case of "Skill" as
  product vocabulary.
- **`en/skills.ts` says "toolbox" where `de` says „Bibliothek"** — locale
  mismatch, not a leak.
- **`deepResearch.stats.tokens`** is described („Textmenge {count}") rather than
  renamed because there is no honest reader-facing unit. The real fix is
  probably to drop the stat.

## Sprint 6 — in flight
- **S6-A landed `297e574f`.** The doctrine now lives in `catalog.py` as named
  constants assembled by `render_card_doctrine(include_ifc_triggers=...)`,
  mirroring `render_card_catalog(include_model_backed=...)`. `register.py`'s
  `_CARD_DOCTRINE` is byte-identical to before, so no test moved. Withheld
  post-hoc: the `[[card:N]]` contract (the job runner emits the report unchanged
  and attaches the list — there is no text to place into, so list order IS
  render order and got a three-line ordering rule instead), `describe_card`, and
  the `ifc_model_picker` TRIGGER but not its shape. The picker deliberately does
  NOT join `MODEL_BACKED_CARD_TYPES`: that set means "copy the fields from an
  `ifc_query` row", and the picker names no file and invents nothing —
  conflating "cannot fill" with "should not trigger" would put the wrong reason
  on the wrong set. Craft: inlining the skill body was rejected on cost (~2,600
  tok) AND on truth — most of it teaches how a card and the prose beside it
  divide the work, and this path cannot edit the prose. What went in is the
  subset that is a TEST OVER A FINISHED TEXT, 503 tok. Post-hoc prompt
  6,972 → 8,168 (once per report, not per turn); `emit_card` unchanged at 1,745.
- **S6-A original finding:** `cards/prompt.py` still
  says "Only include a card when it adds real value" — the exact disclaimer that
  left fifteen diagram renderers unused on the shallow path until `6302033a`
  replaced it with a trigger table. It is still standing on the surface that
  produces the LONGEST answers, i.e. the ones that most need a takeaway block, a
  callout and follow-ups. Share the doctrine, withhold the parts that are false
  post-hoc (placement, `describe_card`), keep the anti-fabrication rule loudest
  — this path only ever has the report text, so a card inventing a figure here
  is worse than on the other path because nothing checked it.
- **S6-B · identifiers reaching the reader.** Duplicate `##` headings produce
  duplicate anchor ids, so the second outline entry scrolls to the first
  section (flagged by S5-B, belongs in the renderer for every surface at once).
  And `research.thoughtCard.via` prints a raw `researcher-agent` — the same
  class as the CamelCase span names fixed in `8878f678`.

## Sprint 7
- **S7-B landed `cc7a860f`.** The plural bug was not one string, it was a
  MISSING MECHANISM. The i18n layer supported interpolation only, and the
  convention — hand-written `…One`/`…Other` pairs picked in the component — is
  exactly why ~33 counted strings nobody thought about never got a pair.
  `interpolate` now understands `{count, plural, one {# Schritt} other
  {# Schritte}}`, ICU cut to the two categories de and en distinguish (CLDR
  gives both the same cardinal rule, so selection is `n === 1` with no per-locale
  table). That turned every fix into a one-line dictionary edit instead of ~66
  new keys plus ternaries in ~25 components. „0 Quellen" now DROPS the clause: an
  answer grounded in a measurement is entitled to no citations, and a true zero
  that reads as failure is worse than silence. The token stat is gone, key and
  all — no unit a reader was ever shown, and a measure of OUR cost inside a
  sentence about THEIR report. `usingSkillUnnamed` removed: the line named the
  mechanism and could not name the skill.
  Full suite run in seven non-overlapping batches: 6,984 passed, 82 skipped.
- S7-A: visual evidence refresh + design QA — in flight.

## Sprint 8 — candidates
- **`research.thoughtCard.tokens`** — „Textmenge: {prompt} Eingabe /
  {completion} Ausgabe" is the same euphemism `cc7a860f` deleted from the
  banner, one surface away in `ThoughtCard.tsx`. Same verdict should apply.
- **`platform*.ts` plurals** — ~33 strings still on the „Turn(s)" parenthetical.
  Administrator surface, deliberately out of scope twice now; each is a one-line
  fix under the new mechanism whenever someone wants it.
- **Duplicate-heading ids in the RENDERER are fixed; `AgentCard` was the last
  raw identifier found.** If another appears, the pattern is settled: a map to
  an i18n key, a neutral fallback, and never drop the row.
- **S7-A landed `de23eb69`.** Also added `condition-tree` and `report-outline`
  preview routes + targets (both drive an interactive state, which needed a
  module-scope guard — `reactStrictMode` runs the effect twice and the naive
  driver photographed the panel it had just closed, now a documented gotcha).
  Three real defects found by looking: the outline's active-section rule was
  drawn on a `rounded-md` anchor so it printed as a parenthesis; the „Dazu
  fragen" chip stretched to a full-width bar in the schematic legend (column
  flex container); the Bedingungsbaum's correcting sentence wrapped into a
  four-line column beside its button on a phone.
  Honest verdict recorded for `DimChecksList`: it HOLDS at 624px and at 352px —
  the label truncates first and no number is lost. Good, since the earlier
  "reject click-to-expand" decision assumed exactly that.

## Sprint 8 — in flight
- **S8-A landed `f7d76627`.** Worse than reported: **13 of 19 schematics were
  cut at the card edge on a phone.** `SchematicCanvas` had a per-card `minWidth`
  pixel floor (440 stair, 430 section, 420 guardrail…) and the gallery card
  interior is 582px at desktop but **300px at a 390px viewport** — so the SVG
  stopped shrinking and was clipped. `building_section` printed "G" and "F"
  where it should have said „GK4-Grenze +11 m" and „Fluchtniveau +9,2 m" — the
  two numbers that card exists to state. Guardrail lost its Bodenspalt arrow and
  „3 cm" entirely. Fix: no floor at all (`width: 100%`), plus a 1.4× blow-up cap
  — the generalisation of the cards that already looked right, which were
  rendering at 1.19–1.36 units-per-pixel, while the door was being stretched to
  2.97×. Section/stair/ramp/guardrail come out byte-identical. Uniform scale in
  both axes, so no ratio a drawing asserts about itself moved. Door 905px → 546,
  turning circle 713 → 518, both now SHORTER than the median schematic card.
  One real geometry bug found on the way: the turning circle's wall poché ran
  4 units past its own viewBox. `cards-gallery` now has a mobile target, which
  is why this class of defect was invisible.
  **Verified the mobile capture myself** — the section's two marker labels read
  whole at 390px.
- **S8-A original finding:** Drawings overflow right below ~400px
  (guardrail, ramp) — a dimension arrow with a number on it can be clipped off.
  Door and turning-circle render 700–800px tall for two numbers. Undetected
  because `cards-gallery` has no mobile target; adding one is part of the fix.
- **S8-B landed `8afd1cf8`.** `piloti-voice` OWNS answer shape. The
  tenant-editability counter-argument I offered was checked and does not hold:
  a `delivery: 'standard'` name resolves to the platform row or to nothing
  (`lib/skills/service.ts:634-650` — `createSkill` refuses the name and the
  resolver deletes a legacy org row that shadows it), and `platform_skills` sits
  behind `grid_secure_platform_table`. So craft in that row is exactly as
  un-tenant-editable as craft in the prompt, AND editable without a deploy.
  `<answer_shape>` survives as 97 tokens of ROUTING. Shipping it needed a new
  migration `0055` with an `ON CONFLICT DO UPDATE … WHERE md5(body) = <hash of
  what 0053 seeded>` — the hash, not `created_by`, is the guard that works,
  because the dashboard patches `body` and never touches `created_by`, so an
  edited row still reads `system`. Validated on a real Postgres across all five
  cases. Per-turn cost +278 tok (German is ~2× its English equivalent); 337 tok
  left the prompt permanently.
- **S8-B original finding:** `<answer_shape>` (330 tok, English,
  prompt), `piloti-voice`'s „Der erste Satz ist die Antwort" (inside 1,717 tok of
  German skill body, forced every turn), and the deep writer's own "open with the
  answer" paragraph from `47ecc019`. Same class as the card doctrine/craft split
  — resolve it the same way, and note that editing seed `0053` does NOT change a
  database that already ran it (`ON CONFLICT DO NOTHING`), so shipping a body
  change needs more than an edit.

## THE FINDING (biggest of the run) — a promise nothing keeps
`grid-agents: "shallow_researcher,deep_researcher"` is **inert on the deep half**.
`SkillResolver(agent=…)` is constructed in exactly one place — `shallow_researcher/register.py:170` —
always with `"shallow_researcher"`. Nothing ever asks for the deep agent.

The deep path has a SEPARATE skills mechanism: `deepagents_runtime.py` mounts
builtin skill FILES into a sandbox at `/skills/`, selected per DeepAgents agent
by YAML. It never reads `platform_skills`.

So **`piloti-voice` and `piloti-cards` have never reached the surface that writes
the LONGEST answers.** Deep reports get their shape from one paragraph in
`writer.j2` and nothing else. Both seeds declare `deep_researcher` and neither
gets it.

Sprint 9-A is investigating whether platform skills can be materialised into the
deep sandbox (a platform skill IS a name + description + body, i.e. a SKILL.md),
with an explicit fallback: if that needs a new DB dependency inside the Dask
worker, stop promising it instead — an honest limitation beats a half-working
feature. Either way the metadata stops lying.

**Note this does NOT undo `297e574f`:** the deep path's CARD doctrine lives in
`cards/prompt.py`, not in a skill, so that half does reach it.

## Sprint 9 — in flight
- **S9-A landed `3e32ad95`.** Split verdict, on evidence: **(a) for
  `piloti-voice`, (b) for `piloti-cards`.** The resolver never touches the
  database — it is an HTTP GET to the BFF, and the Dask worker ALREADY makes
  exactly that class of call (`runner.py:642` resolves BYOK credentials the same
  way), so option (a) needed no new I/O path and no cache. The only real gap was
  the org id, which now travels on the agent state beside `project_context`
  rather than by injecting `x-grid-organization-id` globally — that would have
  silently switched on org-scoped memory writes and org model-default resolution
  inside every job. `piloti-cards` was WITHDRAWN from deep (`0056`): the deep
  writer has no card tool at all, deep cards are post-hoc from a separate pass,
  so delivering it would hand a surface with no `emit_card` an instruction to
  emit cards plus ~1,300 tokens of shapes. Guarded on the metadata, not a body
  md5 — an owner who rewrote the prose did not choose a scope; one who used the
  agent picker did.
  **One test was replaced, correctly:** it asserted
  `agents_with_a_runtime == {"shallow_researcher"}` — true of the code and wrong
  as an assertion, because it pinned the LIMITATION instead of the contract.
- **S9-A original question:** See THE FINDING above.
  Explicit fallback authorised: if it needs a new DB dependency inside the Dask
  worker, stop promising it instead. Either way the metadata stops lying.
- **S9-B · the card layer's strings.** The layer grew fast and some of it is
  hardcoded German literals (`FollowUpsCard`'s „Weiterfragen"), which cannot be
  translated, cannot be reviewed by whoever edits copy, and are invisible to
  `key-coverage.spec.ts`. Plus the `ThoughtCard` token euphemism `cc7a860f`
  deleted one surface away, and the mobile answer footer wrapping the copy
  actions away from the thumbs they borrow their language from.

## STILL OPEN — found by S9-A, not acted on
1. **The deep skill-collection mount is unassigned in the reference config.**
   `deep_research_agent.skills` defaults to `None` and
   `configs/config_oib_openrouter.yml` sets no `skills:` key, so `skills_enabled`
   is False, `/skills/` is never mounted, and `SkillsMiddleware` is never
   attached. The writer prompt's "## Skill Preflight" has been telling the model
   to inspect an "Available Skills" section **that is not rendered**. Consequence:
   the builtin `synthesis` writer skills AND the four `oib` genre skills never
   reach deep research either. Production-behaviour decision, not a bug fix —
   needs a human call.
2. **A scheduled deep job's `force_skills` is silently dropped** —
   `DeepResearchAgentState` has no such field, so an attached skill reaches the
   run only through the composed prompt.

## Sprint 9B landed `8adfe2ab` → rebased as part of the batch
The card layer was saying ~110 of its own words as hardcoded German literals —
untranslatable, invisible to `key-coverage.spec.ts`, and unreachable by whoever
edits copy. All routed. The `statusLabel` "cannot call a hook" constraint an
earlier agent recorded as unfixable WAS fixable: the repo already had the
pattern (`applicable-standards.tsx` passes a `Translator` as an argument), so
the pure helpers now take one and no literal is left in the kit.
Correctly-hardcoded findings, stated rather than implied: symbols (`±0,00`, `Ø`,
the north arrow's `N`, the A++–G ladder), units, and — the interesting one —
`TypedTableCard`'s verdict vocabulary and `DimensionDiagramCard`'s `pick`
keywords, which look like copy but are the words the BACKEND writes, matched to
tint a cell or locate a dimension. Translating the matcher would only stop it
recognising its own input; annotated so it is not audited again.
**Warning recorded:** `npm run format` produces a very large unrelated diff —
the repo is not prettier-clean and has no format gate.

## Branch state (checked 2026-08-19 ~00:20 UTC)
**PR #461 is MERGED** (17:58 UTC, head `6ea82566`, now in develop). Everything
after it — 40 commits — sits on the branch with **no open PR and no CI run**.
Local verification is green (pytest 3834/42, ruff clean, tsc 0 errors) but no
sharded vitest, no CodeQL and no image build has seen any of it.
**REBASED onto `origin/develop` (b2c61bde) and force-pushed — 42 commits, zero
conflicts, 0 behind.** Post-rebase verification, all green:
pytest 3861 passed / 42 skipped · ruff check clean · ruff format 331 files clean
· tsc 0 errors · lint 0 errors (2 known warnings) · vitest 50 files/799 tests
(grid-cards + i18n + layout) and 61 files/1230 tests (chat + shared).
Still NO open PR and still no CI — that decision is the user's.

## Asking "anything else?" — round 1 (2026-08-19)
Opened `visual/screenshots/chat-turn.light.png`, the only committed screenshot
of a WHOLE finished answer. I had reviewed the card gallery repeatedly and never
this. Findings:

**The canonical finished answer contains no card and no follow-ups.** The
question in it — „Wie viele Rettungswege brauche ich für ein Bürogebäude der
Gebäudeklasse 4 in Wien?" — is textbook `requirement_checklist` (first Fluchtweg,
second Fluchtweg, the 40 m limit) and textbook `follow_ups`. The fixture predates
every card built this run and was never updated.

Two consequences, and the second is the serious one:
1. Our own showcase of a finished answer does not exercise the answer layer.
2. **Nobody has ever seen a card INSIDE an answer.** Every card has been reviewed
   in the gallery, isolated, on a bare page. "Does this look right in a gallery"
   and "does this look right wedged between two paragraphs, under a lede, above a
   provenance footer, at the thread's real column width" are different questions,
   and only the second one is the product. Marker placement (`[[card:N]]`), the
   lede + `verdict_header` interaction the `piloti-cards` skill adjudicates, and
   whether two cards in one answer crowd it — none of that is visible anywhere.

Confirmed working in the same image: „Herleitung · 1 Schritt · 4 Quellen" (the
plural fix), „AUSGEFÜHRT: OIB-Wissen" (the step-label fix), „Einschätzung: hoch",
and the copy actions sitting with the thumbs rather than adrift.

### Sprint 11 (queued)
- **`/dev/chat-turn` must show the answer layer.** A finished answer carrying an
  inline-placed card, a second card at the fallback position, a lede long enough
  to trigger, and follow-up chips — at desktop AND mobile width. This is the
  review surface the whole run has been missing.
- Then look at it and fix what it exposes.

