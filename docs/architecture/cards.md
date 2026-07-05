# Cards — the agent's rich-UI presentation layer

> How GRID's agent returns structured, rendered UI instead of plain prose when
> that serves the user better. See also [ADR-0012](../adr/0012-cards-as-rich-ui-layer.md).

## What a card is

A **card** is a typed, structured piece of an answer that the frontend renders as
rich UI rather than markdown. Cards are the agent's **presentation vocabulary** —
not a citations feature. The agent answers in markdown by default and emits a card
whenever structure helps the reader. `LegalBasisCard` is one instance; the set is
meant to grow.

## Current card types

Defined in `src/aiq_agent/cards/models.py` as a discriminated union (`GridCard`):

| Type | Purpose | Key fields |
|---|---|---|
| `SummaryCard` | A short overview / key points | `title`, `content`, `key_points` |
| `LegalBasisCard` | An OIB legal-basis citation | `law`, `article`, `section`, `summary`, `original_text` |
| `ProjectProfilePatchCard` | A proposed change to the project profile | JSON-Patch `ops` (restricted to `/facts`, `/goals`, `/unknowns`, `/assumptions`) + before/after preview |

`validate_cards()` validates against the union and drops null fields.

## How generation works

Card generation is a model-driven step in the chat workflow: after the graph
produces an answer, `ChatResearcherAgent._generate_cards(query, context)` prompts a
card LLM (`card_generator_llm`) with a schema-derived system prompt
(`cards/prompt.py` introspects the union so the prompt stays in sync with the
models), parses the JSON, and validates it. The result rides `ChatResponse.cards`,
which the monkeypatched WS handler lifts onto the top-level message so the frontend
reads it at `message.cards`.

Generation is **skipped when the turn only dispatched an async deep-research job**
(the answer is just the job stub — cards for the real answer belong to the job
pipeline).

## How cards render

The frontend validates the wire cards (`validateGridCards`) and renders them
through the `features/grid-cards/` component set — one renderer per card type.

## Design intent (why it's a layer, not a feature)

Adding a new card type should be: **define the model** (`cards/models.py`) → **add
a renderer** (`features/grid-cards/`). No pipeline surgery. That keeps the set open
to future types (requirement checklists, comparison tables, applicability panels)
without re-plumbing generation or transport.

## Known rough edges

- Card-generation logic is duplicated between `cards/generate.py` and the inline
  `ChatResearcherAgent._generate_cards` — candidate for consolidation.
- Deep-research (async job) answers do not yet carry cards end-to-end.
- A silent card-generation failure is currently indistinguishable from "no cards";
  emission should surface failures.
