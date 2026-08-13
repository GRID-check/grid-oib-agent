# Adversarial review: `ifc_measure` / `ifc-spatial-py` (2b5adb2f..HEAD)

**Reviewer:** adversarial pass, 2026-08-12. **Method:** everything below was run.
Engine suite `python3 -m pytest tests -q` in `packages/ifc-spatial-py` — **267
passed**. The defects below are all reachable through the shipped tool surface
and none of them fails a test.

Reproduction harness used throughout (paths absolute):

```python
# save as /tmp/d3.py, run with `uv run python` from the repo root
from ifc_spatial.tools import create_tools, call as tcall
from aiq_agent.agents.bim.measure_register import _render, _decimals, _num
F = '/home/user/grid-oib-agent/packages/ifc-spatial/test/fixtures/'
TOOLS = create_tools()
def call(name, **args): return tcall(TOOLS, name, args)
def render(op, payload): print(_render(op, payload))
```

Severity language: **A** = would change a number an architect signs. **B** =
would change how a finding is read. **C** = cosmetic / robustness.

---

# CONFIRMED

## 1. (A) `adjacentSpaces` makes two rooms neighbours through a shared FLOOR SLAB — and calls it `declared`

`operators.adjacent_spaces` intersects the `bounds()` sets of two spaces and
declares a neighbour on **any** shared element. It applies no filter for
horizontal elements. `packages/ifc-spatial/test/fixtures/geschossdecke-und-fenster.ifc`
was authored specifically to pin this down; its own header comment says:

> „ONE SLAB UNDER MANY ROOMS. #26 is the floor of all three rooms … Two rooms
> that share only this slab are stacked or side by side — they are **NOT**
> neighbours. `Wohnen` and `Bad` share nothing else, so they must not come back
> adjacent … In `Trapelo_Design_Intent.ifc` one slab carried boundaries to 93 of
> 139 spaces and the unrestricted rule made 4 278 pairs of it."

Reproduce:

```python
r = call('open_model', path=F+'geschossdecke-und-fenster.ifc'); h = r['model']
render('relations', call('relations', model=h, globalId='4Decke00000Space00001',
                         relation='adjacentSpaces'))
```

Output:

```
deklariert: 2 Einträge — so steht es in der Datei.
- IfcSpace „Kueche“ · GlobalId 4Decke00000Space00002 (über shared bounding element)
- IfcSpace „Bad“   · GlobalId 4Decke00000Space00003 (über shared bounding element)
```

`Bad` shares **only the floor slab** with `Wohnen`. The fixture's stated
invariant is violated. `adjacentSpaces('4Decke00000Space00003')` likewise returns
both `Wohnen` and `Kueche`.

Two defects in one answer:

- **the adjacency is wrong** — and it scales the way the fixture comment warns:
  on a real export one slab per storey makes every room on that storey a
  neighbour of every other. Everything built on adjacency inherits it.
