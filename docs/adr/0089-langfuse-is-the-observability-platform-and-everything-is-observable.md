---
status: accepted
date: 2026-10-09
decision-makers: Platform
consulted: Product, Fachbereich
informed: everyone who ships to this repo
---

# Langfuse is the observability platform, and everything the product does is observable in it

## Context and Problem Statement

ADR-0044 deployed Langfuse as a *backend*: a durable store for the spans the
collector already had. Eight weeks later it is still used that way. People open
one trace by id to count tokens. Nobody can answer the questions the business
asks, because the data that answers them never reaches Langfuse:

* **Whether an answer was good.** The pipeline grades every turn already:
  citation verification drops what it cannot verify, the quote check patches
  misremembered wording, the dialect pass repairs blocks, cards that miss their
  schema are repaired or dropped, and the overconfidence guard caps the
  confidence. Each result went to its own sink (a BFF ledger, a wire status, a
  metadata blob). None of them was a Langfuse **score**, so none could be
  charted, compared across prompt versions or put next to the user's vote.
* **What a turn was.** The root observation was named
  `chat_deepresearcher_agent`. Its output was NAT's preview of the first fifty
  stream items, not the answer. Route, confidence, sources and outcome lived
  only in the persisted row.
* **Where, and which build.** No trace carried an environment or a release, so
  "did the deploy on Tuesday make answers worse" had no axis to plot against.
* **Everything outside a chat turn.** Six backend routes call a model directly
  (titles, project summaries, consistency check, skill review, lesson distill,
  the feedback digest), outside any NAT run. They were invisible: no span and
  no cost.
* **For anyone but platform operators.** The Langfuse route admits only
  `platform:organizations:view`, the whole operator permission, so business
  analysts and the Fachbereich could not be given read access without being
  given everything.

Two audits on the turns-per-answer and the roadmap
(`docs/architecture/turns-per-answer-audit-2026-09.md`,
`docs/roadmap/architect-workspace-voice-and-agentic-loop.md`) had to
reconstruct production behaviour by hand for the same reason. The full
inventory is in [`docs/observability/langfuse-audit-2026-10.md`](../observability/langfuse-audit-2026-10.md).

## Decision Drivers

* We improve the product from measurements. A quality signal that is not in the
  place people analyse is a signal nobody acts on.
* Business analysts and the Fachbereich are users of this data, alongside
  engineers. Customers are not.
* Self-hosted and licence-free (ADR-0044): every feature this decision relies
  on is in the MIT build of Langfuse 4.x.
* One place. Splitting quality into one tool, cost into another and traces into
  a third is how the current gaps happened.

## Considered Options

* **Langfuse as the one observability platform**, with everything instrumented
  into it and its configuration kept as code.
* Keep Langfuse as a trace store and build analytics in the platform UI.
* Product analytics (PostHog) for quality and cost, Langfuse for traces only.

## Decision Outcome

Chosen option: **Langfuse is Grid's observability platform.** Every model
call, every agent step and every quality check the product makes is observable
there, because Langfuse already has the model the questions need: traces,
sessions, scores, prompt versions, datasets, experiments, judges, annotation
queues and dashboards. Anything we would build in the platform UI instead
would be a weaker copy of one of those.

What "observable" means is a contract, not an aspiration. It is written down in
[`docs/observability/langfuse.md`](../observability/langfuse.md) and holds for
every change:

1. **Every model call is a Langfuse generation** with model, usage and cost:
   inside a NAT run through the exporter's processors, outside one through
   `aiq_agent.observability.direct_trace.observed_generation`.
2. **Every trace carries environment, release and a product name**
   (`chat-turn`, `research-job`, or the auxiliary feature), and every
   observation its Langfuse type (generation, tool, retriever, agent, chain).
3. **A chat turn's root observation is the turn**: the question in, the answer
   out, and its outcome (route, confidence, sources, citations removed) as
   metadata and low-cardinality tags.
4. **Every runtime quality check is a score** on the turn's trace, under a name
   declared once in `aiq_agent.observability.langfuse_scores.SCORE_DEFINITIONS`.
   The user's vote and its reason are scores too.
5. **Langfuse's own configuration is code.** Score configs, the review queue,
   the LLM-as-a-judge evaluators and their rule, and the golden-question
   dataset are declared in `aiq_agent.observability.langfuse_catalog` and
   provisioned with `task langfuse:provision` (check by default, `--apply`
   writes). Nothing Grid depends on is clicked together by hand.
