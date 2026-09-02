# Backend Message Localization

Status: Proposed — flagged for a human/product decision
Date: 2026-07-10
Scope: Localizing the handful of fixed English strings the Python backend
sends to users as chat bubbles (budget-exhausted, job-cap, "No response
generated.").

## Problem

Target users are German-speaking. The LLM pipeline already answers in the
user's language (the deep-research writer and the shallow researcher prompts
match the user's language; the clarifier localizes its question and plan
content — see Part 1 of this change). But a small set of **fixed, non-LLM**
strings are emitted verbatim by backend code and are always English:

| String | Source |
| --- | --- |
| Budget exhausted (`BudgetExceededError` default message) | `src/aiq_agent/common/cost_tracking.py` (~L82-88), sent via `src/aiq_agent/agents/chat_researcher/register.py` (~L606-610) |
| Job-cap / admission messages (`JobAdmissionError`) | `frontends/aiq_api/src/aiq_api/jobs/submit.py` (~L61-89) |
| "No response generated." | `src/aiq_agent/agents/chat_researcher/register.py` (~L633) |

These reach the user directly, without passing through any LLM, so no prompt
change can localize them.

## Why this is NOT implemented today

Localization must be driven by a **per-request locale signal**. Investigation
found that **no locale/language signal currently reaches the backend**:

- The gateway (`frontends/ui/server.js`) injects a fixed set of headers at the
  WebSocket upgrade: `x-grid-collection-scope`, `x-grid-organization-id`,
  `x-grid-user-id`, `authorization`, `x-grid-project-context`,
  `x-grid-project-id`, `x-grid-project-memory`,
  `x-grid-feature-memory-reflection`, `x-grid-model-overrides`,
  `x-grid-budget`. **None carries a locale.**
- The values for those headers come from `result.data` returned by
  `fetchCollectionScopeHeader`, which is populated by the Next.js
  (TypeScript) route/BFF layer. There is no `locale` field in that payload
  today, and that layer is owned by other concurrent workstreams.
- The backend reads these headers via `Context.get().metadata.headers.get(...)`
  (see `src/aiq_agent/project_context.py`, `cost_tracking.py`). There is no
  locale parsing anywhere in `src/aiq_agent` or `frontends/aiq_api`.
- The async-job path (deep research) does **not** transparently forward
  request headers. `frontends/aiq_api/src/aiq_api/jobs/runner.py` manually
  re-threads a **whitelist** of headers onto the reconstructed request
  (collection scope, project context, model overrides, budget). A new locale
  header would have to be added to that whitelist too, or async-job bubbles
  (e.g. the job-cap messages in `submit.py`) would silently fall back to
  English while chat bubbles localized — an inconsistent UX.

`Accept-Language` is not a clean substitute: it reflects the browser locale
rather than the app's chosen UI language (the frontend has its own i18n /
`useTranslations`), it is not reliably present on WebSocket handshakes, and it
is not in the async-job header whitelist — so it would still require new
backend parsing plus async-job threading.

Threading a real locale therefore requires **new plumbing across the gateway
(server.js), the TypeScript BFF that builds `result.data`, and the async-job
runner** — i.e. new architecture spanning components owned by other teams.
Per the guardrail for this change ("if it would require new plumbing across
gateway+frontend, do not build it"), it is deferred to a product/human
decision rather than implemented ad hoc.

## Recommended approach (when approved)

1. **Locale source of truth.** Use the user's app-level language preference
   (the same signal the frontend i18n uses), not `Accept-Language`. It is a
   stable, explicit product setting.
2. **Inject at the gateway.** Add `locale` to the `result.data` payload
   produced by the BFF (`fetchCollectionScopeHeader` and the async submit
   path), then inject a single header in `frontends/ui/server.js` alongside
   the existing ones:
   `req.headers['x-grid-locale'] = result.data.locale` (a short BCP-47 tag,
   e.g. `de`, `en`). Absent header ⇒ default to `en` (fail-open).
3. **Thread through async jobs.** Add `x-grid-locale` to the header whitelist
   reconstructed in `frontends/aiq_api/src/aiq_api/jobs/runner.py` so deep-
   research/job bubbles localize consistently with chat.
4. **Parse in one place.** Add a small helper next to the existing header
   readers in `src/aiq_agent/project_context.py`, e.g.
   `get_request_locale() -> str` returning a normalized 2-letter code with an
   `en` fallback. `submit.py` (which is upstream of the agent context) can read
   the header directly from its request.
5. **Message-code table.** Replace the inline English literals above with a
   tiny message table keyed by message code and locale, e.g.
   `src/aiq_agent/common/messages.py`:

   ```python
   MESSAGES = {
       "budget_exhausted": {
           "en": "The organization's LLM budget is exhausted ...",
           "de": "Das LLM-Budget der Organisation ist aufgebraucht ...",
       },
       "no_response": {"en": "No response generated.", "de": "Keine Antwort erzeugt."},
       "llm_unavailable": {"en": "...", "de": "..."},
       "llm_timeout": {"en": "...", "de": "..."},
       "temporary_error": {"en": "...", "de": "..."},
       # job-cap messages take runtime args (counts) → use format strings
       "queue_full": {"en": "Research queue is full ({n} jobs active) ...", "de": "..."},
       "org_cap": {"en": "Your organization already has {n} research jobs ...", "de": "..."},
   }

   def t(code: str, locale: str, **kwargs) -> str:
       table = MESSAGES[code]
       return table.get(locale, table["en"]).format(**kwargs)
   ```

   Select by locale with an unconditional **English fallback** (unknown or
   missing locale ⇒ English). Each call site swaps its literal for
   `t("<code>", locale, ...)`.
6. **Tests.** Add message-table selection tests (EN passthrough, DE selection,
   unknown-locale ⇒ EN fallback, format-arg interpolation) once implemented.

## Decision needed

- Confirm the locale source (app language preference vs. `Accept-Language`).
- Approve adding `x-grid-locale` across gateway + BFF + async-job whitelist.
- Confirm the target languages (EN + DE now; structure supports more).