- **the provenance is wrong.** The file declares no adjacency; it declares six
  `IfcRelSpaceBoundary` rows. The adjacency is a set intersection **we**
  performed. `adjacent_spaces` promotes it to `declared` whenever `bounds` was
  declared (`provenance_declared = own.provenance == "declared"`,
  `operators.py:761`), and the renderer prints **„so steht es in der Datei"**.
  That is invariant 1 broken in the most direct way available: a computed fact
  wearing the architect's own signature. It also loses the `computed` branch's
  caveat („Nachbarschaft heißt … NICHT begehbare Verbindung"), which is only
  attached to the derived path.

No test exercises `adjacentSpaces` against this fixture. `grep -rn
"adjacentSpaces" packages/ifc-spatial-py/tests/` hits only `test_parity.py:167`
(sample house, which has zero `IfcRelSpaceBoundary` and therefore never takes the
declared branch).

## 2. (A) `lightEntryArea` double-counts an opening that a 2nd-level export bounds twice

`bounds()` returns `model.refs(declared_boundaries)` and `model.refs`
(`model.py:414`) does **not** deduplicate. 2nd-level space boundaries routinely
split one element's boundary into several surfaces per space — which is exactly
the export §5 item 7 and §13 of the roadmap ask for. Every such duplicate is
summed again.

Reproduce (adds two boundary rows for one window, as a 2nd-level exporter would):

```python
import ifcopenshell
f = ifcopenshell.open(F+'Ifc4_SampleHouse.ifc')
sp  = f.by_guid('3w0zWKm7n8SB1qbfwUzt0J')   # Bedroom
win = f.by_guid('3cUkl32yn9qRSPvBJVyWcE')   # its only window
for i in (1, 2):
    f.create_entity('IfcRelSpaceBoundary', GlobalId=ifcopenshell.guid.new(),
        Name=f'Bedroom-Window-part{i}', RelatingSpace=sp, RelatedBuildingElement=win,
        PhysicalOrVirtualBoundary='PHYSICAL', InternalOrExternalBoundary='EXTERNAL')
f.write('/tmp/split-boundary.ifc')
```

```
gemessen: Lichteintrittsfläche 4.380 m² auf 15.42 m² Bodenfläche = **28.41 %**
- außenliegend: IfcWindow „Windows_Sgl_Plain:1810x1210mm:286105“ · 2.190 m² · GlobalId 3cUkl32yn9qRSPvBJVyWcE
- außenliegend: IfcWindow „Windows_Sgl_Plain:1810x1210mm:286105“ · 2.190 m² · GlobalId 3cUkl32yn9qRSPvBJVyWcE
```

The correct answer is 14.21 %. This is the same „two opposite answers to one
daylight check" §12b records as fixed, in a second doorway. The GlobalId is
repeated on two lines, so a careful reader could catch it — but the bolded
percentage, which is the number the agent quotes, is doubled, and the caveat says
nothing. Worse: the better the export (real 2nd-level boundaries), the more
likely the bug, because `bounds` prefers the declared route.

## 3. (A) `lightEntryArea` credits a shared opening 100 % to every room it bounds

There is no clipping of an opening to the room's own height band or footprint.
On the sample house the six curtain-wall panes (31.085 m² total, each spanning
z = 0…3.36 m) are credited **in full** to the Living room (z = 0…2.5) and **again
in full** to the `Roof` loft (z = 2.5…3.5, 1.00 m tall):

```python
r = call('open_model', path=F+'Ifc4_SampleHouse.ifc'); h = r['model']
render('measure', call('measure', model=h, globalId='3w0zWKm7n8SB1qbfwUzt0U', measure='lightEntryArea'))  # Living
render('measure', call('measure', model=h, globalId='09J5N7xMHBfQZeQGAEMota', measure='lightEntryArea'))  # Roof
```

```
Living: Lichteintrittsfläche 37.656 m² auf 51.99 m² Bodenfläche = **72.42 %**
Roof:   Lichteintrittsfläche 31.085 m² auf 76.47 m² Bodenfläche = **40.65 %**
```

Verified against `measure/extent`: the Living room's box is
`z ∈ [0, 2.5]`, `Roof`'s is `z ∈ [2.5, 3.5]`, pane `3cUkl32yn9qRSPvBJVyW_5` is
`z ∈ [0, 3.359]`. At most ~0.86 m of each pane lies inside the loft, so its true
light-entry area is a fraction of the 31.09 m² reported. Nothing in the payload
or the caveat hints that the opening was shared, and the direction is the unsafe
one (too large). Both numbers are the input to an OIB 3 Raum-% — the operator
this whole package was justified by.

## 4. (A) A glazed curtain-wall panel is classified „Innentür" the moment `IsExternal` is absent

`_faces_outside` prefers the element's own `IsExternal` and otherwise falls back
to a **door** heuristic (`count >= 2 → False`, „öffnet in 2 Räume (Innentür)").
Its own docstring records that this fallback broke the sample house's glazed
facade; the fix was to consult `IsExternal` first, and the fallback itself is
unchanged. Where `IsExternal` is not authored — which the docstring for
`declared_property` itself calls the common case — the wrong answer is back, at
full confidence, with no `unbestimmt` hedge.

Reproduce (rename the two `IsExternal` properties the file carries):

```python
f = ifcopenshell.open(F+'Ifc4_SampleHouse.ifc')
for p in f.by_type('IfcPropertySingleValue'):
    if p.Name == 'IsExternal': p.Name = 'IsExternalXX'
f.write('/tmp/no-isexternal.ifc')
```

```
Living: Lichteintrittsfläche 6.570 m² auf 51.99 m² = **12.64 %**   (was 72.42 %)
- NICHT gezählt (innenliegend): IfcPlate „System Panel:Glazed:285586“ · 6.272 m² · öffnet in 2 Räume (Innentür)
  … six panes, 31.09 m² of glass wall, all labelled Innentür
```

The rendered German calls a 6.27 m² glazing panel an *Innentür*. It is not a
door and it does not open into two rooms — it bounds one double-height space that
the export split into two `IfcSpace`. The three-state discipline exists exactly
for this: these panes should land under `unbestimmt`, not under `innenliegend`.

## 5. (B, very high frequency) Every wrong-argument and no-geometry answer is published as a finding about the export — with a double negation

`_provenance_line` (`measure_register.py:617`) renders any `decidable: false` as:

> `NICHT ENTSCHEIDBAR: dieser Export liefert {missing.what} nicht. Das ist ein
> Befund über den EXPORT, nicht über das Gebäude.`

The template assumes `what` is a noun phrase. Two producers break it.

**5a — `_wrong_kind` (17 call sites).** Its own docstring says „nothing is in
fact missing from the file"; the renderer then says the opposite.

```python
render('measure', call('measure', model=h, globalId='3cUkl32yn9qRSPvBJVyW_5', measure='clearWidth'))
```

```
NICHT ENTSCHEIDBAR: dieser Export liefert clearOpeningWidth() erwartet eine
Öffnung, ein Fenster oder eine Tür, bekam IfcPlate nicht. Das ist ein Befund
über den EXPORT, nicht über das Gebäude.
```

Ungrammatical, and it asserts an export defect for a caller mistake — the exact
inversion of invariant 2. SKILL.md §4 then instructs the agent that
`decidable: false` „ist ein Befund, kein Fehler" and that `missing.what` and
`missing.remedy` „gehören beide in die Antwort", so the agent is *told* to relay
it to the architect.

**5b — `_no_geometry`, double negation.** `what` already begins with „keine",
so the template produces a sentence that means the opposite of what is intended:

```python
r = call('open_model', path=F+'einheiten-fuss.ifc'); h = r['model']
render('measure', call('measure', model=h, globalId='3Fuss000000Wall000001', measure='extent'))
```

```
NICHT ENTSCHEIDBAR: dieser Export liefert keine geometrische Repräsentation für
IfcWall „Aussenwand“ in dieser Datei nicht.
```

**Frequency.** A sweep of every `measure` and every `relations` over all five
fixtures — 1 850 calls — produced **316** answers matching `liefert kein…
nicht`, across all five files including the sample house (`IfcCurtainWall
3cUkl32yn9qRSPvBJVyW_P`, whose geometry lives on its panels). This is the most
common non-answer in the system.

The same sweep found **no** dict-reprs, no NaN/inf and no 17-digit floats in real
answers — see SUSPECTED below.

## 6. (A) The skill and two tool descriptions still route a lichte Breite to `extent`, and relabel a Rohbaulichte as a Durchgangsbreite

§12b names this defect class („`DISTANCE_MODES["horizontal"]` was documented as
'what a lichte Breite check needs'") and records it as corrected. Three copies of
the same mistake are still shipped, now pointing at `extent` instead:

| where | text |
|---|---|
| `SKILL.md:175` | „Für eine lichte Durchgangsbreite `measure: "extent"` am Bauteil selbst." |
| `measure_register.py` `DISTANCE_MODES["horizontal"]` | „NOT a lichte Breite: for a clear width use measure/extent on the opening" |
| `measure_register.py` `_build_call`, bad-mode error | „For a lichte Breite use operation='measure' with measure='extent' on the opening" |

What `extent` actually returns for the sample house's internal door
`3cUkl32yn9qRSPvBJVyWaG` (type name `Doors_IntSgl:810x2110mm`, so the oracle is
0.810 × 2.110 m):

```
gemessen (±0.01 m): width=0.178, depth=0.880, height=2.145
```

`width` is the door **thickness**; `depth` is the leaf-plus-lining silhouette,
8.6 % over the true clear opening. `clearWidth` on the same element returns
`width=0.810, height=2.110` — exact to the millimetre. An agent following the
skill on an escape-route width gets 0.178 m or 0.880 m, and `extent` offers no
way to know which of the two is the passage.

Two further mislabels in the same skill:

- `SKILL.md:45` and `:119-120` call the `clearWidth` result **„die lichte
  Durchgangsbreite"**. The operator's own caveat says the opposite: „Gemessen ist
  die ROHBAULICHTE … Die lichte DURCHGANGSBREITE einer Tür wird zwischen den
  fertigen Zargenfalzen gemessen und ist … 15–25 % kleiner." The skill launders
  the hedge away, in the unsafe direction, in an OIB 2 width check.
- `SKILL.md:45` routes **„Treppe, Rampe"** to `clearWidth`. `clear_opening_width`
  accepts only `kind == "opening"` or a member of `FENESTRATION`; an `IfcStair`
  or `IfcRamp` hits `_wrong_kind` and comes back as finding 5a — an advertised
  capability that does not exist, whose failure reads as an export defect.

## 7. (A) An SI prefix on an area unit is applied linearly, not squared

`model._unit_scale_to_si` finishes with `scale *= uu.get_prefix_multiplier(unit.Prefix)`
regardless of the unit's dimensionality. For `IfcSIUnit(*, .AREAUNIT., .CENTI.,
.SQUARE_METRE.)` IFC means (0.01 m)² = 1e-4 m²; the function returns 1e-2 — 100×
off. `MILLI SQUARE_METRE` would be 1000× off; volume units are cubed and worse.

Direct:

```python
from ifc_spatial.model import _unit_scale_to_si
# IfcSIUnit(*,.AREAUNIT.,.CENTI.,.SQUARE_METRE.)  ->  0.01   (should be 0.0001)
```

End to end, on a **self-consistent** file (prefix set to CENTI *and* every
`IfcQuantityArea` multiplied by 10 000, so the declared areas are unchanged in
reality):

```python
f = ifcopenshell.open(F+'Ifc4_SampleHouse.ifc')
for u in f.by_type('IfcUnitAssignment')[0].Units:
    if u.is_a('IfcSIUnit') and u.UnitType == 'AREAUNIT': u.Prefix = 'CENTI'
for q in f.by_type('IfcQuantityArea'): q.AreaValue = float(q.AreaValue) * 10000.0
f.write('/tmp/centi-clean.ifc')
# then: render('measure', call('measure', model=h, globalId='3w0zWKm7n8SB1qbfwUzt0J', measure='floorArea'))
```

```
WIDERSPRUCH zwischen zwei Wegen zu dieser Zahl — siehe Hinweis.
Hinweis: … 15.417 (computed) gegen 1541.678 (declared), Abweichung 99.0 %.
Die Datei deklariert 154167.8125 CENTISQUARE_METRE; umgerechnet 1541.6781 m².
```

154167.8 cm² **is** 15.4168 m². The export is correct and the tool reports it as
99 % wrong — a false export-quality finding, which §13 metric 4 sells as a
product. The feet fixture passes only because it declares areas in plain
`SQUARE_METRE`; both of its traps are about *length* units and are handled
correctly.

## 8. (B) The briefing tells the agent that a file with no geometry at all „trägt Geometrie"

`briefing.py:1476` emits, unconditionally, whenever the lazy geometry pass has
not yet run:

```
BLIND  Geometrie-Pass noch nicht gelaufen (nur Topologie gelesen) → … sie sind
       aber berechenbar, dieser Export trägt Geometrie
```

`haus-mit-raeumen.ifc`, `einheiten-fuss.ifc`, `geschossdecke-und-fenster.ifc`
and `strasse-ifc4x3.ifc` contain **no `Representation` on any product**.
Reproduce: `print(call('open_model', path=F+'einheiten-fuss.ifc')['briefing'])`.

This is a false capability claim in the one block whose whole job is to say what
the file cannot answer, and it is the opposite of the failure the docstring above
it says it was written to fix. It costs the agent a geometry pass and a turn, and
it propagates into the IDS summary („4 von 6 Befunden … Nicht ausdrückbar: …
Geometrie-Pass noch nicht gelaufen"). The honest test is cheap: does any
`IfcProduct` carry a `Representation`.

## 9. (B) A declared floor area that AGREES is reported as „nicht deklariert"

`envelope.triangulate` writes a caveat only on `disagree`. On `agree` the
answer is a bare `computed`, and `_provenance_line` prints:

```
gemessen (±0.15 m²): 15.42 m² — aus der Geometrie berechnet, nicht deklariert.
```

for the sample house's Bedroom — a file which declares
`BaseQuantities.NetFloorArea = 15.41678125` (`ifcopenshell.util.element.get_psets`
on `3w0zWKm7n8SB1qbfwUzt0J`). The sentence is simply untrue, and „declared and
agrees" is rendered identically to „not declared at all". §5 item 6 lists
triangulation agreement as one of the six things worth building; the renderer
throws away half of it, and §13 metric 4 cannot be observed from the answers.

## 10. (B) `storey_heights` renders declared elevations as „aus der Geometrie berechnet, nicht deklariert"

`briefing.storey_heights` returns `computed(...)` (`briefing.py:703`) for a value
whose `elevation` field is `IfcBuildingStorey.Elevation` read verbatim and whose
`height` is the difference of two such numbers. No geometry is touched (verified:
`model.geometry_seconds` stays 0.000 across the call — see §16 below).

```
gemessen: 2 Einträge (m) — aus der Geometrie berechnet, nicht deklariert.
- Ground Floor: Höhenlage 0.0, Geschoßhöhe 2.5
Hinweis: … gebildet aus den deklarierten Höhenlagen.
```

The provenance line and the caveat in the same answer contradict each other.

## 11. (B) `view` returns a plan captioned as a floor plan when nothing was drawn

`render.plan` returns `None` only when there is neither structure **nor** a room
(`render.py:318`). A storey with a room outline and zero structural elements
crossing the 1.2 m cut passes the guard and renders a page containing one filled
rectangle. `_image_blocks` never puts `elementsDrawn` in the caption.

```python
v = call('view', model=h, storey='Roof')   # sample house
# elementsDrawn: 0, rooms: ['Roof'], and a PNG showing a bare outline
```

The caption the model reads is „Grundriss „Roof", waagrechter Schnitt 3.70 m über
Null — auf dieser Höhe erscheinen Tür- und Fensteröffnungen als Lücken in der
Wand. Räume im Bild: Roof." An agent looking at that picture concludes the loft
has no walls and no windows. The module docstring says a blank page and a broken
renderer must not share a result; this is the third case, a *misleading* page,
and it shares a result with a correct one.

Related, same function: `view` on a model with no `IfcBuildingStorey` at all
(`strasse-ifc4x3.ifc`) raises `ToolError` with „kein Bauteil **dieses
Geschoßes** trägt Geometrie, oder der Geschoßname trifft nichts" — a statement
about a storey that does not exist. Agent-side it becomes „This is a problem with
the arguments … check the GlobalId with operation='find_elements'", and no
GlobalId was supplied.

## 12. (B) `room_inventory` raises a Python `KeyError` instead of a German refusal

`tools.py:916`: `inventory(resolve(...), str(args.get("kind") or ""))`.
`briefing.inventory` then does `GERMAN_KIND[kind]` with no validation.

```python
call('room_inventory', model=h)         # sample house
# KeyError: ''  — briefing.py:799
```

An invalid kind (`kind='wohnraum'`) raises the same way. `kind` is `required` in
the JSON Schema and `_build_call` validates it, so the NAT tool is safe — but
`ifc_spatial.tools` is documented as transport-free and `mcp_server.py` hands
arguments straight to `call()`, so any MCP client that omits the field gets a
traceback rather than the German refusal every other path produces. The early
`if not spaces` return is what masks this on the road and feet fixtures.

## 13. (B) Numbers are printed finer than their tolerance, systematically — and the flagship percentage carries no tolerance at all

`_decimals` is documented as „one digit finer than the band … ±0.01 m earns three
decimals, ±3° earns none, ±0.15 m² earns two". Measured:

```
_decimals(0.005) -> 4     # ±5 mm rendered to 0.1 mm     (50× finer)
_decimals(3)     -> 1     # ±3°  rendered to 0.1°        (30× finer, docstring says 0)
_decimals(0.15)  -> 2     # matches the docstring
```

The rule is only „one digit finer" for exact powers of ten.
`COORDINATE_TOLERANCE = TESSELLATION_TOLERANCE = 0.005` are the two most common
tolerances in the package, so most numbers are affected:

```
elevation:  gemessen (±0.005 m): bottom=0.9000, top=2.1100, heightAboveStorey=0.9000
azimuth:    gemessen (±3 °): degrees=0.0, compass=N
```

Separately and worse, `_render_answer`'s `lightEntryArea` branch replaces
`lines[0]` with its own sentence and **drops the tolerance entirely**:

```
gemessen: Lichteintrittsfläche 37.656 m² auf 51.99 m² Bodenfläche = **72.42 %**
          — aus der Geometrie berechnet, nicht deklariert.
```

The envelope carries `tolerance = 0.3765545 m²`. The bolded percentage is the
only number an OIB 3 daylight answer turns on; it is shown to 0.01 pp against a
band of roughly ±1.4 % relative (≈ ±1.0 pp here), with no ± anywhere on the line
and no `Bezug:` line. The `egressPath` branch drops its tolerance the same way.

## 14. (C) The `view` scale bar runs off the page for a small `only` selection

`_draw_scale_bar` steps down only to 1 m. Rendering a 30 mm curtain-wall mullion
alone gives ≈43 400 px/m, so the 1 m bar is drawn to x ≈ 43 450 on a 1 400 px
canvas and the „1 m" label lands off-image:

```python
call('view', model=h, storey='Ground Floor', only=['09J5N7xMHBfQZeQGAEMom0'])
```

The result is a page with an unlabelled full-width rule and a small square — the
picture carries no scale at all, which is the one thing the docstring says the
bar exists to prevent.

## 15. (C) A missing optional dependency is reported as an argument error

`shopping_list` raises a `ToolError` when `ifctester` is absent, which the agent
path turns into `_unrunnable_text`:

```
Error: Die IDS-Ausgabe steht in dieser Installation nicht zur Verfügung
(ifctester fehlt).. This is a problem with the arguments, not with the building —
check the GlobalId with operation='find_elements' and call again.
```

Double full stop, and advice that cannot help — the agent will retry. Note also
that `ifctester` **is** absent from the repo's own environment
(`uv run python -c "import ifctester"` → `ModuleNotFoundError`; it is present only
in the system Python the engine suite runs under, and `ifc_spatial` reaches the
agent venv through an untracked `.venv/lib/python3.11/site-packages/ifc-spatial-dev.pth`
rather than a declared dependency). Whether that is the deployment state I cannot
tell from here, but as configured in this tree the Phase-5 IDS export does not run
inside the agent.

## 16. (C) Unit and shape labelling in the composite payloads

`_provenance_line` appends `({unit})` to any non-scalar value, so a dict of
mixed quantities is stamped with one unit:

```
clearWidth:      width=1.810, height=1.210, area=2.190, rectangularity=1.000,
                 measuredOn=…, via=IfcOpeningElement, planeNormal=[0.000, 1.000, 0.000] (m)
orientedExtent:  … axisAligned=True, northKnown=True … (m)
```

`area` is m², `rectangularity` is dimensionless, `measuredOn`/`via` are strings
and two fields are booleans — all under „(m)".

Related: `MEASURES['roomDepth']` promises „bei einem Eckraum steht die zweitbeste
[Fassade] dabei". What the model reads is `candidates=2 Einträge` — the
runner-up is collapsed by `_value_text` and never shown.

---

# SUSPECTED (reasoned, not triggered on these fixtures)

- **`- {entry}` dict repr.** `_render_answer`'s final `else` branch prints a raw
  Python dict for a list entry with none of `ifcType` / `intrusionDepth` /
  `storey` / `confidence`. Confirmed with a hand-built payload
  (`_render('measure', {'decidable': True, 'provenance': 'computed',
  'tolerance': 0.01, 'value': [{'foo': 1}]})` → `- {'foo': 1}`). The 1 850-call
  sweep produced **no** real answer of that shape, so no shipped operator
  reaches it today; it is a trap for the next list-valued operator.
- **NaN / infinite tolerance.** `_decimals` returns `None` for NaN, ∞, 0 and
  negatives, and `_num(value, None)` falls back to `repr()` — so a computed value
  with a degenerate tolerance is printed at 17 digits under „gemessen (±nan m)".
  Reachable in principle (`tolerance = abs(area) * AREA_RELATIVE_TOLERANCE` is 0
  for a zero area); I could not make an operator produce it, because the two
  zero-area paths both take other branches.
- **`only` ignores the storey filter.** `render.plan` skips the own-storey test
  when `restricted` is set (`render.py:288`), so `only=[id]` + `storey='X'` will
  draw an element from storey Y and caption it „Grundriss X". I could not trigger
  it on the sample house because the only cross-storey candidate (the roof) does
  not cross the 1.2 m cut, and the call raises instead.
- **`door_graph` clique for a door touching 3+ spaces.** A door resolved to
  rooms {A,B,C} produces edges A–B, A–C **and** B–C, so a room that only brushed
  the door at the 0.05 m contact tolerance gains a walkable connection. The
  `ambiguous` flag is set and named in the caveat, but `egress_path` routes over
  those edges regardless. No fixture produces a 3-space door.
- **Opaque `IfcPlate` counted as Lichteintrittsfläche.** `light_entry_area`'s
  `GLAZING` tuple admits every `IfcPlate` bounding the room with no glazing test.
  A curtain wall with opaque spandrel panels (`IsExternal = True`) would have
  them summed as light entry area. All six panels in the sample house are
  genuinely glazed, so I could not reproduce it without authoring a fixture.

---

# WHAT I TRIED TO BREAK AND COULD NOT

These held up under deliberate attack and are worth stating as coverage:

- **`clear_width`'s exactness claim.** The AABB pre-filter, the ascending sort
  and the break in `_soup_distance` never skipped the true minimum: 400 random
  triangle-soup pairs (3–25 triangles each, including near-parallel thin plates
  at 1e-3 thickness and interpenetrating cases) matched an all-pairs brute force
  with **worst relative error 0.0**. The 15-test kernel itself was checked
  independently against a 60×60 barycentric sampling of both triangles on 300
  random pairs: the exact answer never exceeded the sampled minimum (worst
  `exact − sampled` = 0.0). The claim in the docstring is true.
- **`clear_opening_width` against the type-name oracle.**
  `Windows_Sgl_Plain:1810x1210mm` → `width=1.810, height=1.210, area=2.190`;
  `Doors_IntSgl:810x2110mm` → `0.810 × 2.110`. Exact to the millimetre, and
  `_clear_opening_area` agrees with it to 4 decimals.
- **The north arrow and `azimuth`.** With `TrueNorth` patched to
  `(sin 30°, cos 30°)` the arrow tilts 30° clockwise from vertical (correct, since
  `to_px` flips Y) and the north-facing wall's azimuth becomes `330.0° / NNW` —
  correct in both sign and compass name. With no `TrueNorth`, `azimuth` refuses
  and `_image_blocks` states the absence rather than drawing an arrow.
- **Malformed input.** A truncated file, a header-only file and a non-IFC file
  all produce specific German refusals through `ToolError`, naming the actual
  cause (missing `END-ISO-10303-21;`, unparseable SPF header, wrong magic). No
  traceback reaches the caller.
- **Nothing runs geometry behind the caller's back.** Instrumented
  `model.geometry_seconds` / `tree_seconds` / `contact_seconds` after
  `open_model`, `briefing`, `find_elements`, `element`, `storey_heights` and all
  seven non-geometric relations: **all still 0.000**. The `above`/`below`
  regression §12b records has not come back, and `element`'s relation menu
  correctly skips `GEOMETRIC_RELATIONS`.
- **`egress_path` hedging.** The `Roof` loft, which has no door edge, returns
  `decidable: false` with a remedy naming both possible causes — not „das Gebäude
  hat keinen Ausgang". Windows are correctly not edges (the bedroom gets its real
  15.49 m route, not a 1.93 m one through its window), the external door is found
  through `_faces_outside`, and the polyline caveat is long, explicit and always
  attached. This operator is the best-behaved thing in the change.
- **The IDS export applies no thresholds.** Every one of the 10 specifications
  generated for the sample house asserts only `cardinality="required"` on a
  property's existence; no `minInclusive`, no enumerated value, no bound. The two
  non-exportable findings are listed with a reason instead of being silently
  dropped. Invariant 3 holds here.
- **Length-unit resolution in `einheiten-fuss.ifc`.** Both traps (the stray
  unassigned `DECI METRE` and the SI metre a foot is defined against) are
  answered correctly: `unit_scale = 0.3048`. Only the *area*-prefix case (finding
  7) is wrong.
- **The German prose generally.** Fuzzing `_render` with missing keys, `None`
  values, empty lists, NaN and infinities produced no traceback in any branch —
  it degrades to „—" or „None" rather than crashing. The only structured-output
  leak is the unreachable dict repr above.
