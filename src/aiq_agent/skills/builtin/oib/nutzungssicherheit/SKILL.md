---
name: nutzungssicherheit
description: >
  Safety in use and accessibility. Load when the question involves Treppe or
  Stiege, Steigung and Auftritt, Schrittmaßregel, Laufbreite, Podest, Geländer,
  Brüstung, Absturzsicherung, Öffnungsweite, Rampe, Neigung, Bewegungsfläche,
  Wendekreis, lichte Durchgangsbreite, Türbreite, barrierefreier Aufzug,
  Kabinenmaße, or any requirement of OIB Richtlinie 4.
metadata:
  grid-agents: shallow_researcher,deep_researcher
  grid-cards: stair_diagram,guardrail_check,dimension_diagram,elevator_requirement,legal_basis
---

# Answering a safety-in-use or accessibility question

## A dimension belongs drawn, not described

This is the one genre rule everything else rests on: an answer that turns on a
dimension gets the card for that dimension. An Auftritt of 27 cm against a
minimum is, as a sentence, a number the reader has to redraw in their head, and
as a drawing it is legible at once. Write the sentence anyway — the card is in
addition to the answer, never instead of it.

- Steigung, Auftritt, Laufbreite, Schrittmaß → `stair_diagram`.
- Absturzhöhe, Geländerhöhe, Öffnungsweite, the gap underneath →
  `guardrail_check`. The Absturzhöhe decides the limit, so it has to be in the
  card.
- Clear width, Rampe, Wendekreis, Bewegungsfläche, Stellplatz →
  `dimension_diagram`, with `shape` matching the subject.
- Aufzugspflicht and Kabinenmaße → `elevator_requirement`.

## Measured, computed, or merely asserted

When a number comes from `ifc_measure`, carry its provenance and its tolerance
into the card. A computed dimension without its ± band reads like an exact one,
and that is precisely what decides whether 2,47 m holds a 2,50 m limit. A number
taken from the user's question is neither measured nor computed — leave both
fields empty there.

When a dimension is missing, set that check to `needs_input` and write into it
what the plan is missing. Never estimate. An estimated dimension inside a card
is the worst output this product can produce, because a card is exactly the
representation that gets forwarded without its surrounding text.

## Accessibility is not only a dimension

The dimensions are what can be checked; the requirement is usually that
something be reachable and usable. Where the Richtlinie states a goal rather
than a dimension, say so instead of quoting a dimension that is only one
customary way of reaching the goal.