6. **Non-operators can read it.** Langfuse's edge gate also admits
   `platform:observability:view`, which the WorkOS catalog grants on its own,
   and a first SSO login joins the project as VIEWER. Promotion happens inside
   Langfuse.
7. **The privacy switch stays narrow.** `GRID_TRACE_IDENTITY_ATTRIBUTES` gates
   only who and which tenant. Labels, counts, tool facts and scores are not
   identity and reach the trace either way.

The deployment runs the newest Langfuse release (4.56.0 at the time of
writing), and keeping it current is part of this decision: the features above
are v4 features.

### Consequences

* Good, because quality, cost and latency sit in one tool, per turn, per prompt
  version, per release, next to the user's vote.
* Good, because the Fachbereich gets a queue of every down-voted answer to
  review, and its verdicts are scores like everything else.
* Good, because a judge's prompt or a score's categories change through review,
  like code.
* Bad, because every new model call site, check or surface now has an
  instrumentation obligation. The contract tests below make that the default
  rather than a thing to remember, but it is work.
* Bad, because the 30-day trace retention (ADR-0044 Amendment 4) also bounds
  how far back Langfuse's dashboards reach. Long-term trends need the blob
  export or a rollup, and that is an open decision recorded in the audit.
* Bad, because enabling the LLM-as-a-judge rule sends answers to an evaluation
  model and costs money per sampled turn. The rule is provisioned disabled and
  enabling it is a person's call, after checking the model's data policy
  (ADR-0074).
* Neutral: scores are posted from the agent through the Langfuse public API,
  so the backend pods now hold the project key pair and a NetworkPolicy to the
  web tier, as the BFF and the workers already did.

### Confirmation

* `tests/aiq_agent/observability/test_trace_context.py` pins environment,
  release, observation types, trace names, the tag merge and that the
  processor is installed whatever the identity flag says, ahead of redaction.
* `tests/aiq_agent/observability/test_turn_outcome.py` pins what a turn's root
  carries.
* `tests/aiq_agent/observability/test_langfuse_scores.py` pins the score
  builders, and that every score name is declared once, written by the BFF only
  if declared, and documented in `docs/observability/langfuse.md`.
* `frontends/aiq_api/tests/test_model_calls_are_traced.py` fails when a route
  posts a chat completion outside `observed_generation`.
* `tests/test_langfuse_provision.py` pins the catalog against the score
  definitions and Langfuse's own filter schema.
* The obligation row in `AGENTS.md` ("Add a model call, a quality check or a
  surface") names the contract for review.

Not enforced yet: model calls outside `frontends/aiq_api/.../routes/` that run
outside a NAT run (the feedback digest's cause labelling,
`aiq_agent.common.feedback_causes`) are found by reading, not by a test. The
audit lists them.

## Pros and Cons of the Options

### Keep Langfuse as a trace store, build analytics in the platform UI

* Good, because the platform page (Antwortqualität) exists and analysts know it.
* Bad, because it would rebuild sessions, score analytics, prompt-version
  comparison and dashboards, which Langfuse has.
* Bad, because it cannot see inside a turn. The page reads the persisted row,
  not the trace.

### PostHog for quality and cost, Langfuse for traces

* Good, because PostHog is already in the browser and has cohorts and funnels.
* Bad, because the checks run server-side, inside a turn, and PostHog has no
  model of a generation, a prompt version or a score.
* Neutral: Langfuse has a free PostHog integration. If product analytics needs
  quality next to behaviour, that integration is the way, not a second store.

## More Information

* Revisit if Langfuse's licence moves a feature this decision relies on
  (scores, queues, evaluators, dashboards, blob export) behind the Enterprise
  key, or if self-hosting it stops being affordable.
* The contract and the score catalogue:
  [`docs/observability/langfuse.md`](../observability/langfuse.md).
* For analysts and the Fachbereich:
  [`docs/observability/analyst-guide.md`](../observability/analyst-guide.md).
* The audit behind this, with the open follow-ups:
  [`docs/observability/langfuse-audit-2026-10.md`](../observability/langfuse-audit-2026-10.md).
* ADR-0044 stays the deployment decision; this one is about use.
