# Coverage: `@grid/ifc-spatial` (TypeScript) → `ifc-spatial-py` (IfcOpenShell 0.8.5)

**What this spike answers.** §14 of `docs/roadmap/agent-spatial-reasoning.md`
rejects IfcOpenShell *"unchanged: two readers means two interpretations"* and
names the condition under which the rejection flips: *"Revisit if the geometry
pass proves materially harder in WASM than the OCCT-based stack — in which case
the honest move is to make IfcOpenShell the **only** reader, not a second one."*
This package is the measurement that decision needs: the whole operator surface,
re-implemented on IfcOpenShell, asserted against the TypeScript package's own
ground truth on the same file.

**The result in one line.** 40 numeric and structural rows in parity, 3 rows with
no TS counterpart (capabilities the port adds), **1 genuine disagreement** — and
on that one the Python answer is the correct one and the TypeScript one is on the
unsafe side.

```
cd packages/ifc-spatial-py && PYTHONPATH=src python3 -m pytest tests/test_parity.py -s
# 30 passed · 44 rows · 1 finding
```

Nothing under `packages/ifc-spatial/` was touched.

**This document measures one file.** [CORPUS.md](CORPUS.md) is the run over
eleven third-party exports that followed it, and it found eleven defects this
suite could not see — including two that produced confident wrong numbers on
files this fixture does not resemble. Read the two together; where they
disagree, CORPUS.md is later and measured on more.

---

## 1. Operator coverage

`direct` — one IfcOpenShell call does it.
`derived` — a few calls plus arithmetic we still own.
`better than ours` — IfcOpenShell's primitive is strictly stronger than the TS
implementation, and the port uses it (and says so in the docstring).
`not available` — the primitive §7 names does not work, or does not exist.

### Topological

| TS operator | IfcOpenShell primitive | status | note |
|---|---|---|---|
| `hosts(element)` | `element.HasOpenings` → `IfcRelVoidsElement.RelatedOpeningElement` | **direct** | inverse attribute; no graph to build |
| `fillerOf(opening)` | `opening.HasFillings` → `IfcRelFillsElement.RelatedBuildingElement` | **direct** | |
| `hostedIn(element)` | `FillsVoids` → `RelatingOpeningElement.VoidsElements` → `RelatingBuildingElement` | **direct** | the TS package materialises this as a derived `hostedIn` edge in a CSR index; here it is two attribute hops |
| `bounds(space)` | `space.BoundedBy`; fallback `geom.tree.select(space, extend)` | **better than ours** | with no `IfcRelSpaceBoundary` in the file, TS needs a whole `withDerivedBoundaries` pass over the tessellation; here the fallback is one exact solid query |
| `enclosedBy(element)` | `element.ProvidesBoundaries`; fallback the same contact map | **better than ours** | same reason |
| `opensTo(window/door)` | `ProvidesBoundaries`; fallback contact map | **better than ours** | TS derives it through `hostedIn` + a 30 cm box contact test; the fallback here is a real solid-to-solid test at 5 cm and does not need the wall's boundaries to exist |
| `contains(container)` | `container.ContainsElements` → `RelatedElements` | **direct** | |
| `containerOf(element)` | `element.ContainedInStructure` / `util.element.get_container` | **direct** | |
| `adjacentSpaces(space)` | shared bounding element over the contact map | **derived** | §7 maps this onto `clash_collision_many` — see §3, it is unusable |
| `connects(element)` | `element.ConnectedTo` / `ConnectedFrom` (`IfcRelConnectsPathElements`) | **direct** *(not ported — a five-line read; 8 relations present in the fixture)* | |
| `elementsOfStorey(storey)` | `util.element.get_decomposition(storey)` | **better than ours** *(not ported)* | walks aggregation *and* containment, which is exactly the chain the TS parser had to resolve by hand so a door assigned to a space is not lost |

### Metric

