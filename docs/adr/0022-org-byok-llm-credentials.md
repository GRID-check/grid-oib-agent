# ADR-0022: Enterprise BYOK LLM credentials per organization (WorkOS Vault) and the org web-search setting

- **Status**: Accepted
- **Date**: 2026-07-11
- **Deciders**: Grid Agent team
- **Related**: ADR-0010 (LLM-agnostic endpoints), ADR-0014 (org runtime model
  configuration), ADR-0015 (budgets/usage ledger), ADR-0016 (permission
  registry), ADR-0017 (BFF architecture), ADR-0020 (shared cache)

## Context

ADR-0014 deliberately stopped short of credentials: *"an override can never
re-point traffic at a different provider or credential"*. Enterprise tenants
now need exactly that — **Bring Your Own Key**: research traffic billed to the
organization's own LLM provider account, with the key lifecycle (creation,
rotation, revocation) controlled and audited by the tenant, and key material
protected to a compliance-grade standard.

We evaluated how far WorkOS takes us, since WorkOS is already our identity,
RBAC, feature-flag, and audit-log backbone:

- **WorkOS Vault** is a purpose-built encrypted key-value store. Every object
  is envelope-encrypted under a **per-organization key context**
  (`context: { organizationId }`), so tenant secrets are cryptographically
  isolated. Its **BYOK tier** lets an enterprise supply its own
  key-encrypting key from AWS KMS / Azure Key Vault / GCP KMS — the customer,
  not us and not WorkOS, then controls the root of the encryption chain, and
  key revocation at the KMS instantly renders stored secrets unreadable.
- **WorkOS Audit Logs** already receive all privileged BFF mutations
  (`lib/audit/service.ts`); credential lifecycle events slot straight in.
- **WorkOS Feature Flags** already gate premium capabilities per org
  (`runtime-model-config`, `memory-reflection`).
- WorkOS does **not** offer an LLM traffic gateway (an "AI gateway" in the
  Cloudflare/Vercel sense). The data plane — injecting the tenant key into
  model calls — remains ours.

Facts that shape the data plane:

- All LLM clients are OpenAI-compatible (`_type: openai`, ADR-0010) and built
  once at workflow registration; per-request adaptation happens via
  request-scoped `model_copy` derivations (ADR-0014).
- Async research jobs run on Dask workers; their `job_args` are persisted in
  the job store DB. **Plaintext keys must never enter `job_args`, headers
  logs, or the shared (Redis-backed) BFF cache.**
- The backend can already reach the BFF over the internal network
  (`FRONTEND_INTERNAL_URL` + `GRID_INTERNAL_API_TOKEN`).

## Decision

### 1. Storage: WorkOS Vault for key material, Postgres for metadata

A new `org_llm_credentials` table stores **metadata only**: provider, base
URL, key fingerprint (SHA-256 prefix) and hint (last 4), status, actor and
timestamps. The API key itself goes to a pluggable **secret store**
(`lib/llm-credentials/secret-store.ts`):

- `workos-vault` (default when `WORKOS_API_KEY` is set):
  `vault.createObject({ name, value, context: { organizationId } })`; the row
  stores only the returned Vault object id. Enterprise tenants can upgrade to
  full BYOK-of-the-KEK in WorkOS without any Grid change.
- `local-aes-gcm` (fallback for anonymous/dev deployments): AES-256-GCM under
  the `GRID_BYOK_LOCAL_KEK` env key, with `orgId:credentialId` as AAD so a
  ciphertext cannot be replayed across tenants or rows.

The backend is recorded per row (`secret_backend`), so deployments can migrate
backends without a big-bang re-encryption.

### 2. Lifecycle: append-friendly, one active credential per org

`POST /api/organization/llm-credentials` verifies the key **live against the
provider** (`GET {baseUrl}/models`) before anything is stored, then atomically
supersedes the previously active credential. Rotation creates a new row
(`rotated_from` links the chain) and revokes the old one; revocation
tombstones the row and deletes the secret from the store. A partial unique
index (`WHERE status = 'active'`) enforces at most one active credential per
org. Every transition emits a WorkOS audit event
(`llm_credential.created/rotated/revoked/verified`).

Provider presets: `openrouter` (reference), `openai`, `azure-openai`,
`custom` (any OpenAI-compatible gateway, e.g. LiteLLM/Azure APIM). Custom
base URLs must be HTTPS and pass an SSRF guard (private/loopback hosts
rejected unless `GRID_BYOK_ALLOW_PRIVATE_BASE_URLS=true` for self-hosted
gateways). All routes are gated by `org:models:manage` **and** the
`byok-llm` feature flag; key material is never returned to any client.

### 3. Delivery: just-in-time pull, not header push

The plaintext key deliberately does **not** ride the `x-grid-*` header path
that model overrides use. Instead the Python side resolves it on demand:

- BFF exposes `GET /api/internal/llm-credential?organizationId=…`
  (internal-token guarded). It re-checks the feature flag, reads the metadata
  row, decrypts via the secret store, and returns
  `{provider, baseUrl, apiKey, id, keyFingerprint}` — or `{credential: null}`.
- `src/aiq_agent/common/llm_credentials.py` calls it with a short in-process
  TTL cache (60 s positive / 30 s negative) keyed by org id — resolved from
  the existing `x-grid-organization-id` header in chat, and from the
  submit-time `usage_context.identity` in Dask workers.
