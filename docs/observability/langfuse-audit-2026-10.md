# Langfuse audit, October 2026: what it offers, what we used, what we changed

Frozen on 2026-10-09. Evidence for [ADR-0089](../adr/0089-langfuse-is-the-observability-platform-and-everything-is-observable.md).
The contract that came out of it is [`langfuse.md`](langfuse.md); the open
items at the end are the work list.

## How this was done

Fifteen parallel read-only passes over the repository: the observability
package, every call site of the trace helpers, prompt management, the NAT
telemetry config, the BFF, the deletion workers, the feedback surfaces, the
deployment, evaluation, the docs and audits, the cost ledger, turn-to-trace
mapping, git history and other analytics tooling. Two more passes read
Langfuse's documentation and licence split for self-hosted 4.x. Findings were
then checked against the code before anything was changed.

## What Langfuse 4.x offers, self-hosted, and what we used before this change

"Free" means in the MIT build with no licence key
([pricing-self-host](https://langfuse.com/pricing-self-host),
[license-key](https://langfuse.com/self-hosting/license-key)).

| Feature | Free? | Before | After this change |
|---|---|---|---|
| Tracing, OTel ingestion | yes | yes, via the collector | unchanged |
| Sessions | yes | yes (NAT sets `session.id`) | unchanged |
| Users | yes | yes, behind `GRID_TRACE_IDENTITY_ATTRIBUTES` | unchanged |
| Environments | yes | **no**: `deployment.environment` was a resource attribute Langfuse does not read as the environment | `langfuse.environment` on every span |
| Releases | yes | **no**: the commit was on the log resource only | `langfuse.release` on every span, `service.version` on the trace resource |
| Trace names | yes | `chat_deepresearcher_agent` | `chat-turn`, `research-job`, one per auxiliary feature |
| Observation types (agent graphs) | yes | **no**: everything a plain span except generations | agent, generation, tool, retriever, chain, embedding, guardrail, evaluator |
| Levels and status | yes | **no**: NAT never sets an error status | a failed turn's root is ERROR, a stopped one WARNING |
| Root input/output (v4 replaces trace I/O) | yes | output was NAT's 50-item stream preview | output is the answer text |
| Tags and metadata | yes | tenant tag, IFC facts, usage, dialect; all dropped with identity off | outcome, route, confidence, sources; independent of identity |
| Token and cost tracking | yes | yes, incl. cached and reasoning buckets | plus the six auxiliary routes |
| Prompt management | yes | one prompt (`piloti-system-static`), behind `LANGFUSE_PROMPTS_ENABLED`, which no environment sets | unchanged; see open items |
| Prompt-to-generation linkage | yes | yes | unchanged |
| Scores via API | yes | `user-feedback` only | plus `user-feedback-reason` and fifteen runtime checks |
| Score configs | yes | none | declared and provisioned for every score |
| Annotation queues | yes | none | `answer-review`, fed by every down-vote |
| LLM-as-a-judge evaluators | yes | none | three judges and their rule, provisioned disabled |
| Datasets, experiments | yes | none; golden questions live in YAML only | `golden-questions` dataset provisioned |
| Custom dashboards | yes | none | a recommended set in the [analyst guide](analyst-guide.md); built in the UI |
| Metrics API v2 | yes (v4) | unused | unused; see open items |
| Blob storage export | yes | batch export enabled in the deployment, no scheduled export | unchanged; see open items |
| PostHog integration | yes | unused; PostHog runs in the browser separately | unused; see open items |
| Organization-level roles (Viewer, Member, Admin, Owner) | yes | no default: a first SSO login's membership was undefined | first login joins the project as VIEWER |
| Project-level roles, audit logs, retention policies, server-side masking, SCIM | **Enterprise** | not used | not used; retention is our own 30-day job (ADR-0044 Amendment 4) |
| Protected prompt labels | **Enterprise** | not used | not used |

The version moved from 4.54.0 to **4.56.0**, released 2026-10-09.

## Findings that were defects, now fixed

1. **The privacy switch also switched off reporting.** Tool facts, the usage
   rollup and the dialect census reached spans only through the identity
   processor, so with `GRID_TRACE_IDENTITY_ATTRIBUTES` off they were dropped
   without a word. Contributions now have their own processor; identity gates
   only the user and the tenant.
2. **Six model calls were invisible.** Titles, project summaries, the
   consistency check, skill review, lesson distill and the feedback digest call
   a model straight from a route, outside any NAT run. They left no span and no
   cost. Each is now a generation (`direct_trace.observed_generation`), and a
   contract test fails on a seventh.
3. **The usage rollup's error flag never reached the trace.** Its docstring
   said "only a flag on the row itself survives the trace export", and the flag
   was not stamped. It is now, with the cost source.
4. **Runtime quality checks were not scores.** Citation health, quote patches,
   dialect repairs, card repairs and confidence caps went to a BFF ledger, a
   wire status or a metadata blob. They are now scores on the turn's trace.
5. **Langfuse was operators-only.** The edge gate admitted only
   `platform:organizations:view`. It now also admits
   `platform:observability:view`, granted by its own WorkOS role.

## Open items

Ordered by what they unblock. Each names its owner decision where one is
needed.

0. **Verify the edge gate actually checks the permission (security, before
   anything else).** WorkOS's Connect documentation
   (https://workos.com/docs/authkit/connect/token-claims) says scopes "do not
   enforce the user's role-based permissions". If that holds for our
   application, the Langfuse and Aspire routes admit every WorkOS user who
   asks for the scope, today and independent of this change. The live check is
   step 3 of "Giving analysts read-only access" in
   [`kubernetes.md`](../deployment/kubernetes.md): sign in as a tenant user and
   expect 403. If it is not 403, gate on the platform organization plus a role
   claim from a JWT template, or on a server-side permission lookup.

1. **Long-term trends versus 30-day retention (decision).** The retention job
   deletes traces after 30 days, and Langfuse's dashboards and Metrics API read
   traces, so no trend is longer than a month. Options: a scheduled blob export
   to SeaweedFS before deletion (free; `api.blob_storage_integrations`), a
   nightly Metrics API rollup into Postgres, or a longer retention for scores
   only. The 30 days were a product-owner decision for privacy; extending what
   is kept needs the same owner.
2. **Enable the judges (decision).** Add an LLM connection on a
   zero-data-retention endpoint, then enable `chat-turn-judges` in the UI.
   Compare the judges with `review-correctness` for a few weeks before trusting
   their trend.
3. **Run the answer suite as a Langfuse experiment.** `task
   be:eval:answer-suite` writes `results.json` and `report.md` to `/tmp`. Linking
   each run to the `golden-questions` dataset (dataset run items with the run's
   trace ids) makes prompt and model comparisons visible to everyone.
4. **Adopt prompt management.** `LANGFUSE_PROMPTS_ENABLED` is set in no
   environment (ADR-0060). Until it is, prompt-version comparisons only see the
   bundled fallback's git hash. The other nine prompt templates (planner,
   researcher, writer, source router, orchestrator, clarification, plan
   generation, source registry, the dynamic half) are not managed at all, and
   their generations are stamped with the platform prompt's identity (the known
   over-broadness in `langfuse_trace_attributes.py`).
5. **The v4 `events_only` cutover.** The deployment writes `dual`. Langfuse
   v4's native mode is `events_only`, and trace-level evaluators stop at the
   cutover (the judges here are observation-level already). The cutover is
   gated on a backup ([`kubernetes.md`](../deployment/kubernetes.md) § 9b).
6. **Auxiliary calls have no session.** None of the six auxiliary request
   models carries a conversation id, so a title call does not group with its
   chat. Adding an optional `conversation_id` to the title request and sending
   it from the BFF closes it for the one route where it matters.
7. **One more model call outside NAT.** The feedback digest's cause labelling
   (`aiq_agent.common.feedback_causes.label_causes`) is not under `routes/`, so
   the contract test does not see it. Wrap it.
8. **Embeddings and rerank have no observation.** Both are metered in the cost
   ledger and counted in the turn's totals, but no span is wrapped around the
   raw SDK calls, so latency per search step is invisible. Rerank also records
   cost 0 always.
9. **Agent group is NULL on every chat completion in the ledger**
   (`llm_usage_events.agent_group`, ADR-0015's open item). Generations in
   Langfuse are named by model, and `writer_llm` and `orchestrator_llm` resolve
   to the same model, so the role cannot be read off the name. Stamping the
   role on the generation span would fix both views.
10. **The BFF has no traces of its own.** `RootSpanDropSampler` drops every BFF
    root span on purpose (they drowned the agent's). The BFF's own latency is
    visible only in logs.
11. **PostHog receives users' names and e-mail addresses** on identify
    (`frontends/ui/src/app/providers.tsx`), which contradicts the compliance
    audit's "no analytics/tracking anywhere in the UI". Not a Langfuse issue,
    found on the way; it needs a privacy decision.
12. **Ingest has no rollup.** Ingestion, OCR and vision calls are in the
    ledger with `activity=ingest` and carry no session, so they are not erased
    with a chat and age out after 30 days
    ([upload governance audit](../audit/upload-governance-traceability-2026-10-06.md)).
13. **The office's experience (ADR-0094, ADR-0096) is only half observable.**
    Since 10 Oct a `project_lookup` is a `retrieve.project_lookup` observation,
    and the root carries the catalog size, p(precedent), whether round 0
    prefetched the reference projects, and how many cited sources came from
    other projects (`langfuse.md`). Every decision-model call is a
    `decide.<slot>` generation with its answers and cost, and the reference
    fit and the hit judge are on the turn and on the lookup's observation.
    Still open:
    - the closed-project reading (`knowledge/project_experience.py`, three
      LangChain calls per project behind `POST /v1/internal/project-experience`)
      is no generation and has no trace name: it needs a sync adapter for
      `observed_generation`, and `test_model_calls_are_traced.py` cannot see it
      (it scans `routes/` for `/chat/completions`);
    - the decision model's own eval (`decision_eval_office.py`) writes a JSON
      file, not dataset runs, so a threshold change is compared by hand;
    - the precedent eval (`suite.py --set precedent`) is no dataset, so its
      checks (looked when it should, cited, invented project, said nothing
      comparable, edition caveat) are not scores anyone can trend;
    - nothing records that a reader opened a precedent chip or a reference on
      „Ähnliche Projekte", so `SIMILARITY_WEIGHTS` cannot be learned from what
      readers use, as ADR-0094 promises. Which store (a PostHog event, a
      Langfuse score on the turn) is a product decision.
