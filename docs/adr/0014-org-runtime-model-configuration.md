# ADR-0014: Org-level runtime model configuration per agent group

- **Status**: Accepted
- **Date**: 2026-07-07
- **Deciders**: Grid Agent team
- **Related**: ADR-0010 (LLM-agnostic via OpenAI-compatible endpoints), ADR-0013 (base64url context headers), ADR-0004 (tenancy), `docs/architecture/org-model-configuration.md`

## Context

ADR-0010 made GRID LLM-agnostic: every model is chosen in the workflow YAML
(`configs/*.yml`) at **process start**. Changing a model requires editing the
config and restarting the backend — an operator action, applied to every
tenant at once. Organizations want to tune cost/quality per **agent group**
(intent routing vs deep research have very different model needs) at runtime,
without redeploys, per tenant.

Facts that shape the solution:

- All LLM clients are built once at workflow registration
  (`builder.get_llm(...)`); only request headers reach the backend per-turn.
- The BFF already forwards per-org runtime context to the backend as
  `x-grid-*` headers on the WebSocket upgrade (ADR-0013), and the Dask worker
  re-injects those headers for async jobs.
- The reference provider is OpenRouter; its public catalog
  (`GET /api/v1/models`) carries per-model capability metadata
  (`supported_parameters`, `context_length`, `architecture.input_modalities`).
- Model choice affects cost and answer quality for the whole tenant, so the
  change history must be auditable and reversible.

## Decision

We will let **org admins** re-point each **agent group** at a different
OpenRouter model **at runtime**, stored in `grid_app` as a **two-table
versioned configuration**, validated against the **OpenRouter catalog**, and
delivered to the backend as a per-request header.

1. **Agent groups, not raw YAML names.** A code-defined registry
   (`frontends/ui/src/lib/model-config/agent-groups.ts`, mirrored by
   `AgentGroup` in `src/aiq_agent/common/model_overrides.py`) exposes six
   stable override points: `intent`, `clarifier`, `shallow_research`,
   `deep_research`, `deep_research_router`, `memory_reflection`. Each group
   carries capability requirements (required `supported_parameters`, minimum
   context length, text input).
2. **Two tables, immutable versions** (`0012_org_model_config.sql`):
   `org_model_configs` (one row per org: pointer to the active version) and
   `org_model_config_versions` (append-only: full overrides object, author,
   change note, and a snapshot of the catalog metadata each model was
   validated against). Save = new version + repoint; rollback = repoint.
3. **Server-side catalog validation on every save.** The BFF fetches
   `GET /api/v1/models` (5-minute cache) and rejects any model that is not in
   the catalog or fails the group's requirements (HTTP 422). The picker UI
   only lists passing models; a catalog outage rejects saves (503) instead of
   accepting unvalidated ids.
4. **Admin-only**: every route under `/api/organization/model-config` is
   gated by `isOrgAdmin(session)`.
5. **Runtime delivery**: the websocket-scope endpoint resolves the active
   version to a flat `{group: modelId}` map; `server.js` forwards it
   base64url-encoded as `x-grid-model-overrides`; the backend sanitizes it
   (unknown groups / malformed ids dropped, fail-open to YAML defaults) and
   applies it request-scoped: `LLMProvider.with_model_overrides()` derives a
   provider with `model_copy`-swapped clients (HTTP client shared, model name
   changed), and directly-held LLMs (intent, clarifier planner, reflection)
   are wrapped at their invocation sites. Async jobs receive the same map via
   `submit_agent_job` → worker header re-injection.
6. **Only the model id changes.** `max_tokens`, `reasoning_effort`,
   `base_url`, and the API key still come from the workflow YAML — an
   override can never re-point traffic at a different provider or credential.

## Consequences

### Positive

- Model changes are per-tenant, immediate (next conversation), and need no
  restart or config edit.
- Every change is attributable (who, when, why) and reversible in one click;
  the catalog snapshot records what the admin saw at decision time.
- Capability validation prevents the classic failure mode: pointing a
  tool-calling agent at a model that cannot call tools.
- Fail-open semantics: any malformed/absent override falls back to the
  YAML-configured defaults; model configuration can never take chat down.

### Negative

- The agent-group registry exists in two languages (TS + Python) and must be
  kept in sync by hand.
- Request-scoped overrides rebuild the clarifier/deep agents when active
  (same shape as the existing data-source rebuild), a small per-request cost.
- YAML defaults and DB overrides are two places to look when debugging which
  model actually served a request (mitigated by the usage ledger's
  `requested_model`/`model` columns, ADR-0015).

### Risks

- OpenRouter catalog metadata could lag a model's real capabilities; the
  save-time snapshot documents what was known.
- A model available at save time may be removed later; requests then fail at
  OpenRouter and surface as LLM errors (roll back the version to recover).

## Alternatives Considered

- **`organizations.settings` jsonb bag** (existing pattern): no versioning,
  no author trail, no rollback — rejected because model choice is a
  high-blast-radius, audit-worthy change.
- **One table with a `status=active` flag** (project-memory idiom): equal
  power, but "which version is live" becomes a scan invariant instead of a
  single pointer read on the hot WS-upgrade path; the meta table also gives
  free per-org bookkeeping (who last activated).
- **WorkOS feature flags / org metadata**: WorkOS is the identity source of
  truth (ADR-0002/0007), not an application config store; no schema,
  versioning, or transactional writes.
- **Restart-based per-org YAML configs**: per-tenant process pools —
  operationally out of scope for a single-stack deployment.

## Open Questions / Follow-ups

- Populate `agent_group` on usage-ledger rows so per-group spend can be
  reported next to per-model spend.
- A shared JSON source generating both registries would remove the
  keep-in-sync burden.
- Per-group parameter overrides (e.g. `reasoning_effort`) are deliberately
  out of scope for v1.

## References

- `docs/architecture/org-model-configuration.md` (design spec)
- OpenRouter models API: https://openrouter.ai/docs/api/reference/overview