| TS operator | IfcOpenShell primitive | status | note |
|---|---|---|---|
| `extent(element)` | `util.shape.get_bbox(get_vertices(shape))` | **direct** | `get_x` / `get_y` / `get_z` give the three dimensions directly |
| `floorArea(space)` | shapely **union** of the projected faces, both facings | **better than ours** | union instead of a sum, so overlapping horizontal faces cannot double-count. Also finds the declared quantity itself, converts its unit and triangulates — TS needs the host to pass it in. Originally `util.shape.get_footprint_area`; the corpus run replaced it because it returns `0.0` for an inside-out mesh and raises on `direction=(0,0,-1)` — see [CORPUS.md](CORPUS.md) defect 1 |
| `elevation(element)` | `get_bbox` + `IfcBuildingStorey.Elevation × unit scale` | **direct** | `util.shape.get_bottom_elevation` / `get_top_elevation` exist too |
| `sillAndHead(window)` | `get_bbox` − storey datum | **direct** | the datum-drift guard stays ours (it is an epistemic rule, not a geometry one) |
| `azimuth(element)` | triangles from `create_shape` + `TrueNorth` | **derived** | IfcOpenShell has no "which way does this face" primitive; the largest-vertical-cluster logic is ported |
| `distance(a, b, mode)` | box gap over `get_bbox`; centroid from triangle areas | **derived** | §7 maps `min` onto `clash_clearance_many`, which would give the true solid-to-solid distance — see §3 |
| `clearHeight(space)` | `geom.tree.select_ray` grid from the floor | **better than ours** | TS returns the space solid's height and says in its own caveat that the intersection test is missing. It is not missing here — and the two answers differ by 30 cm on this file |

### Constructive

| TS operator | IfcOpenShell primitive | status | note |
|---|---|---|---|
| `facadePlaneOf(element)` | triangles + our plane seating | **derived** | no primitive for "the outermost real face parallel to this normal"; the TS logic ports unchanged and lands on the same face (y = 4.698582 against 4.6986) |
| `overhang(a, facadeOf(b))` | signed distance over `create_shape` vertices | **derived** | 0.646638 against the TS 0.646638 — Δ 0.4 µm |
| `ray(origin, dir, len)` | `geom.tree.select_ray` | **better than ours** | exact OCCT surface intersection instead of a retained-triangle test, and it returns the surface **normal** and **dot product** as well as the hit. The TS ray has to warn that elements whose triangles were dropped went untested; nothing is dropped here |
| `prism(opening, angle, swivel)` | our four half-spaces over IfcOpenShell vertices | **derived** | the construction is ours in both engines; every number matches (sill 0.900, edge width 1.810) |
| `obstructions(volume, exclude)` | `geom.tree.select_box` broad phase + Sutherland–Hodgman clip | **derived** | §7 suggests `tree.select(shape, extend)`, but the prism is an unbounded half-space volume, not an `IfcProduct`, and `select` takes an element or a `TopoDS_Shape` — and the wheel is built without `python-occ` (`ifcopenshell.geom.has_occ == False`), so a `TopoDS_Shape` cannot be constructed from Python. Broad phase from the tree, exact clip ours. Depths match to 0.3 mm at 30/45/60° |
| `freeLightIncidence(...)` | composition | **derived** *(not ported)* | `worstAngleDeg` is a horizon scan over the same clipped polygons; nothing new is needed from the engine |

### Model-wide and infrastructure

| TS module | IfcOpenShell | status | note |
|---|---|---|---|
| `briefing()` / `renderBriefing()` | composition + `util.selector` for the coverage counts | **derived** | the DIALEKT block is a `util.selector` aggregation; the BLIND block stays our judgment |
| `storeyHeights()` | `IfcBuildingStorey.Elevation` + `get_bbox` | **direct** | |
| `inventory('aufenthaltsraum')` | — | **not available** | a German room-name lexicon with umlaut folding and longest-match ranking. No geometry kernel has an opinion about whether *Waschküche* is an Aufenthaltsraum. Stays hand-written, stays `inferred` |
| `graph/build.ts` (CSR relation graph) | — | **not needed** | ~1 300 lines of parser and index replaced by inverse attributes. This is the single largest deletion the swap makes possible |
| `geometry/pass.ts` | `geom.iterator` (8 threads) | **better than ours** | 74 products, float64, no triangle budget. The TS pass retains 24 494 triangles under a cap and degrades operators to bounding boxes when it truncates — a whole class of caveat that disappears |
| `geometry/boundaries.ts` (derived 2nd-level boundaries) | `space_contacts()` over `tree.select` | **better than ours** | 30 cm box contact → 5 cm exact solid contact |
| `cache.ts` (content-addressed graph cache) | — | **not available** | ours; unchanged by the engine |
| `render/project.ts` (SVG drawings) | — | **not available** | ours. `util.shape` gives the same triangles, so the projection code ports as-is |
| `mcp/` (tool server) | — | **not available** | ours |
| `envelope.ts` | — | **not available, and must not be** | this is the product. Ported verbatim, German wording included |

---

## 2. What IfcOpenShell does better — with the measurements