- Application swaps `api_key`/`base_url` by **reconstructing** the LangChain
  client (constructor round-trip, not `model_copy` — the bound HTTP client
  must be rebuilt for a credential change to actually take effect), request-
  scoped via `LLMProvider.with_credential()` alongside
  `with_model_overrides()`.

Consequences of JIT-pull: no key in WS headers, none in Dask `job_args` or
the job store, none in the Redis-backed BFF cache; a revocation propagates
within the 60 s cache TTL to every replica and worker. Failure of the
internal endpoint fails **open to the platform key** (chat must not go down
because a tenant key lookup hiccupped); the fallback is logged without key
material.

### 4. The model switcher follows the credential

ADR-0014's model switcher and BYOK compose instead of excluding each other:

- **No credential** → the picker works exactly as before: platform
  OpenRouter catalog, full capability validation, platform billing.
- **OpenRouter credential** → same catalog and validation; every request is
  billed to the org's own OpenRouter account. Overrides keep working.
- **openai / azure-openai / custom credential** → the picker lists the live
  `GET {baseUrl}/models` of the ORG's provider (fetched with the org key,
  cached 5 min without the key). Capability checks run in relaxed
  membership-only mode, because provider-native listings carry no
  context-length/parameter metadata. Save-time validation and the version
  snapshot record which catalog the admin chose from (`_catalog` marker).

Model-id shape is widened accordingly (`author/slug` OR provider-native ids
like `gpt-4o`, `ft:…`, Azure deployment names) in the BFF zod schema and
the backend sanitizer alike; catalog membership remains the real gate.
Runtime order of application: per-group model override first, then the
credential swap — so a BYOK org can still re-point each agent group at any
model its own provider serves.

### 5. Org-level web-search setting

Web search becomes tenant-controllable with two layers, both resolved at the
WS upgrade / job submit:

- **Platform layer**: WorkOS feature flag `web-search` (participates only
  when `GRID_ENFORCE_FEATURE_FLAGS=true`, like the JWT-claim flags) — the
  platform can sales-gate or kill-switch the capability per org.
- **Tenant layer**: `organizations.settings.webSearchEnabled` (default
  `true`), editable by `org:settings:manage` holders in the org settings UI.

Enforcement is server-side: the websocket-scope endpoint emits
`disabledSources: ["web_search"]`, `server.js` forwards it as the
base64url `x-grid-disabled-sources` header, and
`filter_tools_by_sources()` subtracts disabled sources even when a request
asks for "all sources". Async submits subtract disabled sources from the
effective `data_sources` before the job is queued, so workers need no live
flag lookup. The BFF's `/api/v1/data_sources` proxy filters the listing so
the toggle disappears from the UI for disabled orgs (defense in depth: the
header enforcement holds even against a hand-crafted payload).

## Consequences

### Positive

- Tenant keys are envelope-encrypted per organization in WorkOS Vault, with a
  documented upgrade path to customer-managed KEKs (true enterprise BYOK)
  and instant KMS-side kill.
- Key material has exactly one decryption point (the internal endpoint) and
  never persists outside the vault/ciphertext column.
- Billing moves to the tenant's provider account while the usage ledger
  (ADR-0015) keeps recording spend for budgets.
- Rotation/revocation are auditable in the tenant's own WorkOS audit trail
  and take effect within one cache TTL, without restarts.
- Web-search availability is now a per-tenant decision with platform
  override, enforced at the tool layer, not just hidden in the UI.

### Negative

- A backend→BFF HTTP dependency appears on the LLM-build path (mitigated by
  the TTL cache and fail-open semantics; worst case adds one bounded internal
  round-trip per org per minute per process).
- Client reconstruction for credential swaps is heavier than the
  `model_copy` used for model ids (accepted: it happens at most once per
  request-scoped rebuild, and only for BYOK orgs).
- Provider-native `/models` listings carry no capability metadata, so for
  non-OpenRouter BYOK catalogs the ADR-0014 capability checks degrade to
  membership-only validation (see §4) — a tool-incapable model can then
  only be caught at runtime.

### Risks

- A tenant key that dies mid-flight (provider-side revocation) surfaces as
  LLM errors until the org rotates or revokes — same failure mode as
  ADR-0014's removed-model risk; the verify endpoint and `last_verified_at`
  make diagnosis one click.
- Local-KEK deployments carry the KEK in an env var; the ADR explicitly
  positions WorkOS Vault as the production path.

## Alternatives considered

- **Key in the `x-grid-llm-credentials` header** (symmetric with model
  overrides): rejected — plaintext key would traverse WS upgrade headers and
  be persisted in Dask `job_args`/job store rows.
- **Backend reads the DB/Vault directly**: rejected — the BFF owns tenancy,
  flags, and audit (ADR-0017); a second decryption point doubles the audit
  and SSRF surface.
- **A third-party AI gateway (Cloudflare/Vercel/LiteLLM) per tenant**:
  heavier operational footprint and a second vendor for key custody; WorkOS
  Vault + our existing OpenAI-compatible client layer covers the requirement.
- **`organizations.settings` jsonb for the key**: rejected outright (would
  put ciphertext-less secrets in the app DB and the settings PUT path).

## Follow-ups

- Per-agent-group credentials (e.g. cheap provider for intent, premium for
  deep research) once a concrete need appears.
- Surface `last_used_at` drift ("key unused for 90 days") in the org UI.
- Automated re-verification cron with admin notification on failure.
