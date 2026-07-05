# ADR-0008: Project & Organization Memory (agent-authored, single-writer)

- **Status:** Accepted
- **Date:** 2026-07-05
- **Deciders:** Grid Agent team
- **Related:** [ADR-0003](0003-nextjs-bff-and-stateless-python-agent.md), [`../architecture/project-memory-design.md`](../architecture/project-memory-design.md)

## Context

A project accretes knowledge across many conversations — decisions made,
constraints found, open questions — but that knowledge previously lived only in
per-conversation history (siloed) or the static intake profile. The agent
re-learned the same things every session, and nothing carried org-wide
conventions across a firm's projects.

The backend is deliberately stateless (ADR-0003) and must not become a writer of
tenant data. But memory is inherently agent-authored: the model is what notices a
durable finding worth keeping.

## Decision

We will add a **memory** layer scoped to a project and, separately, to an
organization:

- Memory is **itemized rows** (`project_memory`) with provenance, confidence,
  verification, and status — not an append-only blob — so items can be
  superseded, pinned, curated, and graduated.
- Capture is **silent but observable**: the agent records findings via a
  `remember` tool (surfaced in traces), and users view/edit/confirm/delete them on
  the project page.
- A bounded **digest** of active items is injected into every turn as the
  `x-grid-project-memory` header (never embedded, never a citation source).
- **The BFF is the sole writer.** The backend's `remember` tool does not open a
  `grid_app` connection; it calls a token-guarded internal BFF endpoint. The
  single-writer rule (ADR-0003) is preserved through an HTTP boundary.

## Consequences

### Positive
- Conversations start from what Grid already knows about the project.
- Tenant-data ownership stays entirely in the BFF; the agent stays stateless.
- Org-wide memory captures firm conventions without duplicating per project.

### Negative
- An extra write path (internal API) and an injected-context budget to manage.

### Risks
- Memory poisoning / prompt-injection via stored content — mitigated by
  digest quoting/escaping, provenance tags, and the never-cite-unverified rule.
- Cross-org leakage — mitigated by `organization_id` scoping on every query.

## Alternatives Considered
- **Give the backend a DB connection to write memory** — rejected; breaks the
  single-writer boundary and spreads tenant-data ownership.
- **Embed memory into the vector store** — rejected for Phase 1; memory is small,
  curated, and always-relevant, so injection beats retrieval (RAG recall is a
  designed Phase-2 option).

## Open Questions / Follow-ups
- Permission-gate org-wide memory writes to admins.
- Consolidation/dedup gate and optional RAG recall (Phase 2).

## References
- [`../architecture/project-memory-design.md`](../architecture/project-memory-design.md)
