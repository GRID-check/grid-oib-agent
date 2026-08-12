# The corpus run: eleven exports, one library, eleven defects

`COVERAGE.md` measures this package against **one** file — `Ifc4_SampleHouse.ifc`,
a 2 MB Revit/Xbim sample with four rooms, no space boundaries and every quantity
already in metres. §13 of `docs/roadmap/agent-spatial-reasoning.md` says what is
wrong with that:

> Exporter dialect variance is the dominant real-world failure and a benchmark on
> one sample house hides it completely.

This document is the run that stops hiding it. Eleven third-party exports —
ArchiCAD 18 and 20, Revit 2011 / 15.3 / 24, Allplan 2017, SketchUp 2024, SDS/2,
IFC2X3 and IFC4, metres and millimetres and **feet** and **inches**, 0.2 MB to
151 MB, one model 907 km from the origin and one with no `IfcSpace` at all —
plus seven files deliberately broken. Every operator was run on every file, every
declared `Qto_*` floor area was compared against the geometry, and every phase was
timed and its peak RSS recorded.

**The result in one line.** Eleven defects, all fixed, each with a regression in
`tests/test_corpus.py`; three of them produced *confident wrong answers* rather
than errors, four sent the reader to fix the wrong thing, and one crashed the
process with no exception to catch.

```
cd packages/ifc-spatial-py && PYTHONPATH=src python3 -m pytest tests -q
# 135 passed
```

**The corpus is not in this repository and must never be.** These are other
people's models — 250 MB of them, under their own licences. They were fetched
into `/tmp/ifc-corpus/`, and every defect they exposed is reproduced in
`tests/test_corpus.py` from the in-repo sample house or from a synthetic IFC the
test writes itself.

---

## 1. The corpus

Exporter and schema are read from each file's own `FILE_NAME` header, not from
its name. `md5` is of the exact bytes measured.

