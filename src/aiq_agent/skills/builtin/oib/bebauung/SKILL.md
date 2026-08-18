---
name: bebauung
description: >
  Site planning and urban-development rules. Load when the question involves
  Abstand, Bauwich, Abstandsfläche, Grundgrenze, Fluchtlinie, Baulinie,
  Baufluchtlinie, Bebauungsplan, Flächenwidmung or Widmung, Bebauungsgrad,
  Bebauungsdichte, Geschoßflächenzahl or GFZ, Grundflächenzahl,
  Bruttogeschoßfläche, Gebäudehöhe, Traufenhöhe, Stellplatzverpflichtung, or
  Stellplatzregulativ.
metadata:
  grid-agents: shallow_researcher,deep_researcher
  grid-cards: setback_plan,density_check,building_section,parking_requirement,legal_basis
---

# Answering a site-planning question

## This is not in the OIB Richtlinien

That is the defining property of this genre and the most common wrong turn.
Setbacks, heights, density, Widmung and parking are **Landes- und
Gemeinderecht**: the Bauordnung of the Land, the Bebauungsplan, the
Flächenwidmungsplan, the Stellplatzregulativ. The OIB Richtlinien do not govern
them.

Two consequences follow. First, the answer depends on the Bundesland, always. If
the project context sets it, answer for that Land and say which one. If it does
not, that is the question to ask — there is no Austria-wide answer here. Second,
what the Bebauungsplan says for this particular Grundstück is not something you
know. You can say which rule applies and what it customarily fixes; you cannot
say what has been fixed for this plot. Say where to look it up rather than
producing a plausible number.

## Which card for what

- Plot, building footprint and setbacks per side → `setback_plan`.
- Bebauungsgrad, GFZ, areas against their limits → `density_check`.
- A height check across the storeys, Fluchtniveau → `building_section`.
- Required against available parking → `parking_requirement`, with the
  Bemessungsgrundlage in the `basis` field: without it the number cannot be
  checked.

## The chain of norms belongs in the answer

Where a question touches both Landesrecht and an OIB Richtlinie, say which level
governs which part. The reader has to be able to tell what binds from what
interprets — in this genre that distinction *is* the information.
