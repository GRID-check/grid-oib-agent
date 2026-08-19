---
name: brandschutz
description: >
  Fire safety. Load when the question involves Brandabschnitt, Feuerwiderstand
  (REI/EI), Fluchtweg or Fluchtweglänge, zweiter Fluchtweg, Rettungsweg,
  Stiegenhaus, Brandwand, Brandschutzklappe, Rauchabschnitt, Feuerwehrzufahrt
  or Aufstellfläche, Löschwasser, or any GK-dependent requirement of OIB
  Richtlinie 2 — including when the question arrives from a model or an
  Einreichplan rather than in words.
metadata:
  grid-agents: shallow_researcher,deep_researcher
  grid-cards: fire_compartment,egress_diagram,fire_access_plan,requirement_checklist,legal_basis
---

# Answering a fire-safety question

## Establish the Gebäudeklasse before anything else

Nearly every requirement in OIB Richtlinie 2 hangs off the Gebäudeklasse, and
the Gebäudeklasse hangs off Fluchtniveau, storey count, footprint and use. If
the project context confirms a GK, take it — do not re-derive it. If it is
unknown and it changes the answer, ask **one** question about it before
answering. A fire-resistance class stated without the GK it follows from is a
number with no claim attached to it.

The edition binds the same way: the Bundesländer declare different editions of
the Richtlinie verbindlich. Name the edition you are relying on as soon as it
moves the value.

## Which card for what

- A storey divided into Brandabschnitte, areas against the limit →
  `fire_compartment`.
- An escape route made of segments whose total is checked → `egress_diagram`.
  Enter the segments individually, never the sum: the question is almost always
  *which* segment is too long.
- Zufahrt, Durchfahrt, Aufstellfläche → `fire_access_plan`.
- Several requirements each with its own verdict (the typical "was gilt für
  GK 4") → `requirement_checklist`, one row per requirement with its own
  Fundstelle.
- The provision the answer rests on → `legal_basis`.

## What goes wrong in this genre

**The second escape route gets treated as a number.** Whether one is required
follows from GK and use; whether it counts follows from where it leads. Answer
both, or say which of the two is open.

**The requirement gets confused with the proof.** The Richtlinie says what must
be satisfied. Whether it *is* satisfied in this building is a finding on the
object or the model. Say which of the two you delivered.

**An orientational check gets read as a Nachweis.** When the answer comes from a
rule check against the model, it has to say so — a Prüfbuch is not a
Brandschutzkonzept, and that distinction disappears the moment the card is
forwarded without the surrounding sentence.
