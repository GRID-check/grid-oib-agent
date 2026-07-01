# Architecture Decision Records

This directory holds the **Architecture Decision Records (ADRs)** for the Grid Agent
project. An ADR captures a single architecturally significant decision together with
its context, the decision itself, and its consequences, so the rationale survives
team and template churn.

We follow the lightweight [Michael Nygard ADR pattern](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).

## Why ADRs

Grid is a small team rapidly evolving a product built on a third-party template
(AI-Q). Decisions that are costly to reverse — new services, datastores, external
dependencies, auth/tenancy/security models, data-model changes, cross-cutting
patterns, or anything that changes a public contract — need a durable rationale
trail. ADRs give us shared context and make onboarding easier.

## Process

1. Copy [`0000-template.md`](0000-template.md) to a new file.
2. Number it sequentially: `NNNN-short-kebab-title.md` (e.g. `0008-...`).
3. Fill in the metadata block and sections.
4. Open it with status **Proposed**.
5. Once the team agrees, change the status to **Accepted** (and update the `Date`).
6. If a later ADR replaces this one, set the status to **Superseded by ADR-XXXX**
   and add a back-link from the new ADR via the `Related` field.

ADRs are immutable once Accepted: instead of rewriting a decision, supersede it with
a new ADR. Small clarifications and typo fixes are fine.

## Status legend

| Status | Meaning |
|--------|---------|
| **Proposed** | Drafted and under discussion; not yet agreed. |
| **Accepted** | Agreed and in effect. |
| **Superseded by ADR-XXXX** | Replaced by a later decision; kept for history. |
| **Deprecated** | No longer relevant, but not directly replaced. |

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-use-architecture-decision-records.md) | Use Architecture Decision Records | Accepted |
| [0002](0002-outsource-identity-to-workos.md) | Outsource identity to WorkOS | Proposed |
| [0003](0003-nextjs-bff-and-stateless-python-agent.md) | Next.js BFF + stateless Python agent | Proposed |
| [0004](0004-tenancy-ownership-and-access-model.md) | Tenancy, ownership & access model | Proposed |
| [0005](0005-object-storage-for-documents-minio.md) | Object storage for documents (MinIO) | Proposed |
| [0006](0006-knowledge-collection-scoping.md) | Knowledge collection scoping | Proposed |
| [0007](0007-no-local-identity-sync.md) | No local identity sync | Proposed |

## Related documents

- Main design spec: [`../architecture/multitenancy-and-auth-spec.md`](../architecture/multitenancy-and-auth-spec.md)
