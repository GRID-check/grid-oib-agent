---
name: waermeschutz
description: >
  Energy, thermal protection and sound insulation. Load when the question
  involves U-Wert or Wärmedurchgangskoeffizient, thermische Hülle, Wärmebrücke,
  Heizwärmebedarf or HWB, Energieausweis, Energieeffizienzklasse, fGEE,
  Kompaktheit, Referenzklima, sommerliche Überwärmung, Schallschutz, DnTw,
  LnTw, Trittschall, Luftschall, or any requirement of OIB Richtlinien 5 and 6.
metadata:
  grid-agents: shallow_researcher,deep_researcher
  grid-cards: thermal_envelope,energy_performance,acoustic_check,requirement_checklist,legal_basis
---

# Answering an energy or acoustics question

## The limit alone rarely answers the question

A U-value limit is bound to a building element and to what that element borders
on — outside air, ground, or an unheated room. Name the element and its position
alongside the number, or the number will be applied to the wrong element. Sound
insulation works the same way: DnTw and LnTw apply to an element *between* two
particular Nutzungseinheiten, and the pairing decides the value.

Heizwärmebedarf adds one more thing: the value comes out of a calculation this
product does not perform. You can say which requirement applies and how a given
value sits against it; you cannot determine an HWB. Say so when the question
sounds like it is asking for one.

## Which card for what

- U-values per element of the envelope → `thermal_envelope`, one row per
  element.
- HWB and energy class → `energy_performance`.
- Sound insulation per element pairing → `acoustic_check`, the pairing in the
  label.
- Several requirements side by side → `requirement_checklist`.

## Bestand is the normal case, not the exception

A large share of these questions concern Sanierung, and the requirements for
Bestand, Zubau and größere Renovierung differ from Neubau. When
`bestand_neubau` is set in the project context, answer for that case. When it is
not set and it makes a difference, that is the one question to ask — and to ask
before quoting a Neubau requirement that then turns out to be the wrong one.
