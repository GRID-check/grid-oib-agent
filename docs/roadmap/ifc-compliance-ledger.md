# The Prüfbuch — from "a model you can ask" to "a building that is checked"

Status: **proposed**. Supersedes nothing; extends ADR-0044.

## The gap

Two halves of this product have never actually touched.

One half knows the rules: the OIB corpus, the applicability engine
(`src/aiq_agent/common/applicability.py` — which Richtlinien apply to *this*
project, from its facts), the retrieval that answers "was verlangt OIB 4 für
Treppen".

The other half knows the building: `bim_elements`, with every element's merged
property sets and published quantities, versioned across revisions, queryable.

Today a human joins them, one question at a time. The architect asks "welche
Wände haben keine Feuerwiderstandsklasse", gets an answer, and the answer
evaporates. Nothing accumulates. Nothing is re-checked when the model changes.
Nothing can be signed.

**The Prüfbuch is that join, made persistent and versioned.**

## What it is

For a project, a set of requirement rows. Each row:

| field | meaning |
|---|---|
| rule | `oib4-treppe-steigungsverhaeltnis`, with its Richtlinie and clause |
| status | `erfüllt` · `nicht erfüllt` · **`nicht entscheidbar`** · `manuell bestätigt` |
| elements | the GlobalIds it was decided on — each a deep link into the viewer |
| revision | the model revision the verdict was computed against |
| reading | the actual values read, and the threshold applied |
| confirmation | who signed off manually, when, and why |

Four properties make this worth building rather than being a report generator:

**1. `nicht entscheidbar` is a first-class state, and it is the most useful one.**
Not a gap in the report — the product's integrity, and simultaneously the
architect's to-do list. "34 tragende Wände führen kein `Pset_WallCommon.FireRating`"
is not a failure to check; it is precisely the instruction for what to fill in
in Revit, and it is worth more than a green tick.

**2. It turns the revision timeline into a regression suite.** Re-run on Rev.4,
diff the statuses: *"3 Anforderungen haben sich geändert — Treppe Ost erfüllt
das Steigungsverhältnis nicht mehr."* Nobody gets that answer today, from any
tool, at any price a small office would pay.

**3. It is the deliverable.** An architect signs a Bestätigung. Today they
assemble it by hand from memory and marked-up plans. A ledger that says "47
Anforderungen: 31 maschinell gegen Rev.3 geprüft, 9 von Ihnen bestätigt, 7 aus
dem Modell nicht entscheidbar (Liste anbei)" is the artefact, with every figure
traceable to the element it came from.

**4. It is the spine everything else hangs off.** The Einreichung annexes, the
Verbesserungsauftrag responses, the Bauherr status page, the BCF export — all of
them are views over the ledger rather than separate features.

## What is actually decidable, honestly

`bim_elements` holds properties, quantities, materials, classifications and
storey containment. It holds **no geometry**: no coordinates, no solids, no
opening graph, no space boundaries. That is the line, and the rule catalog must
respect it rather than pretend.

**Decidable today**, from published values alone:

| Rule | Reads |
|---|---|
| Treppen-Steigungsverhältnis (OIB 4) | `RiserHeight`, `TreadLength` — a pure formula on two published numbers |
| Lichte Durchgangsbreite Türen (OIB 4) | `Qto_DoorBaseQuantities.Width` |
| Raumhöhe Aufenthaltsräume (OIB 3) | `Qto_SpaceBaseQuantities.Height` / `FinishCeilingHeight` |
| Feuerwiderstand tragender Bauteile (OIB 2) | `Pset_*Common.FireRating` vs the Gebäudeklasse minimum |
| U-Werte Hüllbauteile (OIB 6) | `Pset_*Common.ThermalTransmittance` |
| Schalldämmung Trennbauteile (OIB 5) | `Pset_*Common.AcousticRating` |

That list is deliberately unglamorous. It is also exactly the material a
Verbesserungsauftrag is made of.

**Not decidable, and the product must say so rather than approximate:**

- **Fluchtweglängen** — needs geometry and a traversal graph.
- **Geländerhöhen** — needs geometry.
- **Belichtung (Fensterfläche je Aufenthaltsraum)** — needs the window↔space
  relation, which is not extracted. A per-storey ratio is computable as a
  *screening indicator* and must be labelled as one, never as the Nachweis.
- **Brandabschnittsgrößen** — needs compartment topology.

## The rule catalog shows its work

Every verdict renders the threshold it applied and the clause it came from:
*"2h + b = 63 cm — Schwellwert 59–65 cm (OIB 4, Punkt 2.2)"*. The architect
checks the rule, not just the result. A tool that asserts "erfüllt" without
showing the number it compared is asking to be trusted; one that shows both is
asking to be checked, which is the only defensible posture for a product whose
output ends up in a submission.

The whole ledger carries the same framing the applicability engine already uses:
**orientation, not legal advice.**

## Sequence

1. ~~**`lib/bim/rules.ts`** — the declarative catalog and the pure three-state
   evaluator.~~ **Done.**
2. ~~**`compliance` query op**~~ **Done**, over the full element set, with the
   model's declared length unit rather than a magnitude guess.
3. ~~**The Prüfbuch tab**~~ **Done** — `?tab=compliance` on the model page:
   per-rule verdicts with their thresholds, deep links that highlight the
   failing elements, the missing-property list, and the rules that stood down
   with their reason. Reachable by the agent too (`ifc_query operation=compliance`).
4. ~~**Status regression across revisions**~~ **Done** as an on-demand diff
   (`compliance-diff`): `resolved` / `broken` / `decidable` / `undecidable` /
   `moved`, regressions first. Not yet persisted, so it is computed per request.
5. **Persist** — `bim_checks` keyed by (project, rule, model revision), plus
   manual confirmations, so the ledger accumulates rather than being recomputed,
   and a signature has something durable to point at. **Next.**
6. **Export** — the ledger as a dossier; BCF for the undecidable and failing
   items so they open as issues in ArchiCAD or Revit.

## Deliberately not doing

- **Geometric checks.** Not without a server-side kernel, and that is a
  different product decision, not a feature.
- **Auto-writing the project brief from derived facts.** Already settled:
  proposals through the confirm-the-patch card (ADR-0030).
- **A conformance certificate.** This is not IDS, not buildingSMART
  certification, and must never be presented as either.
