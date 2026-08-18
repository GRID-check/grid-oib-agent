# Answer-layer overnight worklog

Persistent memory for the recursive improvement loop toward ONE goal:
**better, richer, nicer answers.** Survives context compaction — every wake-up
reads this first, updates it, and re-arms.

## Operating rules (learned the hard way)
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
- **Visual redesign of the schematic cards.** Reviewed the rendered gallery
  (`frontends/ui/visual/screenshots/cards-gallery.light.png`) at readable scale.
  `building_section`, `stair_diagram` and the new generic cards all read well in
  light and dark. The "LEGAL BASIS" eyebrow in that screenshot is the /dev/cards
  gallery running the EN dictionary, not a German-UI leak — `cards.legalBasis`
  is „Rechtsgrundlage".

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

## Sprint 4 — in flight
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
| `render_card_details()` for the seven generic types | 1,482 |

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
