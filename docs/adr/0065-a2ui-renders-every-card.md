---
status: accepted
date: 2026-09-24
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# A2UI renders every card, and an answer may compose them

## Context and Problem Statement

A card is the model's structured output: typed JSON, validated, drawn by one
of ~40 React components. Everything between the JSON and the component was
ours: the per-type dispatch (`GridCardItem`), the wire shape (a flat `cards`
array addressed by `[[card:N]]`), and no way at all to put two cards in
relation — side by side, or as the variants of one question in tabs. The
product owner's ask was plain: depend on a library for this, not on a
constrained generative-UI system we invented.

The field has converged on the constrained shape we already had — the agent
picks components from an allow-listed catalog and fills their props, the
client draws them with its own components — and has standardised it. The
candidates, read at the package level (packages unpacked, APIs run):

- **A2UI** (Google, Apache-2.0). A protocol (v0.9.1 stable, v1.0 a
  candidate): a surface is a flat list of components, `{id, component,
  …props}`, linked by id, rooted at `root`. `@a2ui/web_core` validates and
  holds surfaces; `@a2ui/react` draws them; a catalog is ours, custom-only is
  supported, and each of our components is registered once.
  `a2ui-core` (Python) carries the protocol models and the structural
  validators (duplicate ids, missing root, dangling references, cycles).
- **MCP Apps** (the MCP UI extension). A tool returns an HTML resource the
  HOST draws in a sandboxed iframe. It is how a third party's UI appears
  inside Claude or ChatGPT; inside our own app every card would become an
  iframe outside our design system. The right answer to "Piloti inside
  another assistant", a separate decision.
- **AG-UI.** An event stream between agent and frontend. It would replace our
  WebSocket and BFF events, not the card layer.

## Decision

**Every card is drawn through A2UI.** `@a2ui/react` with a custom-only
Piloti catalog (`features/a2ui/`): one A2UI component per card type, named by
the card's `type`, wrapping the existing component; plus `Row`, `Column` and
`Tabs` with the basic catalog's shapes and our design system. A stored card
is a one-component surface; `cardToSurfaceMessages` makes it one, so every
message ever stored renders through the same path.

**An answer may compose.** The envelope's `cards` array accepts a `surface`
card: an A2UI component list whose leaves are content cards and whose
containers are `Row`, `Column` and `Tabs`. It is validated twice before it is
stored: its structure by `a2ui-core`'s integrity and topology checks, each
leaf by the same Pydantic card model a lone card goes through. System and
interactive card types may not be leaves: their decisions are keyed by
position in the message, and a position inside a surface is not one.

**Amended 2026-09-24: a `Text` leaf.** A surface may also hold `Text` (A2UI's basic
catalog name, narrowed to `text` of Markdown), drawn by the answer's own
Markdown renderer. Leaves that could only be cards left `Tabs` unable to hold a
variant's table, which the Markdown-first answer never puts on a card, so the
one use case composition exists for could not be built. See
[`docs/architecture/cards.md`](../architecture/cards.md) for how its
citations are held to the prose's.

**What is deliberately not adopted.** A2UI's basic catalog (its styles are
empty in 0.11.1 and it registers Lit elements on import); data binding and
`updateDataModel` (a card is a statement about retrieved sources, not live
state); A2UI actions (the interactive cards keep `useCardDecision`,
ADR-0030); the Python agent SDK (it requires Google ADK and genai, and its
prompt is ~6–10k tokens of JSON Schema where our contract is ~3.5k). The
model keeps writing card objects; only composition is A2UI-shaped.

## Consequences

- One renderer path for every card, owned by a library, with the protocol
  documented at a2ui.org rather than in this repository.
- Composition becomes possible: variants as tabs, related drawings side by
  side on a wide column (stacked on a narrow one).
- **Cost.** ~38 KB gzip on the client. `@a2ui/react` has no server snapshot,
  so a card renders directly on the server and through A2UI after mount; the
  two outputs are the same component, so there is no visible swap.
- **Churn.** Nearly every minor release of A2UI has broken its API. The pins
  are exact: `@a2ui/react` 0.11.1 and `@a2ui/web_core` 0.11.0
  (`frontends/ui/package.json`), `a2ui-core==0.1.1` (`pyproject.toml`). The
  two npm versions differ because 0.11.0 is the newest `@a2ui/web_core`
  published, and `@a2ui/react` 0.11.1 depends on `^0.11.0`. An upgrade is its
  own change with the `features/a2ui` tests as the gate. v1.0 is the next
  move.
- A render failure inside A2UI (a validation error, a library bug) falls back
  to the direct component, so no card is lost to the library.

### Confirmation

- `frontends/ui/src/features/a2ui/A2uiCard.spec.tsx`: the real `@a2ui/react`
  over the Piloti catalog draws a stored card with its fields intact, a
  `Tabs` surface one tab at a time, every child of a `Row`, and a surface it
  refuses as its cards.
- `GridCards.render-coverage.spec.tsx`: every type in the card union renders
  through `GridCardItem`, which is the A2UI path.
- `tests/aiq_agent/cards/test_surface_card.py`: `a2ui-core` refuses a dangling
  reference, an orphan, a cycle and a duplicate id; each leaf is checked by its
  own card model; tool, interactive and envelope cards cannot be leaves; the
  contract teaches the shape.
- `tests/aiq_agent/cards/test_surface_excluded_parity.py`:
  `SURFACE_EXCLUDED_LEAVES` covers every system, envelope and interactive
  type, and `cards/models.py` and `features/a2ui/catalog.tsx` list the same
  types.
- `/dev/a2ui` marks each card A2UI drew; a browser probe over it is how the
  "every card, no fallback" claim was checked when this was adopted.