1. **Room areas that reproduce the authoring tool exactly.** The union-based
   footprint returns 15.41678125 m² for the bedroom against the file's own
   declared `BaseQuantities.NetFloorArea` of 15.41678125 — agreement to
   4·10⁻¹⁴ relative. (Measured with `util.shape.get_footprint_area`; the
   corpus run later replaced that call with the same method applied to both
   facings, and the number did not move by 10⁻⁹ — [CORPUS.md](CORPUS.md).)
   The TS pass gives 15.416782273888543, off by 10⁻⁶ m², because it carries
   float32 tessellation output. Both are far inside any useful tolerance; the
   point is that the union-based projection has no accumulation error to argue
   about.
2. **The clear height is measurable.** See §4 — the one genuine disagreement.
3. **Exact ray casting.** `select_ray` hits the real surface and reports the
   normal and the dot product. Hit y = 4.612582 against the TS 4.613 (asserted at
   two decimals in the TS spec).
4. **Exact contact instead of box contact.** The window→room relation comes out
   of a real solid proximity query at 5 cm rather than a 30 cm bounding-box test,
   and it does not need the host wall's boundaries to be derivable first.
5. **No triangle budget.** `pass.ts` caps retained triangles and degrades
   `overhang`, `obstructions` and `ray` to bounding boxes when the cap bites,
   each with its own caveat. Nothing here degrades: every operator measures
   against the full body.
6. **The relation graph is not built at all.** `buildGraph` (~300 ms and a CSR
   index) has no counterpart: `FillsVoids`, `VoidsElements`, `ContainsElements`,
   `BoundedBy`, `ProvidesBoundaries`, `ConnectedTo` are attributes on the entity.
7. **Quantities in any dialect.** `util.element.get_psets` found this file's
   `BaseQuantities.NetFloorArea` — a Revit-flavoured pset that a search for
   `Qto_SpaceBaseQuantities` misses entirely. That is what makes the automatic
   triangulation in `floor_area` possible.

---

## 3. What it cannot do — measured, not assumed

**`clash_collision_many`, `clash_clearance_many` and `clash_intersection_many`
return an empty tuple for every input on this build.** Not an exception, not a
warning: an empty result.

Reproduced against three tree-construction routes (`tree(file, settings)`,
`tree.add_file`, `add_iterator` with `iterator-output = NATIVE`) and against
directly `add_element`-ed `BRepElement`s, on pairs that visibly touch — the north
and east walls of the sample house, the roof against every wall, a window against
the wall it sits in, two rooms 100 mm apart at a 400 mm clearance. `select`,
`select_box` and `select_ray` work on the same trees. `ifcopenshell.geom.has_occ`
is `False` in this wheel, which is the likely cause.

This matters because §7 maps three operators onto exactly those calls
(`adjacentTo` → `clash_collision_many`, `distance` → `clash_clearance_many`,
plus clash checking as a product feature). **A primitive that answers "keine
Nachbarn" by failing silently is the worst possible foundation for a library
whose entire purpose is calibrated ignorance**, so this port uses none of them
and says so in the operator docstrings. `adjacent_spaces` goes through shared
bounding elements; `distance('min')` measures box gaps exactly as the TS does.
Anyone adopting IfcOpenShell must either build a wheel with OCC support and
re-test, or treat clash as unavailable.

**Two costs that are real:**

- `tree.select(element, extend=d)` performs an OCCT **offset of the subject
  solid**. The cost is a property of the subject, not of the tolerance:
  offsetting one window of this file takes **2.9 s** at any extend, one room
  **0.55 s**. `extend=0` is not a way out — without an offset the query is a
  strict intersection and two solids that merely touch do not register (the
  window returns *nothing* at `extend=0`). The port therefore asks the question
  once per **space** and caches the contact map: 6.1 s once for this file's four
  spaces, then every `opens_to` / `bounds` / `enclosed_by` is a dictionary
  lookup (0.15 ms).
- The geometry pass is **1.6–2.4 s** against the TS pass's **345 ms** — 5–7×
  slower for a 2.3 MB house, in exchange for float64 and no triangle cap. This
  is the number that decides §11's "extraction must leave the request process and
  become a worker": with IfcOpenShell it is not optional.

**What no engine can supply**, unchanged from §11: room use is a legal
classification (`inventory` stays a name lexicon and stays `inferred`); anything
outside the file (neighbours, terrain) stays outside; a *Besonnungsstudie* needs
georeferencing this port deliberately does not turn into a solar operator.

---

## 4. The one disagreement, and who is right

