# Runtime Model Configuration

> Design spec for ADR-0014. Which model each *agent group* runs on is decided
> at runtime — by the platform owner for the whole fleet, and by each org for
> itself — validated, auditable, reversible, no restarts.

## Goals

- Per-tenant model choice per agent group, applied to new conversations
  immediately.
- **A platform-controlled default under it**: the platform owner picks the
  model each group runs on, and every org that has not chosen its own follows
  automatically — a fleet-wide model bump is one save, not a config edit and a
  redeploy.
- Only *appropriate* models selectable: capability-validated against the
  OpenRouter catalog per group.
- Org-admin-only management of the org layer, platform-owner-only management of
  the default layer; every change carries an author + note; org changes are
  versioned with one-click rollback.
- Fail-open runtime: a broken/absent override means the layer below applies,
  down to the workflow YAML — model configuration can never take chat down.

## The three layers

Resolution is **per agent group**, so the layers mix: an org that pinned only
`deep_research` still follows the platform default for `intent`.

| Layer | Where it lives | Who writes it | Scope |
|---|---|---|---|
| Org override | `org_model_config_versions` (+ pointer) | org admin, Organization → Models | one tenant, wins |
| **Platform default** | `platform_model_defaults` | platform owner, Platform → Models | every tenant that has not overridden the group |
| Workflow YAML | `configs/*.yml` → `llms:` → `model_name` | a commit + redeploy | boot fallback only |

The YAML is no longer where the fleet's model is decided — its `model_name`
values are `${GRID_DEFAULT_MODEL:-…}` boot fallbacks for a fresh install or a
deployment running without the BFF. What the YAML still solely owns is the
plumbing an override may never touch: `base_url`, `api_key`, `temperature`,
`max_tokens`, `reasoning_effort`, timeouts and retries.

The merge happens **BFF-side**, in `getEffectiveModelOverrides()`
(`frontends/ui/src/lib/model-config/service.ts`). Every submission path already
forwards whatever that function returns, so the Python backend keeps its single
contract — "the header is model selection only" — and needs no notion of a
platform layer at all.

BYOK caveat (ADR-0022): a platform default is an OpenRouter `author/slug`, and
a BYOK credential swaps the key and base URL but never the model. An org on a
non-OpenRouter BYOK key therefore inherits an id its provider does not know —
exactly as it previously inherited the YAML's OpenRouter id — and is expected
to pin its own models. Zero-Data-Retention orgs are the other edge: the save
path records per group whether the chosen default has a ZDR endpoint
(`model_snapshot._zdr.safe`) and the admin UI flags the ones that do not, but a
non-ZDR default is allowed — those tenants pin their own model instead.

## Agent groups

The override points sit *above* the YAML LLM names, so the YAML can reshuffle
freely. Registry: `frontends/ui/src/lib/model-config/agent-groups.ts` (with
capability requirements) mirrored by `AgentGroup` in
`src/aiq_agent/common/model_overrides.py` (**keep in sync**).

| Group id | Covers (config LLMs) | Requirements (catalog) |
|---|---|---|
| `intent` | `intent_llm` | text input, ≥16k context |
| `clarifier` | `clarifier_llm` (agent + planner) | `tools`, ≥32k |
| `shallow_research` | `shallow_llm` | `tools`, ≥64k |
| `deep_research` | `deep_orchestrator_llm`, `deep_planner_llm`, `deep_researcher_llm` (+ writer) | `tools`, ≥128k |
| `deep_research_router` | `deep_router_llm` | text input, ≥16k |
| `memory_reflection` | `memory_reflection_llm` (= `card_llm` in the reference config) | text input, ≥32k |
| `ingest_vlm` | the ingestion VLM (image captioning + rendered-drawing description) | **image input** (`requiresImageInput`) — vision models only |

Requirements are enforced twice: the picker endpoint only lists passing
models, and the save endpoint re-validates server-side (422 on mismatch).

**`ingest_vlm` specifics.** Unlike the chat groups it re-points a bespoke
*vision* call site in the ingestion plane (not a NAT chat model), and it is
resolved by org id inside a detached ingest thread rather than from the request
header (the org id is captured at `/v1/ingest` — see the "Submission paths"
section). Two things differ from a chat group:

- **Vision requirement.** `requiresImageInput: true` in `agent-groups.ts` gates
  the picker and the save-path `validateModelForGroup` to models whose
  `architecture.input_modalities` includes `image` — a text-only model would
  produce empty captions. Self-skips on BYOK catalogs with no modality metadata.
