# Observability

**Everything the product does is observable.** Langfuse is the store of record
for what the model did: every model call, agent step and quality check is a
trace or a score there ([ADR-0089](../adr/0089-langfuse-is-the-observability-platform-and-everything-is-observable.md)).
PostHog is where that joins everything else: product events, errors, logs,
replays, surveys, support and alerts, with Langfuse's traces and scores
exported into it ([ADR-0100](../adr/0100-posthog-is-the-product-platform-and-langfuse-feeds-it.md)).
This is a priority, not a nice-to-have: we improve Piloti from what these two
show, so a model call, an agent step, a quality check or a user-facing action
that neither shows counts as a defect.

| Document | Read it when |
|---|---|
| [`langfuse.md`](langfuse.md) | You are changing the product. The contract: what every trace carries, the score catalogue, what Langfuse is configured with, what your change must do |
| [`analyst-guide.md`](analyst-guide.md) | You are a business analyst or in the Fachbereich and want to read the data: access, vocabulary, which question is answered where, dashboards, the review queue |
| [`error-tracking.md`](error-tracking.md) | You want to know where an exception lands (PostHog error tracking, replacing err2issue per ADR-0100), what each runtime sends, and the volume limits |
| [`langfuse-audit-2026-10.md`](langfuse-audit-2026-10.md) | You want to know what Langfuse offers, what we use, and what is still open |
| [`posthog-events.md`](posthog-events.md) | You are adding or reading a PostHog product event: every browser and server event, its properties and the line that sends it, and the rules each follows |
| [`posthog-migration.md`](posthog-migration.md) | You are working on the PostHog switch ([ADR-0100](../adr/0100-posthog-is-the-product-platform-and-langfuse-feeds-it.md)): what goes where, the free-tier budget, the checklist only a person can do |

The deployment side (Langfuse's workloads, its access gates, retention) is
[ADR-0044](../adr/0044-langfuse-durable-llm-observability.md) and
[`deployment/kubernetes.md`](../deployment/kubernetes.md) § Langfuse. The Aspire
dashboard ([ADR-0029](../adr/0029-aspire-dashboard-telemetry.md)) is retired:
traces are read in Langfuse, WARN+ logs in PostHog, and the collector
(`deployment/kubernetes.md` §9) is what feeds both. Infrastructure metrics are
the exception that lives outside both: the collector scrapes the Qdrant peers
and re-exposes the series for a scraper the stack does not run yet, with the
alert rules beside them ([`deployment/qdrant-runbook.md`](../deployment/qdrant-runbook.md)).