| | TS `clearHeight(Living room)` | Py `clear_height(Living room)` |
|---|---|---|
| value | **2.500 m** | **2.200 m** |
| method | Z extent of the `IfcSpace` solid | 25 upward rays from the floor, `geom.tree.select_ray` |
| what it saw | the modelled room volume | `IfcCovering` "Compound Ceiling:Plain", z 2.200–2.257 |

Both engines agree on the space solid (0.000–2.500 m). The TS operator's own
caveat states the limitation exactly — *"Unterzüge, Lüftungsleitungen und
abgehängte Decken ragen in den Raum, ohne den Raumkörper zu verkürzen … dafür
fehlt dieser Bibliothek noch der Verschneidungstest"* — and IfcOpenShell has that
test. The suspended ceiling is real, it is in the file, and it is 30 cm.

**The Python value is the right one, and the direction matters:** an OIB minimum
room height is a clear dimension under the lowest obstruction, so the TS number
would pass a room that fails. The parity test records this as a FINDING and
asserts 2.20 m; no tolerance was widened.

Two caveats on the new operator, both stated in its own `caveat`: it samples a
grid (a narrow downstand between two sample points can be missed — refine
`samples` for a Nachweis), and it excludes `IfcFurnishingElement` by type,
because a piano is not a Raumhöhe.

---

## 5. The four adjacent tools

Evaluated by running them on `Ifc4_SampleHouse.ifc`, not by reading their
READMEs. Installed for the test: `ifctester 0.8.5` (needs `--no-deps`: its
`odfpy` dependency has no wheel and fails to build here), `ifc5d 0.8.5`,
`ifcdiff 0.8.5`. `ifcopenshell.util.selector` ships with IfcOpenShell.

### `ifcopenshell.util.selector` → replaces the query layer's filter grammar

**Drop-in for the filter half, not for the aggregation half.** A real lark
grammar with entity, attribute, type, material, classification, location, parent,
property and GlobalId facets; `,` is AND inside a group and `+` unions groups.
Measured on the fixture:

| query | result | time |
|---|---|---|
| `IfcWall` | 5 (includes `IfcWallStandardCase`) | 1.5 ms |
| `IfcWall + IfcWindow` | 9 | 1.9 ms |
| `IfcWall, Pset_WallCommon.IsExternal=TRUE` | 3 | 3.9 ms |
| `IfcSpace, Name*=Bedroom` | 1 | 1.6 ms |
| `IfcWindow, type=1810x1210mm` | 4 | 2.3 ms |
| `IfcWall, material*=Brick` | 2 | 2.1 ms |
| `location="Ground Floor"` | 68 | 29.9 ms |
| `3cUkl32yn9qRSPvBJVyWcE` (bare GlobalId) | 1 | 0.9 ms |

`get_element_value(window, "type.Name")` → `'1810x1210mm'`,
`"storey.Name"` → `'Ground Floor'`, `"BaseQuantities.Area"` → `3.5348570571731`.
That last one is the dialect problem solved in one call.

**Not drop-in:** numeric comparisons on a property path fail to parse
(`Pset_WallCommon.ThermalTransmittance>0.2` → `UnexpectedCharacters`), so
threshold filters still need our code; there is no aggregation (`sum`,
`groupBy`), no truncation reporting, and no "über X von Y Bauteilen" coverage
statement — which is the honest half of our `aggregate`. Adopt it as the
**filter** engine underneath `ifc_query`, keep our aggregation and our caveats
on top.

### `ifctester` → replaces `missingPropertyShoppingList`

**Drop-in in the direction that matters, and a strict superset.** An IDS built in
memory from three lines of Python, validated against the file in **2.3 ms**:

```
spec "Fenster müssen Brüstungshöhe und U-Wert deklarieren"  status False  0/4 passed
  req Pset_WindowCommon.SillHeight            → False, 4 failed entities, each with a reason
  req Pset_WindowCommon.ThermalTransmittance  → True
```

That is exactly our shopping list — *which property is missing, on which
elements, and what would settle it* — in the buildingSMART standard format, with
`reporter.Json`, `reporter.Html` and **`reporter.Bcf`** available. §5 item 11 and
§14's "not an alternative — an adoption" are both confirmed: emitting IDS lets an
architect run our requirements inside Solibri or BIMcollab, and `ifctester`
validates it too, so the same artefact is both our refusal and their check.

**What does not come free:** the German `remedy` sentences. IDS carries an
`instructions` field per requirement, so they can travel — but they are our text,
and mapping our `MissingFact` to IDS facets (six of them: Entity, Attribute,
Classification, Property, Material, PartOf) is a translation layer we write once.
Note also that IDS states *which properties must exist*; our shopping list also
covers *geometry* gaps ("dieser Export enthält keine IfcSpace"), which IDS
expresses only as an Entity facet — a coarser statement than ours.

