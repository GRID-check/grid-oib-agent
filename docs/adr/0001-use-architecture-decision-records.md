# ADR-0001: Use Architecture Decision Records

- **Status:** Accepted
- **Date:** 2026-06-30
- **Deciders:** Grid Agent team
- **Related:** [`README.md`](README.md), [`../architecture/multitenancy-and-auth-spec.md`](../architecture/multitenancy-and-auth-spec.md)

## Context

Grid is a small team rapidly evolving a product built on a third-party template
(AI-Q). As we reshape the template into a multi-tenant B2B product, we make
architecturally significant decisions — new services, datastores, external
dependencies, auth/tenancy/security models, data-model changes, and cross-cutting
patterns — that are costly to reverse.

Without a durable record, the rationale behind these decisions lives only in chat
threads and people's heads. That makes onboarding slow, invites re-litigating
settled questions, and loses the "why" once the original author moves on. We need a
lightweight, low-overhead way to capture decisions and their context next to the
code.

## Decision

We will record architecturally significant decisions as numbered **Architecture
Decision Records (ADRs)** in `docs/adr/`, using
[`0000-template.md`](0000-template.md).

- ADRs are numbered sequentially (`NNNN-short-kebab-title.md`).
- The lifecycle is **Proposed → Accepted → (Superseded by ADR-XXXX)**.
- ADRs are immutable once Accepted; we supersede rather than rewrite.
- The process, status legend, and index live in [`README.md`](README.md).

We follow the lightweight [Michael Nygard ADR pattern](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).

## Consequences

### Positive

- Shared context and a durable rationale trail for important decisions.
- Easier onboarding: new contributors can read the "why", not just the code.
- A clear, low-ceremony place to propose and debate significant changes.

### Negative

- Slight overhead per significant decision (writing and reviewing the ADR).

### Risks

- ADRs drift out of date if not superseded properly — mitigated by the immutability
  rule and the `Superseded by` status.
- The team forgets to write them — mitigated by an explicit rule in `AGENTS.md`.

## Alternatives Considered

- **No formal record (status quo)** — rejected; loses rationale and slows onboarding.
- **A single growing `DECISIONS.md` file** — rejected; harder to cross-link, review,
  and supersede than discrete numbered files.
- **A heavyweight RFC process** — rejected; too much ceremony for a small team.

## Open Questions / Follow-ups

- None at this time.

## References

- Michael Nygard, "Documenting Architecture Decisions": https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions
- [`README.md`](README.md) — ADR index and process.
