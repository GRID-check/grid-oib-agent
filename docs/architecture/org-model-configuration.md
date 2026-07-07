# Org-Level Runtime Model Configuration

> Design spec for ADR-0014. Org admins re-point each *agent group* at a
> different OpenRouter model at runtime — versioned, validated, auditable,
> reversible, no restarts.

## Goals

- Per-tenant model choice per agent group, applied to new conversations
  immediately.
- Only *appropriate* models selectable: capability-validated against the
  OpenRouter catalog per group.
- Org-admin-only management; every change versioned with author + note;
  one-click rollback.
- Fail-open runtime: a broken/absent override means the workflow YAML
  defaults apply — model configuration can never take chat down.

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

Requirements are enforced twice: the picker endpoint only lists passing
models, and the save endpoint re-validates server-side (422 on mismatch).

## Data model (grid_app, migration `0012_org_model_config.sql`)

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

## API surface (BFF, all org-admin-gated)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/organization/model-config` | agent-group registry + active version |
| PUT | `/api/organization/model-config` | validate against live catalog → new version + activate (201 / 422 / 503-catalog-down) |
| GET | `/api/organization/model-config/versions` | history |
| POST | `/api/organization/model-config/versions/{id}/activate` | rollback / re-activate; `{id}='none'` → defaults |
| GET | `/api/organization/model-config/models?group&q` | capability-filtered catalog search |

Workflow defaults shown in the UI come from the backend:
`GET /v1/config/llm-defaults` (aiq_api `routes/config_info.py`, internal-token
guarded) reports each named LLM's model from the loaded YAML; the BFF maps it
through `configLlmRefs` (`backend-defaults.ts`, 5-minute cache, fail-soft to a
generic label) so admins see exactly what a reset returns to.

OpenRouter catalog client: `frontends/ui/src/lib/model-config/openrouter.ts`
— `GET {OPENROUTER_BASE_URL:-https://openrouter.ai/api/v1}/models`, 5-minute
in-memory cache, optional `OPENROUTER_API_KEY` bearer.

## Runtime flow

```
org admin saves → org_model_config_versions (+ pointer)
                                     │
WS upgrade: /api/auth/websocket-scope reads active version
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

Key properties:

- `model_copy(update={"model_name": ...})` swaps only the model id — the
  HTTP client, `base_url`, API key, `max_tokens`, `reasoning_effort` stay
  from YAML. An override can never re-point provider or credentials.
- Overrides are strictly request-scoped: build-time providers/agents are
  never mutated; `with_model_overrides` returns `self` (identity check) when
  nothing applies, so the prebuilt agent path stays hot.
- The clarifier builds its graph in `__init__`, so an active override
  constructs a request-scoped agent — the same shape as the existing
  per-request data-source rebuild.

## Security

- All management routes: `requireAuthorizedSession()` + `isOrgAdmin()`.
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
| Header missing/malformed at runtime | YAML defaults (fail-open) |
| Overridden model rejected upstream by OpenRouter | LLM error surfaces in chat; admin rolls back the version |
| Version rollback race (two admins) | last write wins on the pointer; both versions remain in history |

## Verification (dry run)

This environment cannot reach openrouter.ai (network policy), so:

- The catalog client + capability filter + save validation are covered by
  vitest specs replaying the documented `GET /api/v1/models` response shape
  (`frontends/ui/src/lib/model-config/openrouter.spec.ts`).
- Header parse/sanitize, `override_model` copy semantics, and provider
  derivation are covered by pytest
  (`tests/aiq_agent/common/test_model_overrides.py`).
- **Marked assumption**: OpenRouter's catalog fields
  (`supported_parameters`, `context_length`,
  `architecture.input_modalities`, string `pricing`) per the official API
  reference. First deployment should open the picker and save a config
  end-to-end to confirm live behavior.
