# Measuring a building from its drawings

*Written 2026-08-19. Companion to [oib-geometry-coverage.md](./oib-geometry-coverage.md),
which maps what we can measure when an IFC model exists. This one is about the case
where it does not.*

**Goal:** given a 2D plan and one known length, return any other real-world dimension
on that plan **with its uncertainty**, so a Bestimmung can be judged against it or
explicitly declared undecidable.

**Why now:** `ifc_spatial` answers OIB questions well and only for submissions that
ship a model. Most do not. A plan-measurement path extends the same operators to the
documents we actually receive, and the research note found the tooling for it is more
mature than expected.

---

## The rule this plan inherits

`oib-geometry-coverage.md` states it for the model path and it applies unchanged
here: **this engine measures, the Bestimmung judges.** No operator below returns a
threshold or a verdict.

This plan adds one clause to it, forced by the physics of measuring from an image:

> **A number without its tolerance is a different number wearing an exact one's
> clothes.** Every measurement crossing this boundary carries an interval and a
> provenance, and the judge must be able to answer *nicht entscheidbar*.

This is not a new position for this codebase — `render.py` already holds it, and holds
it harder than this plan does: *"Every dimension in this package is available from an
operator that states its own tolerance; a pixel measured off a raster states nothing."*
The model path could afford that absolutism because it always had exact geometry to
fall back on. The plan path cannot: sometimes a pixel is all there is. So the rule
softens by exactly one notch — a pixel may state something, **provided it states its
tolerance too** — and everything in Phase 2 exists to keep that promise honest.

That third verdict is the deliverable. Measuring is a solved problem with existing
tools; carrying the uncertainty to the verdict is not, and nothing surveyed does it.

---

## The decision everything below branches on

Measurement error is dominated by whether the drawing's geometry is **read** or
**estimated**. Computed error budget, measuring a 1.20 m stair Nutzbreite:

| source | calibration | resolution | ± on 1.20 m | can it decide a 10 mm margin? |
|---|---|---|---|---|
| vector PDF, exact coordinates | 20 m reference | n/a | **±1.5 mm** | yes |
| raster, 600 dpi | 20 m reference | 236 px/m | ±9.0 mm | no |
| raster, 300 dpi | 20 m reference | 118 px/m | ±18.0 mm | no |
| raster, 150 dpi | 20 m reference | 59 px/m | ±36.0 mm | no |

*Model: `σ_rel = √[(√2·ε/L_ref)² + (√2·ε/M)²]`, ε = 1.5 px endpoint localisation.
Full derivation in the research note.*

**No raster configuration can decide a 10 mm margin.** That is not a tuning problem;
it is the resolution of the image. So the vector path is the product and the raster
path is a degraded mode that must announce itself.

OpenTakeoff (Apache-2.0, 40 MCP tools, metric-native, refuses unscaled sheets) is the
obvious engine to borrow. But its stated coordinate frame is *"image pixels at render
scale 2.0 — PDF points × 2"*, which is a **rasterised frame at ~144 dpi effective**.
If that frame is quantised, it lands on the 150 dpi row above and cannot serve
compliance dimensions. If those are floats, it is fine.

Nobody knows which. That is Phase 0, and no code is written until it answers.

---

## Phase 0 — The gate (≈1 day)

**Exit criterion:** a measured number for OpenTakeoff's achievable precision on a
metric plan, against ground truth we control.

### Task 0.1 — Build a ground-truth plan from a model we already own

Round-tripping our own IFC is what makes the truth exact by construction, and we are
unusually placed to do it because we own both halves.

- [ ] Pick an IFC fixture from `packages/ifc-spatial-py/tests/` with a known stair or corridor
- [ ] Record the true span via the existing engine: `ifc_spatial.clearance.clear_width`
      (`clearance.py:419`) — this is the ground truth, exact from geometry
- [ ] Draw the storey as **SVG** via `tools.draw` (`ifcopenshell.draw`), then SVG → PDF.
      **Not `render.plan`** — that one rasterises with Pillow on purpose, and its own
      docstring is explicit that it *"is not a source of numbers […] a pixel measured off
      a raster states nothing."* Measuring it would test the raster path while pretending
      to test the vector one.
- [ ] Record a long known reference on the same sheet (a building edge ≥ 10 m) from the model

### Task 0.2 — Measure it through OpenTakeoff and count the decimals

- [ ] `npx -y opentakeoff-mcp` over stdio; no repo changes yet
- [ ] `load_plan` → `set_scale` using the known reference → `measure_line` on the stair
- [ ] Record: returned value, **number of significant decimals**, delta vs the IFC truth
- [ ] Repeat at 1:50 and 1:200 — error should scale linearly with plan scale if the
      frame is quantised, and stay flat if it is not. **That is the discriminator.**

### The branch

| result | reading | branch |
|---|---|---|
| delta ≲ 3 mm, sub-unit decimals, flat across scales | coordinates are floats | **A — wrap it** |
| delta ≈ 15–20 mm at 1:100, scaling with plan scale | quantised to the render grid | **B — read vectors ourselves** |

Branch B is not a failure and not much more work: `pdfplumber` already extracts exact
path coordinates (verified against 20 PDFs in `data/oib/` — 2 to 7 decimal places), and
we keep OpenTakeoff for the things it is genuinely better at (room detection, areas,
marked-up PDF export) where 1–2 % is fine.

---

## Phase 1 — The measurement service

Shape mirrors `ifc_spatial` deliberately: a Python package with an operator library, a
thin MCP surface over it, and a client in the agent. A reviewer who knows one knows
the other.

