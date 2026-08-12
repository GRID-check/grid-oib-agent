# What each OIB Richtlinie needs from the model, and what we can measure

*Written 2026-08-12, against shipped code.*

## Why this document exists

The spatial engine grew out of one failing turn: an architect asked whether a
window and the roof above it worked for the light-incidence angle, and the agent
answered „Überstand/Raum-% im IFC nicht messbar". Everything built since aimed
at that question, and it now answers it completely.

That was an accident of which screenshot arrived first. **OIB 3 §9 is one clause
in one of six Richtlinien**, and building outward from it produced an engine that
is deep on daylight and thin or empty everywhere else. The repo's own golden
benchmark makes the point better than any argument: of its four questions, two
are OIB 2 (Brandschutz) and OIB 4 (Treppenlauf-Nutzbreiten), one is legal basis,
one is document summarisation — and **none is about daylight**.

So this is the coverage map, organised by Richtlinie rather than by whatever
failed most recently. It is meant to be the thing consulted before the next
operator is chosen.

## The rule that applies to every row below

**This engine measures. The Bestimmung judges.** Not one operator returns a
threshold, a verdict, a Gebäudeklasse or the word „erfüllt". OIB 4 names the
maximum riser height; OIB 2 names the Fluchtweglänge; OIB 6 names the U-values.
Those live in the knowledge base and are bound as parameters at the point of use
— which is why `light_incidence` refuses to supply its own 45°, and why
`fluchtniveau` returns a height and never a building class.

A number without its clause is not half an answer; it is a different answer
wearing the first one's clothes.

---

## OIB 1 — Mechanische Festigkeit und Standsicherheit

Almost nothing here is ours. Structural verification is an engineering
calculation against loads, not a measurement of a model, and an agent that
offered one would be practising a profession it does not hold. What geometry can
contribute is descriptive: spans, member sizes, which elements are declared
`LoadBearing`.

| need | state |
|---|---|
| member dimensions, spans | `measure/orientedExtent` — the element's own axes, not the model's |
| which elements are load-bearing | `Pset_*Common.LoadBearing`, via `ifc_query` — declared, never inferred |
| the verification itself | **out of scope, deliberately** |

---

## OIB 2 — Brandschutz

The heaviest Richtlinie and, until this round, the thinnest coverage.

| need | state |
|---|---|
| escape route: which rooms connect, through which doors | `measure/egressPath`, `measure/reachableFrom` |
| escape route LENGTH | partial — a centroid polyline, explicitly an *Untergrenze* and barred from use as a Fluchtweglänge |
| escape route WIDTH | `measure/clearWidth` on the doors along the route |
| Fluchtniveau (decides the Gebäudeklasse) | **being built** |
| fire compartment area | **being built** |
| what separates two compartments, and its declared FireRating | **being built** |
| distance to site boundary (Brandübertragung) | **being built** — expected to be undecidable on most exports |
| fire resistance ratings | declared only (`FireRating`); the sample house declares none anywhere, which is itself the finding |
| smoke extraction, detection, sprinklers | **not geometric — out of scope** |

The escape-route length is the honest weak point. A real Fluchtweg is measured
along the walkable path, around furniture and corners and door swings; a
centroid polyline cuts corners and crosses walls, so it under-estimates — the
dangerous direction, since a too-short route makes a too-long route look fine.
It orders rooms by distance. It does not measure a path.

---

## OIB 3 — Hygiene, Gesundheit und Umweltschutz

The deep one, for historical reasons rather than good ones.

| need | state |
|---|---|
| lichte Raumhöhe | `measure/clearHeight` — to the lowest overhead obstruction, not the space solid (30 cm apart on the sample house) |
| room floor area | `measure/floorArea`, triangulated against any declared quantity |
| Lichteintrittsfläche and its share of the floor | `measure/lightEntryArea` — external openings only |
| free light incidence, 45° prism | `light_incidence` — angles bound from the clause |
| room depth relative to its daylight facade | `measure/roomDepth` |
| facade orientation | `measure/azimuth` — undecidable without a declared TrueNorth |
| sun position | `daylight.sun_position` — library only, undecidable without georeferencing |
| ventilation openings, cross-ventilation | **gap** — openable area is a property most exports never write |
| moisture, ground contact, radon | **not geometric — out of scope** |

---

## OIB 4 — Nutzungssicherheit und Barrierefreiheit

Named in the repo's own benchmark and, until this round, entirely absent.

| need | state |
|---|---|
| door clear width (lichte Durchgangsbreite) | `measure/clearWidth` — measured on the aperture, not between centroids |
| stair riser/tread, and whether they are equal | **being built** |
| Treppenlauf-Nutzbreite | **being built** |
| headroom over a flight (Durchgangshöhe) | **being built** — normal to the pitch, not vertical |
| ramp slope | **being built** |
| turning circle (Wendekreis) | **being built** |
| threshold height at a door | **being built** |
| balustrade height where there is a fall | **being built** |
| clear approach beside a door | **being built** |
| Brüstungshöhe (Absturzsicherung) | `measure/sillAndHead` |
| tactile guidance, contrast, signage | **not geometric — out of scope** |

---

## OIB 5 — Schallschutz

Mostly a property question, with one geometric half we already have.

| need | state |
|---|---|
| which rooms adjoin which | `relations/adjacentSpaces` |
| what separates two rooms | **being built** (`separating_elements`, shared with OIB 2) |
| what is directly above/below a room (impact sound) | `relations/above`, `relations/below` |
| declared acoustic ratings | declared only (`AcousticRating`); nowhere filled in the sample house |
| flanking transmission, R'w calculation | **not geometric — out of scope** |

---

## OIB 6 — Energieeinsparung und Wärmeschutz

| need | state |
|---|---|
| which elements form the heated envelope | **being built** |
| envelope area by orientation, opaque vs transparent | **being built** |
| window-to-wall ratio per facade | **being built** |
| compactness (A/V) | **being built** |
| declared U-values | declared only — never recomputed from layers, because a U-value derived from a material list is a different number than the one the architect signed |
| shading, thermal bridges, the energy balance | **not geometric — out of scope** |

---

## What this map is for

Two things.

**Choosing the next operator.** The rows marked *gap* and *out of scope* are the
honest edge of the system, and „out of scope" is a decision that should be
re-read rather than inherited. Ventilation openable area, for instance, is
marked a gap and not out of scope: it is measurable in principle and blocked
only by exports that rarely publish it.

**Answering the user honestly.** Every *out of scope* row is something the agent
must decline rather than approximate. A structural verification, an R'w
calculation and an energy certificate are all things a plausible-sounding
sentence could be produced for, and all three would be worse than a refusal.