- **Workflow default.** The VLM is env-configured (`AIQ_VLM_MODEL`), not a
  `llms:` entry, so `/v1/config/llm-defaults` reports its resolved default under
  a synthetic `vlm` key and the group's `configLlmRefs: ['vlm']` maps to it.

BYOK (org key + base URL) is resolved via `resolve_vlm_credential(org_id)`; the
selected model rides the standard override header/stored-config path.

## Data model — platform defaults (migration `0026_platform_model_defaults.sql`)

```
platform_model_defaults
  agent_group      text PK      -- 'shallow_research', …
  model            text         -- catalog-validated OpenRouter id
  model_snapshot   jsonb        -- catalog metadata + _zdr.safe (audit only)
  note             text
  updated_by / updated_by_email / created_at / updated_at
```

Global — no `organization_id`, mirroring `platform_workflow_templates`
(ADR-0016/0027). One row per group; **no row = that group falls through to the
YAML**. A save REPLACES the set: groups omitted from the payload are deleted,
which is how a group is handed back to the workflow config. Not versioned like
the org table — the trail is the WorkOS audit event
`platform.model_defaults.updated` (recorded in the platform org, carrying the
full new map) plus the `note` on the rows themselves.

## Data model — org overrides (migration `0012_org_model_config.sql`)

```
org_model_configs                      org_model_config_versions
  organization_id  text PK      ┌──▶     id               uuid PK
  active_version_id uuid FK ────┘        organization_id  text
  updated_by       text                  version          int   (unique per org)
  created_at/updated_at                  overrides        jsonb {group: {model}}
                                         model_snapshot   jsonb (catalog metadata at save)
                                         comment          text
                                         created_by       text
                                         created_at       timestamptz
```

- Versions are immutable and append-only; **save** inserts version N+1 and
  repoints the meta row; **rollback** repoints only. `active_version_id NULL`
  = workflow defaults.
- `model_snapshot` freezes what the admin saw (context length, pricing,
  supported parameters) — pure audit, never re-applied.

## API surface — platform defaults (BFF, platform-owner-gated)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/platform/model-defaults` | registry + current default per group + the YAML fallback each group has |
| PUT | `/api/platform/model-defaults` | validate against the platform catalog → replace the default set (200 / 422 / 503-catalog-down) |
| GET | `/api/platform/model-defaults/models?group&q` | capability-filtered catalog search, annotated with `zdrSafe` |

Deliberately **not** behind the per-org `modelConfiguration` feature flag: this
is the layer *under* every tenant's configuration, not a tenant capability. The
picker reads `fetchModelCatalog()` (the shared platform catalog) rather than
`getCatalogForOrg()` — a default served to everyone cannot come from one
tenant's BYOK provider listing.

## API surface — org overrides (BFF, all org-admin-gated)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/organization/model-config` | agent-group registry + active version |
| PUT | `/api/organization/model-config` | validate against live catalog → new version + activate (201 / 422 / 503-catalog-down) |
| GET | `/api/organization/model-config/versions` | history |
| POST | `/api/organization/model-config/versions/{id}/activate` | rollback / re-activate; `{id}='none'` → defaults |
| GET | `/api/organization/model-config/models?group&q` | capability-filtered catalog search |

"The default" shown in the UI is resolved in `backend-defaults.ts`, and which
one you get depends on which question is being asked:

- `getWorkflowGroupDefaults()` — the backend's loaded YAML models, from
  `GET /v1/config/llm-defaults` (aiq_api `routes/config_info.py`,
  internal-token guarded) mapped through `configLlmRefs`. The **platform**
  screen shows this, because that is what clearing a default returns to.
- `getGroupDefaults()` — the same with the platform defaults layered over it.
  The **org** screen shows this, because that is what a tenant actually
  inherits and what its per-group reset returns to.

Both are cached for five minutes and fail soft per layer to a generic label.

OpenRouter catalog client: `frontends/ui/src/lib/model-config/openrouter.ts`
— `GET {OPENROUTER_BASE_URL:-https://openrouter.ai/api/v1}/models`, 5-minute
in-memory cache, optional `OPENROUTER_API_KEY` bearer.

## Runtime flow