### Task 1.1 — `packages/plan-measure-py/`

- [ ] `scale.py` — calibration. Least-squares over **all** known dimensions on the
      sheet, not one. Refuses a reference under 5 m with the reason, because the
      research shows a short baseline poisons every later measurement.
- [ ] `geometry.py` — Branch A: adapter over `opentakeoff-mcp`. Branch B: `pdfplumber`
      path extraction + `shapely`. Same signature either way, so Phase 2 is unaffected.
- [ ] `dimensions.py` — **read printed dimension strings before measuring anything.**
      If the draughtsman wrote "1,20" against the span, that is the answer and it beats
      any derived number. This is the highest-leverage part of the whole plan and the
      cheapest.
- [ ] `uncertainty.py` — the error model above, as code. Every operator returns
      `Measurement(value, interval, provenance, method)`.

### Task 1.2 — Provenance is a closed set, not a string

```python
Provenance = Literal[
    "dimension_string",   # read off the drawing; the draughtsman's own number
    "vector_exact",       # PDF path coordinates
    "raster_estimated",   # rendered or scanned; carries a real interval
]
```

- [ ] It is never dropped, defaulted, or inferred downstream. A `Measurement` without
      provenance must fail to construct.

### Task 1.3 — MCP surface

- [ ] `packages/plan-measure-py/src/plan_measure/mcp_server.py`, following
      `ifc_spatial/mcp_server.py` exactly
- [ ] Tools: `load_sheet`, `calibrate`, `measure_span`, `measure_area`, `list_dimension_strings`
- [ ] Mirror `ifc_spatial`'s test that no operator is implemented, tested and reachable
      from nothing (`test_no_operator_is_implemented_tested_and_reachable_from_nothing`)

### Task 1.4 — Refusals, and what they say

- [ ] No scale note and no reference → refuse, name what is missing
- [ ] Scale notes disagree across sheets → refuse, name both
- [ ] Sheet marked NTS → refuse
- [ ] **Photograph rather than scan → refuse by default.** Perspective adds a homography
      whose practical accuracy needs more than four control points at centimetre
      precision, on top of a raster budget that already cannot resolve 10 mm. Message
      says why and asks for the PDF.

---

## Phase 2 — The interval reaches the verdict

The part nobody has built, and the reason this is worth doing ourselves.

### Task 2.1 — Three-valued compliance

- [ ] `erfüllt` — the whole interval clears the threshold
- [ ] `nicht erfüllt` — the whole interval fails it
- [ ] `nicht entscheidbar bei dieser Auflösung` — **the interval straddles it**

The third case reports the measured interval, the threshold, its clause, and what would
resolve it (a dimensioned drawing, a higher-resolution scan, or the model). That is a
useful answer, not a failure, and it is the one the market's tools cannot produce.

### Task 2.2 — Wire into the existing agent path

- [ ] `src/aiq_agent/knowledge/plan_measure_client.py`, following
      `ifc_spatial_client.py` — same presigned-source pattern, same cache-on-source-identity,
      **widens no scope**
- [ ] The Bestimmung still comes from the knowledge base and is bound at point of use.
      No threshold is hardcoded here. Same rule as the model path.

### Task 2.3 — The agent must not launder the interval

- [ ] Grounding block renders `1.19–1.23 m (raster, ±18 mm)`, never `1.21 m`
- [ ] Test that a `Measurement` with `raster_estimated` provenance cannot reach an
      `erfüllt` verdict against a threshold inside its own interval

---

## Phase 3 — UI

- [ ] Sheet viewer with the calibration step visible — the user confirms the reference,
      as OpenTakeoff does, because a silently-wrong scale is every number on the sheet wrong
- [ ] Measurements render with their interval; `nicht entscheidbar` gets its own state,
      styled as information rather than error
- [ ] Dev preview + light/dark screenshots per `visual/registry.mjs`, as with every new component

---

## Deliberately not doing

| not doing | why |
|---|---|
| Training a wall-segmentation model | CubiCasa5K-class models are scored on recognition, not millimetres. A model that finds 95 % of walls says nothing about whether the wall is within 10 mm. |
| Asking a VLM for the dimension | MeasureBench: 30.9 % value accuracy at 95.7 % unit accuracy for the best frontier model. Right units, wrong number, stated confidently — worse than refusing. |
| Full raster→BIM reconstruction | A different product. We need one span at a time, with its tolerance. |
| Accepting phone photos | See Task 1.4. |

VLMs still do the jobs adjacent to measuring — which sheet is the ground-floor plan,
where the stair is, which string is the scale note. Classification and localisation,
where approximately right is fine. **The number never passes through a language model.**

---

## How we will know it worked

Not by tests passing. By these, in order:

1. **Phase 0 delta** — measured mm against IFC truth. Everything else is unfounded until this exists.
2. **Round-trip on ≥ 10 models** — export plan, measure, compare to the model. This is a
   real accuracy figure for our pipeline on our documents, not an error model.
3. **Vector share of real submissions** — take 50 actual plan PDFs and count how many yield
   usable vector linework. If it is 80 %, we are nearly done; if 30 %, the raster mode is
   the product and the scope is different. **Unmeasured, and it is the biggest open number
   in this plan** — there are no plan PDFs in the repo, only the Richtlinien.
4. **Dimension-string hit rate** — how often the span a Bestimmung needs is already
   printed on the drawing. If it is high, Task 1.3 is most of the value and the rest is
   a fallback.

Items 3 and 4 need documents we do not have. They should be measured before Phase 1,
not after, because either could change what gets built.