### `ifc5d` → replaces `takeoff`

**Not drop-in, and it does not cover the thing we need most.** `qto.quantify`
computes standard base quantities from geometry:

- walls + windows: **293 ms** for 9 elements, giving `Qto_WallBaseQuantities`
  with `GrossSideArea` 28.7399 m², `GrossVolume` 7.6883 m³, `Length` 14145.0,
  `Width` 290.0, `Height` 2473.70;
- **spaces: 0 results.** The rule set declares `IfcSpace` →
  `Qto_SpaceBaseQuantities` with all 13 quantities, and the `IfcOpenShell`
  calculator implements none of them, so `quantify` returns `{}`.

So the operator we care about most — room floor area — is not served by `ifc5d`
at all, while `util.shape.get_footprint_area` serves it exactly (§2). Two further
frictions: quantities come back in **mixed units** (areas and volumes in m²/m³,
lengths in the file's own unit — 14145.0 mm next to 28.74 m²), and `edit_qtos`
writes them back into the file, which is a mutation our read-only pipeline must
not perform. Adopt `ifc5d` as a *second route* for element quantities in
`triangulate`, not as the takeoff engine.

### `ifcdiff` → replaces `compare`

**Not drop-in. It reports 60 of 68 elements as changed when diffing the file
against itself.**

```
IfcDiff(open(P), open(P), relationships=["property","type","container"]) → 60 changed
   every one of them: {"container_changed": true}
IfcDiff(open(P), open(P), relationships=["property","type"])             →  0 changed
IfcDiff(open(P), open(P))  # default: geometry check on 62 items         →  0 changed
```

The container comparison is the entire defect; with it disabled the tool is
sound, and its geometry path (shape-level comparison at the file's own precision)
is a capability we do not have. Diffing a real edit (one `LongName`, one
`OverallHeight`) takes **0.29 s** on this file and finds them.

Adoption: usable for `compare` **only** with `relationships` restricted to
`["property", "type"]` plus the geometry pass, and only after the container false
positive is reported upstream or worked around. An 88 % false-positive rate on a
revision comparison is precisely the "confident wrong answer that gets signed"
failure mode, and it would arrive wearing the authority of an official tool.

---

## 6. Timings and memory — `Ifc4_SampleHouse.ifc` (2.3 MB, 47 309 entities, 74 products)

| step | TypeScript (`@ifc-lite`) | Python (IfcOpenShell 0.8.5) |
|---|---|---|
| open + relation graph | `buildGraph` **302 ms** | `ifcopenshell.open` **234–249 ms**, no graph to build |
| geometry pass | `runGeometryPass` **345 ms** (24 494 retained triangles) | `geom.iterator`, 8 threads **1 576–2 354 ms** (no cap, float64) |
| derived space boundaries | `withDerivedBoundaries` **2 ms** (30 cm box test) | contact map **6 090 ms** once (4 spaces, exact OCCT offset) |
| spatial tree | — | `geom.tree` NATIVE **942–1 030 ms** (`tree.add_file` is **6 700–8 000 ms** — use the iterator) |
| `hostedIn` | — | **2.7 ms** (cold file, no geometry needed) |
| `floorArea` | **0.31 ms** | **6.8 ms** cold / **1.7 ms** warm |
| `opensTo` | — | **0.15 ms** warm (after the contact map) |
| `overhang` | **1.31 ms** | **0.84 ms** warm |
| `ray` | — | **9.7 ms** |
| `obstructions` (45° prism) | — | **241 ms** |
| `clearHeight` (25 rays) | n/a — TS cannot | **438 ms** |
| peak RSS | — | **351 MB** |

The shape of it: **IfcOpenShell is slower to load and faster to be right.**
Every fixed cost is one-time and cacheable; every per-question cost is
milliseconds. The 5–7× geometry pass is the price of float64 and no truncation,
and it forces the worker §11 already demands.

---

## 7. The trap that produces plausible wrong numbers

`ifcopenshell.geom.create_shape` returns coordinates in the **element's own
placement frame** unless `settings.set("use-world-coords", True)`. Verified on
this file: without it the north window still measures 1.81 × 1.21 m — matching
its type name, which is exactly the cross-check one would use to feel safe — but
its sill reads 0.000 m instead of 0.900 m and the roof overhang is measured from
the wrong origin. Every number stays dimensionally sensible; only the building is
different. It is set once, in `SpatialModel.__init__`, and no operator may
override it.