```
platform owner saves → platform_model_defaults   ┐
org admin saves → org_model_config_versions (+ pointer)
                                     │           ├─ getEffectiveModelOverrides()
WS upgrade: /api/auth/websocket-scope merges both┘   (org wins per group)
                                     │  response.modelOverrides = {group: modelId}
server.js  ──  x-grid-model-overrides: base64url(JSON)  ──▶  aiq backend
                                     │
   model_overrides.py: parse + sanitize (unknown group / bad id dropped, fail-open {})
                                     │
 sync turn: each agent register's _run:
   provider.with_model_overrides(...)  → derived LLMProvider (model_copy per group)
   directly-held LLMs (intent invoke, clarifier planner, reflection schedule)
   wrapped via apply_model_override(llm, group)
                                     │
 async deep research: submit_agent_job auto-captures the map → Dask runner
   applies it to the worker's provider AND re-injects the header
```

The `{group: modelId}` map read on the WS upgrade
(`getEffectiveModelOverrides`, `frontends/ui/src/lib/model-config/service.ts`)
merges two independently cached layers — the org's own choices
(`OVERRIDES_CACHE_TTL_MS`, keyed per org) and the platform defaults
(`DEFAULTS_CACHE_TTL_MS`, one global key) — both 5 minutes and both
write-invalidated on save/rollback (ADR-0020's shared cache when `REDIS_URL` is
set; a per-process fallback otherwise). For a replica other than the one that
performed the save — or under the per-process fallback — a stale cache entry
means a save can take up to 5 minutes to affect traffic. That applies to a
fleet-wide default change too: it is fast, not instantaneous.

Key properties:

- `model_copy(update={"model_name": ...})` swaps only the model id — the
  HTTP client, `base_url`, API key, `max_tokens`, `reasoning_effort` stay
  from YAML. An override can never re-point provider or credentials.