| # | file (as run) | source | bytes | md5 | schema | exporter (own header) |
|---|---|---|---|---|---|---|
| 01 | `01-sample-house.ifc` | in-repo fixture `packages/ifc-spatial/test/fixtures/Ifc4_SampleHouse.ifc`; byte-identical to `Ifc4_SampleHouse.ifc` in [youshengCode/IfcSampleFiles](https://github.com/youshengCode/IfcSampleFiles) | 2 273 870 | `372136c4…` | IFC4 | Xbim 4.0.0.0 |
| 02 | `02-fzk-haus.ifc` | [ibpsa/project1-wp-2-2-bim](https://github.com/ibpsa/project1-wp-2-2-bim) `IFC_Files/MISC/AC20-FZK-Haus.ifc` (KIT/FZK reference house) | 2 526 544 | `f9b15b16…` | IFC4 | GRAPHISOFT ARCHICAD-64 20.0.0 GER |
| 03 | `03-institute.ifc` | same repo, `Use Cases/KIT institute - Ifc4/AC20-Institute-Var-2.ifczip` | 10 934 237 | `ee5824b0…` | IFC4 | GRAPHISOFT ARCHICAD-64 20.0.0 GER |
| 04 | `04-duplex.ifc` | [youshengCode/IfcSampleFiles](https://github.com/youshengCode/IfcSampleFiles) `Ifc2x3_Duplex_Architecture.ifc` (the GSA Duplex Apartment) | 2 380 763 | `e9e6df73…` | IFC2X3 | Autodesk Revit Architecture 2011 → Solibri IFC Optimizer |
| 05 | `05-office-a.ifc` | `Office_A_20110811.ifc`, staged in the working directory before this session; same NIBS/GSA *Common BIM Files* series as 04 | 4 099 307 | `3d4e3037…` | IFC2X3 | Autodesk Revit Architecture 2011 → Solibri IFC Optimizer |
| 06 | `06-trapelo-feet.ifc` | `Trapelo_Design_Intent.ifc`, staged before this session | 22 402 887 | `7253faa2…` | IFC2X3 | Revit IFC Exporter 15.3.0.0 → EXPRESS Data Manager 5.02 |
| 07 | `07-archicad18-nl.ifc` | [youshengCode/IfcSampleFiles](https://github.com/youshengCode/IfcSampleFiles) `Ifc2x3_SampleCastle.ifc` — the name is the repository's; the header says `20141208_14047_werktekening.ifc` | 49 286 967 | `e7b3c2bb…` | IFC2X3 | Graphisoft ArchiCAD-64 18.0.0 NED |
| 08 | `08-snowdon.ifc` | `Snowdon_IFC2x3.ifc` (Autodesk *Snowdon Towers* sample project), staged before this session | 151 084 639 | `b4fe833f…` | IFC2X3 | Autodesk Revit 24.0.20.20 → ODA SDAI |
| 09 | `09-aisc-inch.ifc` | `AISC_Sculpture_param.ifc`, staged before this session; the author path in its header reads `…/NIST_IFC_Sample/` | 320 921 | `6d789332…` | IFC2X3 | SDS/2 Version 7.000 |
| 10 | `10-allplan.ifc` | [IfcOpenShell/files](https://github.com/IfcOpenShell/files) `Allplan 2017 Test Bauteil-Oberflächen.ifc` | 5 823 431 | `7ce4d4ee…` | IFC2X3 | Allplan 2017.1 / EDMsix 2.0100.03 |
| 11 | `11-sketchup-pcert.ifc` | [buildingSMART/Sample-Test-Files](https://github.com/buildingSMART/Sample-Test-Files) `IFC 4.0.2.1 (IFC 4)/PCERT-Sample-Scene/Building-Architecture.ifc` | 225 635 | `688e6630…` | IFC4 | SketchUp 2024 (24.0.594) |

Files 05, 06, 08 and 09 were already present in `/tmp/ifc-corpus/` when this
session began; their bytes are fingerprinted above and their exporters read from
their own headers, but unlike the other seven their download URL was not
re-verified in this session. That is stated rather than papered over.

### What each axis of variance is covered by

| the §13 requirement | file | evidence |
|---|---|---|
| IFC2X3 **and** IFC4 | 04–10 are IFC2X3, 01–03 and 11 are IFC4 | both schemas exercised on every operator |
| different exporters | ArchiCAD 18/20 (02, 03, 07), Revit 2011/15.3/24 (01, 04, 05, 06, 08), Allplan 2017 (10), SketchUp 2024 (11), SDS/2 (09) | 6 vendors. **Vectorworks and Tekla are not in the corpus** — no public export of either was found; SDS/2 (steel detailing, inches) and Allplan stand in for that end of the market |
| no `IfcSpace` | **08-snowdon** (0 spaces, 151 MB), 09-aisc (0) | every space operator refuses, none crashes |
| declared `IfcRelSpaceBoundary` | 02 (81), 03 (1 000), 04 (265), 05 (1 334), 06 (2 451), 07 (1 675) | the declared route is taken; 01, 10, 11 have none and take the derived one |
| over 20 MB | 06 (22.4 MB), 07 (49.3 MB), 08 (151.1 MB) | see §4 — this is where the memory limit came from |
| feet / inches | **06-trapelo** (`FOOT` / `SQUARE FOOT`), **09-aisc** (`INCH`) | see defect 2 |
| far from the origin | **06-trapelo** (907 km), **08-snowdon** (418 km) | see §5 |
| `TrueNorth` present | 02 (**50.0°**), 06 (**68.0°**), and 01, 03, 07, 08 at 0.0° | `azimuth()` answers on six files; **04, 05, 09, 10, 11 declare no `TrueNorth` at all and it refuses** rather than assume +Y is north |

### The seven files built to break it

| file | what it is |
|---|---|
| `empty.ifc` | 0 bytes |
| `header-only.ifc` | valid `HEADER`, `FILE_SCHEMA(('IFC4'))`, empty `DATA` section |
| `truncated.ifc` | `04-duplex.ifc` cut to 300 000 bytes, mid-entity |
| `notifc.ifc` | PNG magic bytes with an `.ifc` extension |
| `badschema.ifc` | `FILE_SCHEMA(('IFCNOPE'))` |
| `untessellatable.ifc` | hand-written IFC4: an `IfcWall` whose body is a degenerate three-identical-points profile extruded to depth 0 |
| `wrong-geometry.ifc` | [IfcOpenShell/files](https://github.com/IfcOpenShell/files) `1948--wall--wrong-geometry.ifc` — a real bug report, 540 KB, several bodies the kernel cannot build |

---

## 2. What was run, and what came back

Every file: open → `geometry_pass()` → `tree` → `bounds` → `space_contacts()` →
then the whole operator surface over a sample of walls, windows, doors, openings,
spaces and storeys (83 calls where the file has all of them), plus the
ground-truth comparison against every declared floor-area quantity.

| file | schema | MB | entities | products | with geometry | spaces | declared `IfcRelSpaceBoundary` | fenestration resolved to a host |
|---|---|---|---|---|---|---|---|---|
| 01-sample-house | IFC4 | 2.27 | 47 309 | 75 | 69 | 4 | 0 | 7/7 |
| 02-fzk-haus | IFC4 | 2.53 | 44 249 | 127 | 107 | 7 | 81 | 16/16 |
| 03-institute | IFC4 | 10.93 | 147 712 | 1 190 | 1 071 | 82 | 1 000 | 283/283 |
| 04-duplex | IFC2X3 | 2.38 | 38 898 | 295 | 286 | 21 | 265 | 38/38 |
| 05-office-a | IFC2X3 | 4.10 | 62 930 | 1 090 | 1 083 | 99 | 1 334 | 171/171 |
| 06-trapelo-feet | IFC2X3 | 22.40 | 383 048 | 3 729 | 3 639 | 139 | 2 451 | **141/190** |
| 07-archicad18-nl | IFC2X3 | 49.29 | 714 485 | 3 822 | 3 589 | 100 | 1 675 | **74/464** |
| 08-snowdon | IFC2X3 | 151.08 | 2 700 908 | 7 076 | 6 436 | **0** | 0 | 194/200 |
| 09-aisc-inch | IFC2X3 | 0.32 | 4 843 | 468 | 351 | 0 | 0 | 0/0 |
| 10-allplan | IFC2X3 | 5.82 | 90 973 | 72 | 70 | 7 | 0 | 6/6 |
| 11-sketchup-pcert | IFC4 | 0.23 | 444 | 22 | 14 | 2 | 0 | 0/0 |

**Elements without geometry are normal and are reported as such**, never as an
error: 8 % of the sample house's products, 10 % of the institute's, 25 % of the
AISC sculpture's (fasteners and connection annotations). `extent()` on one of
them returns `decidable=False` with the German explanation that some entries have
no body by design.

**Two exports lose the window→wall chain, and one loses most of it.** Six files
resolve **521 of 521** windows and doors to a host through
`FillsVoids → RelatingOpeningElement → VoidsElements`. The other two do not:
Trapelo resolves 141 of 190 (74 %), and the ArchiCAD 18 export resolves **74 of
464 — 16 %**, because it carries 79 `IfcRelVoidsElement` for 464 openings: the
wall bodies were exported with their holes already subtracted and no
`IfcOpeningElement` written. Everything that hangs off the opening — the
Rohbauöffnung's real area, `sillAndHead` on the opening rather than the frame,
`hosts()` on the wall — is simply not in that file. `hosted_in` returned `[]`,
which is true and reads as *"this window is in no wall"*; that is defect 9.

**Not one operator call raised an exception on any of the eleven files** — after
the fixes in §6. **769 operator calls, 0 raised, 70 undecidable**, every
undecidable naming the entity or relation that would settle it.

---

## 3. The ground truth: declared quantities against measured geometry

For every `IfcSpace` in every file that declares a floor area, the declared value
(converted to m²) against `floor_area()`. This is the only place in the run where
something outside the library says what the right answer is.

| file | rooms compared | quantity path | declared unit | agree (±2 %) | disagree | median computed/declared | spread |
|---|---|---|---|---|---|---|---|
| 01-sample-house | 4 | `BaseQuantities.NetFloorArea` | m² | 4 | 0 | **1.00000** | 1.0000–1.0000 |
| 02-fzk-haus | 7 | `BaseQuantities.NetFloorArea` | m² | 1 | 6 | 1.03093 | 1.0000–1.4382 |
| 03-institute | 60 | `BaseQuantities.NetFloorArea` | m² | 0 | 60 | 1.03093 | 1.0309–1.0309 |
| 04-duplex | 21 | `PSet_Revit_Dimensions.Area` | m² | 0 | 21 | 0.86926 | 0.7728–0.9321 |
| 05-office-a | 60 | `PSet_Revit_Dimensions.Area` | m² | 1 | 59 | 0.93831 | 0.8885–0.9835 |
| 06-trapelo-feet | 60 | `BaseQuantities.NetFloorArea` | **SQUARE FOOT** | 59 | 1 | **1.00000** | 0.9653–1.0000 |
| 07-archicad18-nl | 60 declared, **3 measurable** | `BaseQuantities.NetFloorArea` | m² | 3 | 0 | **1.00000** | 1.0000–1.0000 |
| 10-allplan | 7 | `SpaceQuantities.NetFloorArea` | m² | 7 | 0 | **1.00000** | 1.0000–1.0001 |

Four findings, and **which side is wrong differs**:

**a. The sample house, the Allplan house and Trapelo agree exactly.** Sample
house to 4·10⁻¹⁴ relative, Allplan to 1·10⁻⁴, and Trapelo — in square feet, on a
building 907 km from the origin — **59 of 60 rooms at a median ratio of exactly
1.00000**, after the unit conversion of defect 2. Three unrelated exporters and
three unit systems agreeing with the geometry to that precision is the evidence
that `floor_area` measures the right thing; the disagreement rows below are
therefore about the exports, not about the operator.

**b. ArchiCAD 20 declares exactly 0.97 × the geometric area.** Six of seven FZK
rooms and **all sixty** institute rooms have ratio 1.030928 — which is 1/0.97 to
six figures, over rooms from 11 m² to 128 m² and of every shape. A constant
factor over sixty differently-shaped rooms is not a geometric disagreement; it is
a **declared reduction**, an ArchiCAD zone-category setting. *Our* number is the
geometric one, the file's is the reduced one, and neither is wrong — the
`triangulate` caveat is right to call it "ein Befund über den Export".

Two rooms break the pattern and are worth naming: FZK *Küche* has ratio exactly
1.0 (no reduction on that zone category) and FZK *Galerie* has ratio **1.4382**
— 107.16 m² measured against 74.51 m² declared, because the gallery's space solid
spans the void over the living room while the declared area counts only the
walkable floor. That is the single largest disagreement in the corpus and it is a
real property of the model.

**c. Revit's room area is 6–23 % larger than the `IfcSpace` solid.** Both Revit
files (04, 05) disagree on nearly every room, but with a *spread*, not a constant:
0.77–0.93 on the duplex, 0.89–0.98 on the office. That is the signature of a
different boundary convention — Revit measures the room polygon at the wall
finish face while the exported space solid is inset — and the deviation therefore
scales with the room's perimeter-to-area ratio. Small rooms (duplex *Utility*,
1.42 m² against 1.75 m²) are worst hit, large ones (office *OPEN OFFICE*, 610 m²
against 620 m², ratio 0.9835) are almost in tolerance. Again the geometry is what
the building gets built from, and the export is what needs the note.

**d. Both Revit files publish their room area in a property set, not a quantity
set.** The duplex has no `Qto_SpaceBaseQuantities` at all: its only quantity set
is `GSA Space Areas.GSA BIM Area`, and the name a search would look for
(`NetFloorArea`) appears nowhere. Only the deliberately dialect-agnostic search
finds anything at all here — but it also has to prefer the real quantity set when
both exist, which is defect 7.

**e. The ArchiCAD 18 export declares 100 room areas and only 6 of its rooms have
buildable geometry.** All hundred `IfcSpace` entities carry a full `Body`
representation; OCCT rejects **94 of them** with `Failed to process shape`. Where
the body does build, the measurement and the declaration agree to 1·10⁻⁶ — three
of three sampled at ratio 1.00000, which is the point: the operator is fine and
the file is not. This is defect 10, and it is also the "model whose geometry
fails to tessellate" the brief asked for, found in the wild rather than
synthesised.

---

## 4. Timings and memory — would this survive in a request?

Four CPUs, 16 GB. Wall-clock per phase, and peak RSS of the whole process (which
starts at ~130 MB for the Python + IfcOpenShell + numpy + shapely import alone).

| file | MB | products | open | geometry pass | tree | contacts, all spaces | peak RSS | RSS / MB |
|---|---|---|---|---|---|---|---|---|
| 11-sketchup-pcert | 0.23 | 22 | 0.02 s | 0.3 s | 0.1 s | 0.7 s | 161 MB | — |
| 09-aisc-inch | 0.32 | 468 | 0.03 s | 0.8 s | 0.4 s | 0.0 s | 163 MB | — |
| 01-sample-house | 2.27 | 75 | 0.27 s | 1.9 s | 1.1 s | 5.4 s | 287 MB | 126× |
| 04-duplex | 2.38 | 295 | 0.25 s | 2.1 s | 1.3 s | 24.9 s | 235 MB | 99× |
| 02-fzk-haus | 2.53 | 127 | 0.30 s | 4.0 s | 2.9 s | 8.4 s | 273 MB | 108× |
| 05-office-a | 4.10 | 1 090 | 0.42 s | 2.8 s | 1.7 s | 38.1 s (capped) | 316 MB | 77× |
| 10-allplan | 5.82 | 72 | 0.50 s | 3.7 s | 2.6 s | 7.4 s | 285 MB | 49× |
| 03-institute | 10.93 | 1 190 | 1.32 s | 8.2 s | 6.2 s | 30.2 s (capped) | 377 MB | 34× |
| **06-trapelo-feet** | 22.40 | 3 729 | 2.6 s | **208 s** | **95 s** | refused | **3 197 MB** | **143×** |
| **07-archicad18-nl** | 49.29 | 3 822 | 5.9 s | 16.9 s | 8.8 s | refused | 941 MB | 19× |
| **08-snowdon** | 151.08 | 7 076 | 16.6 s | **245 s** | **101 s** | no spaces | **5 288 MB** | 35× |

Four conclusions with numbers behind them:

1. **Opening is cheap; tessellating is not.** `ifcopenshell.open` is 0.3 s on a
   2 MB file, 2.6 s on a 22 MB one and 5.9 s on a 49 MB one — sub-linear and safe
   anywhere. The geometry pass costs 6–80× that, and the tree another half again.
2. **File size does not predict cost — geometry complexity does.** Trapelo
   (22 MB, 3 729 products) and the ArchiCAD export (49 MB, 3 822 products) have
   almost the same number of products, and Trapelo costs **12× the tessellation
   time and 3.4× the memory** on less than half the bytes. Revit's swept solids
   with boolean subtractions are expensive to build; ArchiCAD's are not. Any
   admission test based on file size is therefore a coarse backstop and is
   documented as one in `model.MAX_FILE_BYTES`.
3. **Peak memory ranges from 19× to 143× the file size.** §11 of the design doc
   predicted "peak memory several times the file size"; it is an underestimate by
   one to two orders of magnitude.
4. **Nothing here belongs in a request process above a few megabytes.** The
   design doc's Phase-2 precondition, *extraction must leave the request process
   and become a worker*, is confirmed by measurement rather than by argument. This
   package now says so out loud in three places rather than silently trying:
   `ModelTooLargeError` above `MAX_FILE_BYTES`, an incomplete contact map above
   `CONTACT_BUDGET_SECONDS`, and a flat refusal to derive space boundaries above
   `DERIVED_BOUNDARY_MAX_PRODUCTS`.

---

## 5. Far from the origin

The TypeScript sibling had a coordinate bug that survived a whole test suite
because the sample house sits at the origin: it read an offset as zero on a model
carrying a 907 km one. Two files in this corpus carry exactly that shape, and
`06-trapelo-feet` carries it in feet as well.

**Trapelo sits on the Massachusetts State Plane grid.** Its measured bounds:

```
x  219 875.50 →  219 939.66 m     (219.9 km east of the projection origin)
y  907 105.76 →  907 207.32 m     (907.2 km north)
z       55.52 →       71.42 m     (survey elevation, not project zero)
```

Everything downstream of that is right:

| what | value | check |
|---|---|---|
| `model.diagonal` | 121.173 m | the building's own extent (64 × 102 × 16 m), **not** the distance to the origin |
| `IfcBuildingStorey.Elevation` | 55.677 / 59.131 / 62.890 / 66.650 / 70.676 m | in metres after ×0.3048, and *inside* the geometry's z range — so `_storey_datum_drift` is 0 and the datum is usable |
| `sill_and_head` on a window | sill 0.778 m, head 2.575 m, height 1.797 m | a real Brüstungshöhe above **its own storey**, measured off absolute z ≈ 907 km away |
| `sill_and_head` on a door | sill 0.000 m, head 2.184 m | 2.1844 m is 7′2″ — the file's own nominal door height, to the micrometre |
| `extent` on that door | 1.0193 × 0.5719 × 2.1844 m | sub-millimetre dimensions differenced out of eight-figure coordinates |
| `azimuth` | 314° NW / 224° SW / 44° NO | with `TrueNorth` at 1.1868 rad = 68.0° |
| `floor_area` against declared | **59 of 60 agree**, median ratio 1.00000, range 0.96533–1.00001 | in square feet, converted — defect 2 |

**Why it holds, stated rather than assumed.** IEEE-754 double has an ulp of
**0.116 nm** at 9.1·10⁵ m, so a coordinate carries about seven decimal digits of
sub-millimetre headroom at this magnitude. Every measurement in this package is
either a difference of two coordinates (`extent`, `sill_and_head`, `overhang`,
`clip_polygon`) or a projection of a difference (`signed_distance`,
`facade_plane_of`), and a difference of two nearby large numbers loses the
magnitude, not the precision. There is no truncation to float32 anywhere: the
TS sibling's bug does not have an analogue here because `use-world-coords`
returns absolute coordinates and nothing re-applies an offset that could be read
as zero.

The one thing a *consumer* must not do is round. `extent()` on a Trapelo door
reports `box.min = [219896.2893191515, 907167.8389869643, 59.1312]`; a caller
that prints that to two decimals has thrown away the tenth of a millimetre the
answer's stated tolerance depends on. That is a rendering rule, not a defect, and
it is worth writing down because it only becomes visible on a file like this one.

### Snowdon: the same offset, and the storey datum on a different one

`08-snowdon` sits even further out, and adds the failure Trapelo does not have:

```
x  417 585.8 →  417 645.7 m        (417.6 km)
y   78 685.8 →   78 734.9 m        ( 78.7 km)
z      230.9 →      260.6 m        (metres above sea level)

IfcBuildingStorey.Elevation:  −5.156 / −1.803 / −1.054 / 0.000 m
```

The geometry is on the **survey datum** and the storeys are on the **project
datum**, 231 m apart. This is exactly the export the TypeScript sibling reported
sills 58 m below their own floor on — with a unit, a 10 mm tolerance and a
`computed` provenance, which is what made it dangerous.

Here `_storey_datum_drift` measures 231 m of separation and `sill_and_head`
**refuses**:

> *IfcBuildingStorey.Elevation und die Modellgeometrie liegen auf verschiedenen
> Höhenbezügen … sie verfehlen einander um 231.06 m. Eine Höhe über Geschossebene
> wäre um diesen Betrag falsch und wird deshalb nicht ausgegeben.*

`elevation()` still answers, with absolute z, because that number is real. The
guard was written before this corpus existed, on the strength of one file in the
TypeScript package; this run is the independent confirmation that it fires on a
different exporter, a different schema and a different datum offset.

The rest of the file behaves as it should for a model with **no `IfcSpace` at
all**: `opens_to` refuses naming `IfcSpace` ("dieser Export enthält keine
Räume"), `enclosed_by` refuses naming `IfcRelSpaceBoundary`, 194 of 200 windows
and doors still resolve to their host wall, and 65 operator calls raise nothing.

---

## 6. Defects found, ranked

Ranked by what the failure would have done in front of an architect, not by how
hard it was to fix. The first two produced **numbers**, which is the worst
outcome available to this library: an undecidable answer gets read as a gap in
the export, an exception gets read as our bug, but a wrong number gets read as
the building.

### 1. A room with an inside-out mesh measured 0 m² of floor — and said so confidently

*Found on:* `04-duplex` (Revit IFC2X3), all 21 rooms affected in kind, 3 of them
reporting exactly `0.0`.

`util.shape.get_footprint_area` keeps only triangles whose normal points **at**
the given direction. The duplex's *Hallway* is a closed solid with 28
downward-facing faces and none facing up, so the projection was empty and the
operator returned `0.0` — `decidable=True`, `provenance="computed"`, tolerance
`0.0`, and a caveat stating *"dieses Bauteil hat Geometrie, aber keine
horizontalen Flächen (eine Wand, ein Pfosten)"*, which was false. It then
triangulated that zero against the declared 7.80 m² and published a 100 %
disagreement blaming the export.

*Fix:* `operators._footprint_area` projects **both** ways and takes the larger
silhouette. Asking IfcOpenShell for the other direction is not an option —
`get_footprint_area(t, direction=(0,0,-1))` builds a degenerate basis and raises
`GEOSException: Points of LinearRing do not form a closed linestring`
(`util/shape.py:611`, 0.8.5) — so the down-facing union is done here, by the same
method: filter by normal at the same `0.01` tolerance, project, `unary_union`.
*Hallway* now measures 6.889 m². For a correctly wound solid the two silhouettes
are equal, so nothing moved: the sample house's rooms still measure
15.41678125 / 51.994825 / 8.69350625 m², to 1·10⁻⁹.

*Regression:* `test_a_footprint_is_measured_whichever_way_the_mesh_is_wound`,
`test_the_union_still_refuses_to_double_count`,
`test_zero_is_still_the_answer_for_something_with_no_horizontal_face`,
`test_the_sample_house_room_areas_do_not_move`.

### 2. A declared quantity in square feet was compared against metres

*Found on:* `06-trapelo-feet` (Revit IFC2X3, `FOOT` / `SQUARE FOOT`), all 139
rooms; latent on `09-aisc-inch`.

Trapelo declares `BaseQuantities.NetFloorArea = 68.1017516344055` for its
ground-floor locker room. The geometry measures 6.3269 m². Those are the same
room — 68.10 ft² **is** 6.327 m². `declared_quantity` returned the raw number and
`floor_area` reported a 91 % disagreement, in the operator whose entire purpose
is to report export defects. Every quantity in every imperial export was wrong by
10.76×, and the answer looked ordinary.

The trap that makes this worth writing down: **the area unit is independent of
the length unit.** The sample house measures in millimetres and declares its areas
in square metres, so the obvious `unit_scale ** 2` would have divided its rooms by
a million. `ifcopenshell.util.unit.get_property_unit` is the right tool and was
verified rather than assumed: it returns the quantity's own `Unit` when it
overrides the project and the project unit for that measure otherwise.
`convert_unit` cannot serve — it matches on unit *names* and `'SQUARE FOOT'` is
not in its SI table — so the `IfcConversionBasedUnit` chain is walked to its SI
base, exactly as `calculate_unit_scale` does for a whole project.

*Fix:* `model.declared_quantity` returns a `DeclaredQuantity(path, value, raw,
scale, unit_label)` in SI, and `floor_area` states the conversion in its caveat:
*"Die Datei deklariert 68.1018 SQUARE FOOT; umgerechnet 6.3269 m²."* All 60
sampled Trapelo rooms now agree.

*Regression:* `test_a_declared_area_in_square_feet_is_read_in_metres`,
`test_the_length_unit_does_not_decide_the_area_unit`.

### 3. A truncated file crashed the process, with nothing to catch

*Found on:* `broken/truncated.ifc` — `04-duplex.ifc` cut to 300 000 bytes.

`ifcopenshell.open()` **segfaults** on a file cut mid-entity. Not an exception: a
SIGSEGV, which takes the request, the connection and every other model in the
process with it. Measured at truncation points 100 000 and 300 000 bytes; the
same file cut at a line boundary parses fine, and 1 000 000 bytes parses fine, so
it depends on where the cut lands rather than on how much is missing.

Four more opening paths each leaked a different exception type: `OSError` for an
empty file and for a directory, `FileNotFoundError` for a missing one,
`ifcopenshell.Error` for an unparseable header, `SchemaError` for an unknown
schema. A caller cannot state a reason it has to discover by enumerating five
exception classes, and the fifth is not catchable at all.

*Fix:* a byte-level pre-flight in `SpatialModel.__init__`, and one
`ModelUnreadableError` carrying a German `reason` for every path. The truncation
check is the load-bearing one: a complete SPF file ends with
`END-ISO-10303-21;`, an interrupted upload essentially never does, and the last
4 KB are read before the parser ever sees the bytes. This is a guard, **not** a
validator — a file can still be malformed in ways only the parser discovers, and
the real answer remains the design doc's worker process.

*Regression:* `test_a_truncated_file_is_refused_before_the_parser_crashes` and
five siblings, plus
`test_a_valid_header_with_no_entities_is_a_model_not_an_error` — an empty model
must still answer every model-wide question (`bounds is None`, `storeys == []`,
`space_contacts() == {}`), which it does.

### 4. Every wall in every Revit export was reported as contradicting itself

*Found on:* `01-sample-house`, and every file with Revit's `Dimensions` pset.

`floor_area` searched for `NetFloorArea`, `NetArea`, `GrossFloorArea`, `Area` on
any subject. On the sample house's north wall that matched
`Dimensions.Area = 26.4829` — the wall's **elevation** area — and triangulated it
against the 4.10205 m² of footprint the wall actually has. Both numbers are
right; they measure different things. The output was *"Zwei Wege zu dieser Zahl
widersprechen sich … Das ist ein Befund über den Export"* on three of three walls
sampled, on a file where nothing is wrong.

*Fix:* `Area` and `NetArea` mean "floor area" only on something that has a floor.
For a non-spatial subject only the unambiguous `NetFloorArea` / `GrossFloorArea`
are consulted.

*Regression:* `test_a_walls_own_footprint_is_unchanged` pins the 4.10205 m².

### 5. A non-GlobalId answered about a different element

*Found on:* every file — a property of `file.by_guid`, not of any export.

`by_guid(None)` returns `None` rather than raising, so `extent(model, None)` died
of `AttributeError: 'NoneType' object has no attribute 'GlobalId'` several frames
from the mistake. Worse, `by_guid(123)` falls through to lookup **by entity id**
and returns `#123=IfcArbitraryOpenProfileDef` — a real entity, of the wrong kind,
for an id nobody asked about. An operator would have measured a profile
definition and reported it as the answer to a question about a wall.

That is precisely the failure `UnknownElementError` exists to prevent: its
docstring says a hallucinated GlobalId must never be reportable as *"das Modell
sagt dazu nichts"*, and it was instead reportable as a measurement.

*Fix:* `by_id` requires a non-empty `str`, and the entity that comes back must
carry the GlobalId that was asked for.

*Regression:* `test_anything_that_is_not_a_global_id_raises_the_contract_error`
over six input shapes, `test_an_entity_id_is_not_a_global_id`.

### 6. Deriving space boundaries had no time bound

*Found on:* `05-office-a` — **212 seconds**, inside one `opens_to()` call about
one window.

`space_contacts()` performs one OCCT solid offset per `IfcSpace` in the file, and
every operator that needs a derived boundary triggered the whole map. On a 4 MB
office export with 99 rooms that is 212 s of wall clock for a question about a
single window; on the 139-room Trapelo model it is worse. Nothing bounded it.

*Fix,* in two parts:

- **`bounds(space)` no longer builds the map at all.** It needs the contacts of
  *that* space, so `model.contacts_of(space)` does one offset — 98 of the 99 were
  work nobody had asked for. Measured on the sample house: the per-space cache
  afterwards contains exactly one entry.
- **The model-wide map, which the inverse question genuinely needs
  (`enclosed_by`, `opens_to`), is capped at `CONTACT_BUDGET_SECONDS = 30`** and
  sets `contacts_complete = False` when it runs out. Operators reading an
  incomplete map **refuse** rather than report a subset, and the refusal names the
  count reached, the budget, and the two ways out (export 2nd-level space
  boundaries, or run the extraction in a worker). A partial neighbour list is
  indistinguishable from a building with fewer neighbours, which is the one thing
  this library must never produce.

Asking from the element's side instead was measured and rejected: offsetting one
sample-house window costs 2.9 s and one **door 37.8 s**, against 0.55 s for a
room. The original docstring's reasoning holds; it just had no ceiling.

In practice the refusal is rare, because it only applies to exports with no
declared `IfcRelSpaceBoundary` — and in this corpus those are the files with 0, 2,
4 and 7 spaces, all of which complete in under 8 s. `05-office-a` reaches it only
for the minority of its windows that its 1 334 declared boundaries do not cover.

*Regression:* `test_bounds_costs_one_offset_not_one_per_room`,
`test_an_incomplete_contact_map_refuses_instead_of_reporting_a_subset`.

### 7. A property set outranked the real quantity set

*Found on:* `04-duplex`, `05-office-a`.

`util.element.get_psets` merges `IfcElementQuantity` and `IfcPropertySet` into one
dictionary, and the old search looped psets on the outside and names on the
inside — so the answer depended on export order twice over: any pset containing
`Area` beat a later pset containing `NetFloorArea`, and a Revit dimension echo
beat a real quantity set.

*Fix:* quantity sets are searched before property sets, and `names` is honoured as
the priority order the caller wrote it in.

*Regression:* `test_a_quantity_set_outranks_a_look_alike_property_set`.

### 8. Malformed operator arguments escaped as raw exceptions

*Found on:* the deliberate-abuse sweep, all files.

- `obstructions(model, {})` → `KeyError: 'openingId'`; `obstructions` with a prism
  naming an id from a *different* model → `RuntimeError: Instance with GlobalId
  'nope' not found`. A prism is a plain dict that travels through a caller, a JSON
  round-trip and possibly a cache, so all three are reachable.
- `ray(..., length=-5)` returned a **hit** — OCCT reports an intersection behind
  the origin — with `decidable=True`. `length=inf` returned a decidable "nothing
  there".
- `ray(model, "x", [0,0,1])` raised `ValueError: Unknown format code 'f' for
  object of type 'str'` while building its own `method` string, before the
  validation that was supposed to reject it could run.

*Fix:* `obstructions` validates the volume's shape and resolves the opening
through `by_id`; `ray` rejects non-finite and non-positive lengths and builds its
`method` defensively.

*Regression:* `test_obstructions_refuses_a_volume_that_is_not_a_prism`,
`test_obstructions_on_a_prism_from_another_model_raises`,
`test_a_ray_with_an_unusable_length_is_undecidable`,
`test_a_ray_with_an_unusable_geometry_is_undecidable`.

### 9. A window the export never chained came back as a bare empty list

*Found on:* `07-archicad18-nl` (390 of 464), `06-trapelo-feet` (49 of 190).

`hosted_in` walks `FillsVoids → RelatingOpeningElement → VoidsElements →
RelatingBuildingElement`. The ArchiCAD 18 export carries 79 `IfcRelVoidsElement`
for 464 windows and doors, because the wall bodies were written with their holes
already subtracted and no `IfcOpeningElement` at all. So the walk returned `[]`
— decidable, `provenance="computed"`, with the standard caveat about deriving
the answer from two relations.

`[]` is *true* and reads as *"dieses Fenster sitzt in keiner Wand"*, which is a
claim about the building. The truth is a claim about the file, and the two must
not look alike.

*Fix:* an empty result on a fenestration element carries its own caveat, naming
the missing chain, saying explicitly that it does **not** mean the window is in
no wall, and giving the re-export setting.

*Regression:* `test_a_window_the_export_never_chained_says_so` builds the dialect
in nine entities — one chained window, one orphan, in a file that plainly has
the relations.

### 10. Geometry the kernel rejects was reported as geometry that is absent

*Found on:* `07-archicad18-nl` — **94 of its 100 rooms**.

Every one of those hundred `IfcSpace` entities carries a full `Body`
representation, and OCCT refuses ninety-four of them with `Failed to process
shape`. `floor_area` correctly returned `decidable=False` — but with the wrong
diagnosis: *"Dieses Bauteil trägt in dieser Datei keinen Körper … das Modell mit
Körpergeometrie neu exportieren"*, which sends the architect to switch on an
export setting that is already on.

The two failures need different sentences. An element with **no representation**
is often normal (`IfcWindowLiningProperties`, a curtain-wall shell) and sometimes
an export defect. An element whose representation the **kernel cannot build** is
a geometry-validity problem in the model itself — a self-intersecting room
boundary, a zero-area profile, an unclosed shell — and re-exporting changes
nothing.

*Fix:* `SpatialModel.geometry_failure(global_id)` records which of
`no-representation` / `shape-failed: …` / `empty-mesh` happened, and `_no_geometry`
branches on it, carrying the kernel's own message into the remedy.

*Regression:* `test_a_body_the_kernel_rejects_is_not_reported_as_a_missing_body`,
`test_an_element_with_no_representation_at_all_says_that_instead`.

### 11. A ray over a model with no geometry scanned a made-up 100 m

*Found on:* `broken/header-only.ifc`, `broken/untessellatable.ifc`.

`model.diagonal` falls back to a flat `100.0` when nothing in the file has a
body, and `ray()` with no explicit length used it — returning
`decidable=True, value=None`, i.e. *"nothing within reach"*, about a model where
there was nothing to look at and no reach to speak of. A could-not-look wearing
the shape of a result.

*Fix:* `ray()` with no stated length on a model with no extent is undecidable and
says why. With an explicit length it is a real answer again.

*Regression:* inside
`test_a_valid_header_with_no_entities_is_a_model_not_an_error`.

---

## 7. What held up

Not everything was broken, and the parts that held are worth naming because they
are the parts the design doc bet on.

- **`use-world-coords` is set and it matters.** Every measurement in this run is
  in world coordinates and in metres, on files whose own units are millimetres,
  metres, feet and inches. IfcOpenShell converts geometry to SI regardless of the
  file's length unit — verified rather than assumed: the Trapelo door measures
  2.1844 m (7'2") and the AISC column 0.4096 m (16⅛"), both from files that state
  their lengths in feet and inches respectively.
- **The IFC2X3 / IFC4 split cost nothing on the inverse attributes.**
  `HasOpenings`, `FillsVoids`, `VoidsElements`, `BoundedBy`, `ProvidesBoundaries`
  and `ContainsElements` behave identically across the seven IFC2X3 and four IFC4
  files. Where the export *writes* the opening chain, the walk finds it: 930 of
  1 375 windows and doors resolve to a host, and the 445 that do not are
  concentrated in the two exports that wrote no `IfcOpeningElement` for them
  (defect 9) — not one is a schema difference.
  The one place the schemas do differ is `by_type` with an IFC4-only name:
  `file.by_type("IfcSpatialZone")` raises `RuntimeError: Entity with name
  'IfcSpatialZone' not found in schema 'IFC2X3'`, while `element.is_a(...)` with
  the same name safely returns `False`. Both call sites in this package were
  already on the safe side of that line.
- **Undecidable stayed a result.** 70 undecidable answers across the corpus, every
  one of them naming an IFC entity or relation the export is missing —
  `IfcGeometricRepresentationContext.TrueNorth` on the five files with no north,
  `IfcSpace` on the Snowdon export that models none,
  `IfcBuildingStorey.Elevation und die Modellgeometrie liegen auf verschiedenen
  Höhenbezügen` on the same file's 231 m datum split, `IfcRelVoidsElement` on the
  SketchUp export that models walls without openings, "kein Rasterpunkt lag im
  Raumkörper" on rooms too narrow for a 3×3 clear-height grid. Not one of them
  was a disguised failure.
- **Elements without a body were reported, not counted as errors** — 8–25 % of
  products per file, which is normal — and after defect 10 the report distinguishes
  "no representation" from "the kernel rejected the representation".

---

## 8. What this run did **not** test

Stated so the next person does not read this document as broader than it is.

- **No Vectorworks and no Tekla export.** §13 asks for both. No public sample of
  either was found; Allplan 2017 and SDS/2 stand in at that end of the market, and
  the dialect map is incomplete without them.
- **No federated model.** Every file is a single discipline. The MEP and structural
  siblings of the duplex and the Revit sample exist in the same repositories and
  were not run.
- **No IFC4X3.** `ifcbridge-model01.ifc` (IFC4X2) and the buildingSMART
  IFC4X3_ADD2 scene were profiled but not benchmarked; infrastructure schemas have
  no `IfcSpace` and a different spatial hierarchy, and claiming coverage there
  would be a guess.
- **The question set does not exist yet.** §13's real metric is decidability
  calibration over ~150 hand-verified questions. This run measures whether the
  operators survive real files and whether their numbers match the files' own
  declarations. It does not measure whether an agent asks the right one.
- **The segfault guard is a guard.** It catches truncation, which is the realistic
  corruption. It cannot catch a file that is complete and internally malformed, and
  no in-process check can. The worker process remains the answer.

