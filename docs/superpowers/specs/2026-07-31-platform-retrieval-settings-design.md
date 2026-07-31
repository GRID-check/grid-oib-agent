# Platform-configurable retrieval settings — design

Date: 2026-07-31
Status: approved (user reviewed decisions interactively; AFK for the rest)
Branch: `feature/platform-retrieval-settings` (worktree)

## Problem

Every retrieval path fetches a **fixed number of chunks per collection** and merges
down to a **fixed total maximum**. The values are build-time YAML
(`configs/config_oib_openrouter.yml`) or hard-coded Python constants, so tuning
recall/context-size trade-offs requires a code change and redeploy. The platform
owner wants to tune them live from the Platform admin view.

## Decisions (confirmed with user)

- **Scope: all retrieval counts** — knowledge search, document surfacing, web
  search, RIS search/catalog. Not just `top_k`.
- **Platform-only.** No org-level override layer. Organization → Models-style
  tenancy is out of scope.
- **Live, TTL-cached pull from the BFF** (the `/api/internal/model-overrides`
  fallback channel pattern), fail-open to the YAML/code defaults. No new
  `X-Grid-*` request header — the values are global, not per-request.
- **Approach A**: dedicated key-value drizzle table mirroring
  `platform_model_defaults` + a new Platform → Retrieval admin page + a
  token-guarded internal endpoint + a backend resolver consulted per call.

Explicitly out of scope: the REST document-search endpoint (`POST
/v1/collections/{name}/search` — caller-supplied `top_k`), per-chunk character
truncation (`_CHUNK_TRUNCATE_CHARS`), embedding cache sizes, reranker
multipliers, the `ris_fetch_tool.max_chars` budget, `MIN_SURFACE_SCORE`.

## Settings catalog

Flat keys, grouped by surface in the UI. Each row is optional: **absent row =
fall back to the build-time default** (YAML or code constant), so a fresh
deployment behaves exactly as today.

| Key | Today (default source) | Default | Bounds |
|---|---|---|---|
| `knowledge.top_k` | YAML `top_k: 16` | 16 | 1–50 |
| `knowledge.max_chunks_per_document` | YAML `max_chunks_per_document: 5` | 5 | 0–10 |
| `surface.chunk_top_k` | `_CHUNK_TOP_K = 40` | 40 | 1–100 |
| `surface.max_files` | `MAX_SURFACED_FILES = 12` | 12 | 1–30 |
| `web.max_results` | YAML `web_search_tool.max_results: 8` | 8 | 1–10 |
| `web.advanced_max_results` | YAML `advanced_web_search_tool.max_results: 4` | 4 | 1–10 |
| `ris.max_results` | YAML `ris_search_tool.max_results: 20` | 20 | 1–50 |
| `ris.page_size` | YAML `ris_search_tool.page_size: 20` | 20 | 10–100, only {10, 20, 50, 100} |
| `ris_catalog.max_matches` | YAML `ris_catalog_lookup_tool.max_matches: 8` | 8 | 1–20 |

The catalog (key, label, description, default, bounds, group) is defined once in
`frontends/ui/src/lib/retrieval-settings/catalog.ts` and drives the zod schema,
the admin form, and the internal endpoint response shape — same
single-source-of-truth doctrine as `authz/catalog.ts`.

## Architecture

```
┌──────────────────────────── BFF (Next.js) ────────────────────────────┐
│ Platform → Retrieval page                                             │
│   GET/PUT /api/platform/retrieval-settings  (platformApiRoute)        │
│     → lib/retrieval-settings/service.ts (validation, audit, cache)    │
│     → lib/retrieval-settings/repository.ts (drizzle)                  │
│   platform_retrieval_settings table (key PK, value int, meta)         │
│                                                                       │
│   GET /api/internal/retrieval-settings  (internalApiRoute, token)     │
└───────────────────────────────▲───────────────────────────────────────┘
                                 │ httpx GET, x-grid-internal-token,
                                 │ 60s TTL cache, fail-open {}
┌─────────────────────────── aiq-agent (Python) ────────────────────────┐
│ aiq_agent/common/retrieval_settings.py                                │
│   get_retrieval_setting(key, fallback) -> int                         │
│     consulted per call by:                                            │
│     · sources/knowledge_layer/src/register.py (knowledge_search)      │
│     · src/aiq_agent/cards/surface_documents.py                        │
│     · sources/tavily_web_search/src/register.py                       │
│     · sources/ris_adapter/src/register.py (3 tools)                   │
└───────────────────────────────────────────────────────────────────────┘
```

## Data model

`frontends/ui/drizzle/0029_platform_retrieval_settings.sql` (+ `.down.sql`):

