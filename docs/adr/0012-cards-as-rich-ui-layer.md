# ADR-0012: Cards as a general rich-UI presentation layer

- **Status:** Accepted
- **Date:** 2026-07-05
- **Deciders:** Grid Agent team
- **Related:** [`../architecture/cards.md`](../architecture/cards.md), [`../architecture/backend-deep-dive.md`](../architecture/backend-deep-dive.md)

## Context

"Cards" were initially framed narrowly as legal-basis citation widgets. In
practice the agent often has structured output that reads far better as rich UI
than as prose — a summary, a proposed profile change, and (in future) checklists,
comparison tables, or applicability panels. Framing cards as a citations feature
under-served that.

## Decision

We will treat **cards as the agent's general rich-UI presentation vocabulary.**
The agent answers in markdown by default and emits a **typed card** whenever a
structured format serves the user better. Card generation is model-driven (the
model chooses when structure helps); the goal is a **first-class, robust output
channel** — one shared typed schema front+back and a frontend renderer registry,
so adding a card type is: define the model, add a renderer. `LegalBasisCard` is
one instance, not the definition.

## Consequences

### Positive
- Adding a card type is cheap and localized (schema + renderer), no pipeline surgery.
- Richer, scannable answers where structure helps; plain prose where it doesn't.

### Negative
- Card emission depends on model behavior; needs visible-failure handling, not a
  silent bolted-on call.

### Risks
- Silent card-generation failure looks identical to "no cards" — mitigated by
  making emission first-class and surfacing failures.

## Alternatives Considered
- **Cards = citations only** — rejected; too narrow; blocked reuse for summaries,
  profile patches, and future structured outputs.
- **Deterministic cards from retrieval only** — rejected as the general model; it
  fits the legal-basis subset but cards are, by nature, model-chosen rich UI.

## References
- [`../architecture/cards.md`](../architecture/cards.md)
