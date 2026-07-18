# Country extensibility — the CountryProfile contract and the add-a-country checklist

Status: Active (2026-07-18). Companion to ADR-0025 v2 and `backend-deep-dive.md` §6b.

Piloti ships Austria-first, but the product goal is multi-jurisdiction. This
document is the honest map of what that takes: the binding contract that already
exists (`src/aiq_agent/common/country_profile.py`, Austria = implementation #1),
and the complete inventory of remaining Austria/German couplings a second
country must address — so "add Germany" is a checklist, not archaeology.

## The contract

`CountryProfile` — design rule: **every field has a named live consumer; adding
a field without wiring its consumer in the same change is forbidden** (this is
what kept the previous country abstraction honest-free and got it deleted).

| Field | Kind | Consumer today |
|---|---|---|
| `states` / `state_probe_order` | data (registry-overridable) | jurisdiction resolution (`extract_bundesland`/`resolve_bundesland`) |
| `language` | data | classification/prompt language (consumer grows with i18n work below) |
| `doctrine` | data | `{{ norm_doctrine }}` in researcher/planner/writer prompts |
| `corpus_collection` | data | retrieval base-collection routing; admin store |
| `corpus_note` | data | catalog prompt block corpus section |
| `parcel_tags` | data | `parcel_note` per-parcel source-of-truth signal |
| `legal_source_tools` | data | prompt/doc references to the country's legal-DB tools |
| `applicability` | code hook | compliance Stage-1 scoping + prompt applicability section |
| `corpus_doc_class` | code hook | `lane_for_hit` display tagging |

Data fields default from AT code constants and are overridable per country in
`configs/norms/<cc>/registry.yml` (admin-editable via the platform norms
store). **One collection per country** is the corpus rule: membership in the
country's base collection *is* the country tag — org/project/session
collections stay country-agnostic; the project's country selects which base
collection joins its retrieval scope.

## Adding a country: the checklist

Phase 1 — data + corpus (days):
1. `configs/norms/<cc>/registry.yml`: catalog entries (verified pointers into
   the country's legal database), `states`, `doctrine`, `corpus_note`,
   `parcel_tags`, `language`, `corpus_collection`.
2. Create the corpus collection and upload the country's norm texts
   (platform Base-Knowledge surface).
3. Register the `CountryProfile` instance (one function in
   `country_profile.py`) with its two code hooks.

Phase 2 — the one real code artifact (weeks):
4. A source adapter for the country's legal database (Germany:
   gesetze-im-internet + Länder portals), following `sources/ris_adapter` as
   the template — tools, planner prompt, URL predicates all live inside the
   adapter package. Note: the adapter's state-filter vocabulary must consume
   the profile's `states`, not re-declare it (RIS adapter currently
   re-declares — see Known duplications).

Phase 3 — vocabulary and language surfaces (scoped per country):
5. Document classification: `document_classification.py` tag vocabulary +
   German prompt ("österreichisches Architekturbüro") need per-country
   vocabulary/prompt variants keyed off `language`.
6. Intake facts: `intake-definition.ts` carries AT-specific vocabularies
   (bundesland options, `gebaeudeklasse` GK1–5, `fluchtniveau` >22m bands,
   `widmung` options, the four AT boolean triggers) — country #2 needs its own
   question set; the intake machinery itself is versioned and generic.
7. Compliance checker: `RICHTLINIE_NAMES`/1–6 scope, the two German prompts,
   and the German report renderer are OIB/AT-specific — a per-country
   requirement taxonomy + renderer behind the profile's applicability hook.
8. Agent identity prompts: the j2 prompts hardcode "Austrian building
   regulations / RIS / OIB" framing — template off the profile
   (`country_name`, `legal_source_tools`) when country #2 ships.
9. Request envelope: `GridRequestContext.bundesland` is AT-vocabulary; add a
   `country` envelope field alongside it (the structured `country=<cc>` prompt
   fact is already parsed by `resolve_country`).

## Known duplications (consolidate opportunistically, never let them drift)

- **9-state vocabulary — 4 copies:** `norm_registry.BUNDESLAND_TOKENS` (source
  of truth), `project_context._BUNDESLAND_TOKENS` (deliberate mirror, import
  cycle), `ris_adapter._BUNDESLAND_PARAMS` (RIS filter keys), and
  `intake-definition.ts` options. A parity test pinning the Python copies to
  `norm_registry` is the cheap guard.
- **`oib_knowledge` default — 6 sites:** NormsFile default, AT profile, three
  config YAMLs (`COLLECTION_NAME` fallback), and `collection-scope.ts`. The
  profile is the intended single source; config/env remain deploy-time
  overrides.

## What deliberately stays Austria-scoped

The RIS adapter package (client, planner, application enums) — that *is*
Austria's legal-database implementation, correctly isolated. Universal
mechanisms confirmed country-agnostic by inventory: collection layering &
merging, scoping headers, the request-envelope machinery, the classification
and compliance pipelines (mechanism, not vocabulary), "answer in the user's
language" prompt rules.