```sql
CREATE TABLE platform_retrieval_settings (
  key        text PRIMARY KEY,
  value      integer NOT NULL,
  note       text,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

Whole-set upsert in one transaction on save (mirror
`savePlatformModelDefaults`), Redis/in-process cache invalidated on write
(ADR-0020 `lib/cache`).

## BFF API

- `GET /api/platform/retrieval-settings` → `{ settings: Record<key, number|null>, meta }` —
  `null` means "inherit build-time default". `platformApiRoute` + platform-owner
  permission from the authz catalog.
- `PUT /api/platform/retrieval-settings` → zod-validated partial map; values
  outside the catalog bounds (or outside a key's discrete `allowedValues`) are
  rejected, not clamped; audit event `platform.retrieval_settings.updated`
  (registered in `lib/audit/schemas.mjs`).
- `GET /api/internal/retrieval-settings` → `{ settings: Record<key, number> }`
  with only rows present in the DB; token-guarded via `internalApiRoute` like
  `internal/model-overrides`.

## Backend resolver

`src/aiq_agent/common/retrieval_settings.py`, modeled on
`model_overrides.py:_fetch_org_config`:

- module-level TTL cache (60s), `httpx` GET to
  `{FRONTEND_INTERNAL_URL}/api/internal/retrieval-settings` with
  `x-grid-internal-token`.
- `get_retrieval_setting(key: str, fallback: int) -> int` — returns the admin
  value if present and within catalog bounds (bounds duplicated as a small
  `_BOUNDS` dict for defense in depth), else `fallback`. Any fetch/parse error
  logs once and returns `fallback` (fail-open; retrieval must never break
  because the BFF is down).

### Consumption (per call, not at build time)

1. `knowledge_search` (`sources/knowledge_layer/src/register.py`):
   inside the tool closure, `top_k = get_retrieval_setting("knowledge.top_k",
   config.top_k)` and `max_per_document =
   get_retrieval_setting("knowledge.max_chunks_per_document",
   config.max_chunks_per_document)`. The static tool description keeps the
   build-time number; wording softened to "up to N relevant excerpts
   (platform-configurable)".
2. `surface_documents` (`src/aiq_agent/cards/surface_documents.py`): the
   `_CHUNK_TOP_K` / `MAX_SURFACED_FILES` module constants become defaults;
   per-call values resolved via the resolver.
3. `web_search` / `advanced_web_search`
   (`sources/tavily_web_search/src/register.py`): `max_results` resolved per
   call with `config.max_results` as fallback.
4. `ris_search` / `ris_catalog_lookup` (`sources/ris_adapter/src/register.py`):
   `max_results`, `page_size`, `max_matches` resolved per call.

## Frontend UI

- New page `frontends/ui/src/app/app/platform/retrieval/page.tsx` +
  `platform-retrieval-settings.tsx` client component, modeled on
  `platform-model-defaults.tsx`: grouped number inputs (Knowledge, Document
  surfacing, Web search, RIS), each showing the effective default when unset
  (placeholder), a Save bar, and a "reset to defaults" affordance (clears
  rows).
- Nav entry in the platform layout next to Models/Norms.
- `/dev/platform-retrieval` preview route with fixture data + registry target;
  light+dark screenshots committed (`task fe:screenshots`).

## Error handling

- BFF down/unreachable → backend logs a warning, uses build-time defaults.
- Invalid/stale value in DB (e.g. bounds tightened later) → backend drops it via
  `_BOUNDS` and uses the build-time fallback, never crashes retrieval.
- PUT with out-of-bounds or unknown keys → 422 with field errors.
- Non-platform-owner access → 403 via `platformApiRoute` permission check.

## Testing

- **Backend (pytest, `PYTHONPATH=src`)**: resolver unit tests (cache hit,
  TTL expiry, fail-open on HTTP error/timeout/invalid JSON, bounds clamping);
  tool-level tests asserting each call site consults the resolver (patch
  `get_retrieval_setting`, assert `retrieve`/`search` called with overridden
  values).
- **Frontend (vitest)**: catalog/zod schema bounds; repository round-trip with
  `asDb` fixtures; service authorization + audit; route coverage via the
  existing authz-coverage spec (factories only); component test of the form.
- **Parity**: the backend `_BOUNDS` dict and the frontend catalog bounds are
  kept in sync via a committed JSON snapshot (`tests/fixtures/retrieval_settings_catalog.json`,
  generated from `catalog.ts` by a small script, same mechanism as the
  request-context fixture) asserted by a pytest.

## Docs (same change)

- `docs/architecture/backend-deep-dive.md` — new short section on the
  platform-tunable retrieval knobs (resolver + consumption points).
- `docs/database/schema.md` — new table.
- `docs/api/*` — the two new routes.
- `AGENTS.md` — one-line mention in the platform tunables context; no new env
  vars are introduced (TTL fixed at 60s, matching model-overrides).

## Risks / mitigations

- **Resolver adds latency to first call after TTL expiry** — 60s cache +
  fail-open; retrieval path already does network I/O, one small cached GET is
  negligible.
- **Drift between catalog bounds and backend `_BOUNDS`** — parity test.
- **Someone sets `knowledge.top_k` very high and blows context budgets** —
  bounds cap at 50; the writer's `GRID_WRITER_CHAR_BUDGET` truncation remains
  the backstop.
