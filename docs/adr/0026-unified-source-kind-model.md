# ADR-0026: Unified source-kind model for citations, Herleitung, and reports

- **Status:** Accepted
- **Date:** 2026-07-18
- **Deciders:** GRID engineering
- **Related:** ADR-0012 (cards as rich UI layer), ADR-0020 (Dragonfly shared cache), ADR-0024 (org-wide document Archiv), ADR-0025 (norm registry), `docs/superpowers/specs/2026-07-18-herleitung-source-hero-design.md`, `docs/design/click-dummy-overhaul-spec.md`

## Context

Sources reach the UI through **four+ pathways** (shallow `verified_sources` over
WS, deep-research SSE citations, `legal_basis` cards, and the knowledge-layer
`## Trace-Lanes` block) that feed **two disjoint chip systems** (the "Belegt
durch" row and the "Herleitung" source-hero cards) using **three different
taxonomies**:

- `AnswerSourceKind` — `kb | ris | web`
- `SourceSignal` — `law | project | office | auto`
- lane stratum-keys — `baurecht_oib | baurecht_ris | projekt | buero | web | …`

The mappings between them are lossy and *disagree*: the "Belegt durch" row maps
a knowledge-base hit to the `project` tint, while Herleitung maps the same hit
to `law`. The OIB corpus — authoritative building law — is routinely mislabeled
as project or web material (`norm_registry.lane_for_hit` fail-open to `web`,
`source_lane`'s legacy `projekt` fallback), whereas RIS is robustly identified
by host/tool-name at every layer. Some citations produce no chip at all, and the
"Belegt durch" chips are dropped on local-storage prune while the Herleitung
cards survive — so chips disappear on reload. The click-dummy
(`Ask_Piloti_v6_standalone2.html`) specifies the opposite: **one `threadSources`
list, one chip style, one detail popover**, driven by a single source-kind
registry (`TYPES = { auto, baurecht, buero, projekt }`).

## Decision

We will introduce **one canonical, coarse source-kind taxonomy** that every
surface renders through, and treat the existing fine lane classification as a
*sub-label within a kind* rather than a competing taxonomy.

The coarse kinds (mirroring the click-dummy `TYPES`) are:

| kind | covers |
|------|--------|
| `baurecht` | OIB Richtlinien corpus **and** RIS (Bauordnung, Verordnungen, Bundes-/Landesrecht) **and** external Normen |
| `buero` | Büroarchiv (org standards/details/experience) |
| `projekt` | Projektwissen (this project's plans, Bescheide, uploads) |
| `web` | web-search results |

(`auto` is a source-*selection* mode in the UI, never a rendered citation, so it
is not part of the citation taxonomy.)

- The taxonomy lives in **`src/aiq_agent/common/source_kinds.py`** (backend) and
  a mirror **`frontends/ui/src/features/chat/lib/source-kinds.ts`** (frontend).
  The backend owns keys + German labels + a `css_token`; presentation colours
  live in frontend CSS custom properties (`var(--source-{css_token})`), so both
  ends share one source of truth without shipping colours from the backend.
- The fine lane classifier (`norm_registry.lane_for_hit`, with its
  `_RANK_LANES` / `_OIB_CLASS_LANES` tables) is **kept and reused** — it maps up
  to a coarse kind via `kind_for_lane()` (prefix match on the lane family, so
  any new `baurecht_*` sub-lane is forward-compatible). Crucially, the OIB
  corpus and RIS both resolve to `baurecht`.
- `source_entry_to_wire()` stamps the coarse **`kind`** plus the fine `lane` /
  `lane_label` onto the citation wire. Every source origin normalizes into the
  same `SourceEntry` list, so the frontend renders one `CitationSource[]` per
  message — no per-surface re-classification.

## Consequences

### Positive

- One taxonomy, one chip pathway: the OIB corpus and RIS get identical
  first-class treatment; every source becomes a chip.
- The rich, deterministic hierarchy (OIB-Richtlinie vs. Bundesrecht vs.
  Verordnung …) is preserved as a sub-label, not discarded.
- Adding a source kind is a one-line registry entry plus its CSS token — a
  factory-style extension point.

### Negative

- The wire grows three fields (`kind`, `lane`, `lane_label`); old persisted
  messages lack them and must render via a back-compat default.

### Risks

- A lane family not covered by `_LANE_KIND_PREFIXES` fails open to `web`.
  Mitigated by keeping the prefix table in sync with `norm_registry` and by
  tests asserting every lane family maps to the intended kind
  (`tests/aiq_agent/common/test_source_kinds.py`).

## Alternatives Considered

- **Collapse to the fine lanes only** (drop the coarse layer) — rejected: the
  chips need a small, stable colour taxonomy; ~a dozen lanes is too many tints
  and churns whenever a sub-lane is added.
- **Physically merge the corpus and RIS into one store** so there is literally
  one source — rejected (see ADR-0025): the Chroma corpus (semantic OIB PDF
  retrieval) and the RIS pointer registry (authoritative live law) have
  different retrieval semantics; we unify the *model and doctrine*, not storage.

## Open Questions / Follow-ups

Rollout is phased on `claude/citation-source-system-redesign-g8ni16`:

1. Backend taxonomy + wire `kind` (**this ADR**).
2. Frontend: collapse the three taxonomies onto the wire `kind`; one chip
   component; fix the storage-prune asymmetry so chips survive reload.
3. Herleitung rebuilt to the click-dummy nodes over the same source set.
4. RIS Redis caching (ADR-0020 reuse) + stop re-patching sources every turn.

## References

- Click-dummy: `Ask_Piloti_v6_standalone2.html` (`TYPES`, `threadSources`, `Belegt durch`).
- `docs/superpowers/specs/2026-07-18-herleitung-source-hero-design.md`
- ADR-0025 (norm registry), ADR-0024 (Archiv), ADR-0020 (Dragonfly cache).
