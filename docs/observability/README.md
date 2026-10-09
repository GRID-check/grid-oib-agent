# Observability

**Langfuse is Grid's observability platform, and everything the product does
is observable in it** ([ADR-0089](../adr/0089-langfuse-is-the-observability-platform-and-everything-is-observable.md)).
This is a priority, not a nice-to-have: we improve Piloti from what Langfuse
shows, so a model call, an agent step or a quality check that Langfuse does not
show counts as a defect.

| Document | Read it when |
|---|---|
| [`langfuse.md`](langfuse.md) | You are changing the product. The contract: what every trace carries, the score catalogue, what Langfuse is configured with, what your change must do |
| [`analyst-guide.md`](analyst-guide.md) | You are a business analyst or in the Fachbereich and want to read the data: access, vocabulary, which question is answered where, dashboards, the review queue |
| [`langfuse-audit-2026-10.md`](langfuse-audit-2026-10.md) | You want to know what Langfuse offers, what we use, and what is still open |

The deployment side (Langfuse's workloads, its access gates, retention) is
[ADR-0044](../adr/0044-langfuse-durable-llm-observability.md) and
[`deployment/kubernetes.md`](../deployment/kubernetes.md) § Langfuse. The live
operator pane for "what is the system doing right now" stays the Aspire
dashboard ([ADR-0029](../adr/0029-aspire-dashboard-telemetry.md)).