- **This is model-selection only.** Every other generation parameter is
  still whatever the YAML tuned for the *default* model. Since the
  2026-07-16 reasoning-effort pass this is a safe design, not a caveat: every
  shipped config's `reasoning_effort` uses OpenRouter's standard vocabulary
  (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`) passed through verbatim — never a
  provider-native tier like DeepSeek's `max`, which is not a legal OpenRouter
  value and must not appear in a config (see
  `docs/architecture/llm-providers.md`). OpenRouter maps that standard value
  to the nearest level the request's *actual* model supports, per model,
  server-side — so a value sent unchanged to an org-overridden model is
  interpreted correctly by construction rather than merely tolerated. Other
  YAML-sourced parameters (`max_tokens`, `base_url`, keys) still come from
  the *default* model's tuning regardless of override target. Per-group
  parameter overrides (letting an org tune `reasoning_effort`/`max_tokens`
  independently of the model id) remain out of scope for v1 (ADR-0014, Open
  Questions).
- Overrides are strictly request-scoped: build-time providers/agents are
  never mutated; `with_model_overrides` returns `self` (identity check) when
  nothing applies, so the prebuilt agent path stays hot.
- The clarifier builds its graph in `__init__`, so an active override
  constructs a request-scoped agent — the same shape as the existing
  per-request data-source rebuild.
- Async jobs — both deep research and the post-answer memory-reflection
  stage — re-apply the map inside the Dask worker rather than inheriting it:
  request contextvars don't survive into a background job, so
  `jobs/runner.py` both (a) applies the sanitized overrides to the
  worker-side `LLMProvider` at build time and (b) re-injects the
  `x-grid-model-overrides` header into the worker's `Context.metadata` so
  `get_model_overrides_from_context()` keeps working for code that reads it
  from context inside the job. The reflection stage applies its own slice
  via `AgentGroup.MEMORY_REFLECTION`, carried through the same
  `model_overrides` job argument.

### Submission paths — all three now forward overrides

There are three distinct places a turn/job gets submitted to the backend.
As of 2026-07-16 all three carry the org's overrides, the last one via a
different mechanism than the first two. All three now call
`getEffectiveModelOverrides()`, so the platform defaults ride the exact same
rails as the org overrides always did — no path needed a new mechanism to pick
them up:

| Path | How overrides reach the backend | Overrides applied? |
|---|---|---|
| Interactive WS chat | `server.js` resolves the org's **effective** overrides at WS upgrade (`GET /api/auth/websocket-scope` → `getEffectiveModelOverrides`: platform defaults with the org's own choices layered over them) and forwards `x-grid-model-overrides`. When the turn kicks off an async deep-research job, that job is submitted **in-process** by `chat_researcher/register.py`, which captures the map from the live WS request context (`get_model_overrides_from_context()`) rather than re-resolving it. | Yes |
| Scheduled / manual Workflows (ADR-0023) | `fireWorkflow()` (`frontends/ui/src/lib/workflows/service.ts`) resolves the org's **effective** overrides (`getEffectiveModelOverrides`) and passes them explicitly as `model_overrides` in the `POST /v1/internal/workflows/submit` payload. | Yes |
| Generic REST async-job proxy: `POST /api/jobs/async/submit` → backend `POST /v1/jobs/async/submit` | **Fixed 2026-07-16** (`0bdfb72`, `a78f5d4`). `frontends/ui/src/app/api/jobs/async/[...path]/route.ts` now resolves the caller's effective overrides (`getEffectiveModelOverrides`) and forwards them — via the shared `GridRequestContext` builder, so both the legacy `x-grid-model-overrides` header and the signed `X-Grid-Request-Context` envelope carry them. Belt-and-suspenders on the backend: `get_model_overrides_from_context()` (`common/model_overrides.py`) reads the header/envelope first; when neither is present it falls back to a **just-in-time resolution of the effective selection** — `resolve_org_model_overrides()` calls the BFF's internal `GET /api/internal/model-overrides` endpoint, which itself returns the merged platform-plus-org map (the org's own choices win per group) (`GRID_INTERNAL_API_TOKEN`-guarded), cached in-process (60 s positive / 30 s negative TTL) and fail-open to `{}` (YAML defaults) on any error — mirroring the BYOK credential-resolution pattern. | **Yes**, via header-first-then-org-resolution precedence. See also `docs/api/bff-routes.md` and `docs/api/python-endpoints.md`. |

The JIT fallback (`resolve_org_model_overrides` / `/api/internal/model-overrides`)
also covers any future endpoint the BFF doesn't front, or a turn where the
best-effort WS-upgrade header injection failed — not just this one proxy.

## Security

- Org management routes: `requireAuthorizedSession()` + `isOrgAdmin()`.
- Platform default routes: `requirePlatformOwner()` (ADR-0016) — a tenant admin
  cannot read or write the fleet default, and the platform-owner role only
  exists inside the platform org, so it is structurally unassignable by them.
- The backend treats the header as *advisory model selection only* and
  sanitizes it (`^author/slug(:variant)?$` pattern, known groups only) —
  defense in depth behind the BFF's catalog validation.
- Config reads on the WS upgrade are best-effort; failures log and fall back
  to defaults.

## Failure modes

| Failure | Behavior |
|---|---|
| Catalog unreachable on save | 503, nothing written |
| Catalog unreachable on picker | 503, picker shows error |
| Header missing/malformed at runtime | JIT org-side resolution, then the YAML models (fail-open) |
| `platform_model_defaults` unreadable | the org's own overrides still apply; everything else falls to the YAML models |
| Platform default not ZDR-capable | recorded at save (`_zdr.safe: false`) and flagged in the UI; ZDR orgs must pin their own model |
| Overridden model rejected upstream by OpenRouter | LLM error surfaces in chat; admin rolls back the version |
| Version rollback race (two admins) | last write wins on the pointer; both versions remain in history |

## Verification (dry run)

This environment cannot reach openrouter.ai (network policy), so:

- The catalog client + capability filter + save validation are covered by
  vitest specs replaying the documented `GET /api/v1/models` response shape
  (`frontends/ui/src/lib/model-config/openrouter.spec.ts`).
- The platform/org merge (per-group precedence, fail-open on a platform-side
  error) is covered by
  `frontends/ui/src/lib/model-config/effective-overrides.spec.ts`; the
  platform-owner gate, catalog revalidation and clear-by-omission by
  `frontends/ui/src/app/api/platform/model-defaults/route.spec.ts`. The
  replace-not-patch write semantics need a real database
  (`platform-defaults.integration.spec.ts`, opt-in via
  `GRID_TEST_DATABASE_URL`).
- Header parse/sanitize, `override_model` copy semantics, and provider
  derivation are covered by pytest
  (`tests/aiq_agent/common/test_model_overrides.py`).
- **Marked assumption**: OpenRouter's catalog fields
  (`supported_parameters`, `context_length`,
  `architecture.input_modalities`, string `pricing`) per the official API
  reference. First deployment should open the picker and save a config
  end-to-end to confirm live behavior.
