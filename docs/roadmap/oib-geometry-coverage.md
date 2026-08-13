# What each OIB Richtlinie needs from the model, and what we can measure

*Written 2026-08-12 against shipped code; operator rows re-verified 2026-08-13
against `ifc_spatial.tools.MEASURE_FN` / `.FIRE_ASPECTS` and
`aiq_agent.agents.bim.measure_register.VALID_OPERATIONS` / `.MEASURES`.*

A row here names an operator an agent can actually call. „Library only" means
the function exists and is tested and **no tool surface reaches it** — worth
saying rather than hiding, because a map that promises a call nobody can make
costs a turn and reads as a defect in the model.

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
| escape route WIDTH | `measure/clearWidth` on the doors along the route — the **Rohbaulichte**; the finished lichte Durchgangsbreite between the Zargenfalze is 15–25 % smaller, and the answer has to carry that or a too-narrow door reads as compliant |
| Fluchtniveau (decides the Gebäudeklasse) | `fire/fluchtniveau` — the HEIGHT of the topmost Aufenthaltsgeschoß over the lowest adjoining terrain, with the storeys it counted. Never a Gebäudeklasse: that word belongs to the Bestimmung |
| fire compartment area | `fire/compartmentArea` — summed across the rooms of one compartment, every room listed beside the total |
| what separates two compartments, and its declared FireRating | `fire/separatingElements` — the wall, the slab and the doors in them, each with its **declared** `FireRating` and explicitly with its absence |
| distance to site boundary (Brandübertragung) | `fire/siteBoundary` — and **undecidable on all five fixtures**, none of which carries a boundary. There is deliberately no site-bounding-box fallback: the modelled extent of an `IfcSite` is the terrain patch somebody drew, not the Grundstücksgrenze, and this number decides whether a facade may have openings at all |
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
| door clear width (Rohbaulichte, not the finished lichte Durchgangsbreite) | `measure/clearWidth` — measured on the aperture, not between centroids; see the OIB 2 row for the 15–25 % that separates the two |
| stair riser/tread, and whether they are equal | `measure/stairGeometry` — riser, tread, riser count **and the spread over the flight**; a stair can be right on average and unwalkable. Declared values are cross-checked and a contradiction reported |
| Treppenlauf-Nutzbreite | part of `measure/stairGeometry` — the flight's clear width, beside the declared one |
| which flights and landings a stair is made of | `measure/stepsOf` — so a single flight can be asked about, which is how Bestimmungen count risers |
| headroom over a flight (Durchgangshöhe) | `measure/headroom` — **normal to the pitch**, not vertical: a plumb ray from the tread misses the tight point (1.35 m against 1.65 m measured) |
| ramp slope | `measure/rampSlope` — percent *and* ratio, with run, rise and clear width, because a clause names one or the other |
| turning circle (Wendekreis) | `measure/turningCircle` — the largest circle on the free floor, counting fixed built-ins only; furniture is reported beside it, never inside it |
| threshold height at a door | `measure/thresholdHeight` — where the export models no floor build-up this is a Rohbaumaß and the answer says so: screed, covering and seal are what make the step |
| balustrade height where there is a fall | `measure/balustrade` — undecidable when the export contains no `IfcRailing` at all, because no railing in the model is not no railing on site |
| clear approach beside a door | `measure/clearApproach` — the free floor on each side, and what ends it |
| Brüstungshöhe (Absturzsicherung) | `measure/sillAndHead` |
| tactile guidance, contrast, signage | **not geometric — out of scope** |

---

## OIB 5 — Schallschutz

Mostly a property question, with one geometric half we already have.

| need | state |
|---|---|
| which rooms adjoin which | `relations/adjacentSpaces` |
| what separates two rooms | `fire/separatingElements` — shared with OIB 2. It names the elements and reads `FireRating`; the rating a Schallschutz question wants is the row below, and no operator reads it |
| what is directly above/below a room (impact sound) | `relations/above`, `relations/below` |
| declared acoustic ratings | declared only (`AcousticRating`); nowhere filled in the sample house |
| flanking transmission, R'w calculation | **not geometric — out of scope** |

---

## OIB 6 — Energieeinsparung und Wärmeschutz

| need | state |
|---|---|
| which elements form the heated envelope | `envelope/thermalEnvelope` — grouped by kind, each element with its area, its declared U-value and WHICH rung decided it; plus the `innenliegend` and `unbestimmt` lists that make the total checkable. 225.700 m² on the sample house |
| envelope area by orientation, opaque vs transparent | `envelope/areaByOrientation` |
| window-to-wall ratio per facade | part of `envelope/areaByOrientation` — N 19.3 %, O 0 %, S 40.5 %, W 100 %. The west is a curtain wall whose panes are the whole elevation, and the caveat says so, because a WWR of 1.0 read without that sentence is a modelling error rather than a building |
| compactness (A/V) | `envelope/compactness` — 0.846 1/m, with A and V reported separately because a ratio whose inputs are invisible cannot be checked by whoever signs it. V is the NET volume (266.728 m³, summed room solids); a gross one is larger by the whole build-up |
| declared U-values | declared only — never recomputed from layers, because a U-value derived from a material list is a different number than the one the architect signed |
| shading, thermal bridges, the energy balance | **not geometric — out of scope** |

All three operators live in `packages/ifc-spatial-py/src/ifc_spatial/envelope_geometry.py`
and are covered by `tests/test_envelope_geometry.py`. They were **library only**
for the whole of their first existence — implemented, tested, and on no tool
surface — so an agent asked a U-Wert or Kompaktheit question reached nothing and
answered that the export could not say. That is the worst shape a gap can take:
a sentence about the architect's file that was really about our wiring, sending
them to fix something that was not broken.

They are now the `envelope` tool, grouped the way `fire` is, and the row above
is what an agent can call. Two things did NOT change with the wiring, because
they are the point:

- **no U-value is calculated.** A declared one is repeated, a missing one stays
  missing, and neither is derived from the layer set — a U-value computed from a
  material list is a different number from the one the architect signed and is
  indistinguishable from it on the page.
- **no threshold and no „erfüllt".** Which U-value or which A/V is admissible
  lives in OIB 6 and in the Energieausweis procedure. This engine supplies the
  geometry underneath it.

What remains genuinely uncovered for OIB 6 is the row below it: shading, thermal
bridges and the energy balance, all still out of scope on purpose.

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
