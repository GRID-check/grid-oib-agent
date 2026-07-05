# ADR-0006: Knowledge collection scoping

- **Status:** Accepted
- **Date:** 2026-06-30
- **Deciders:** Grid Agent team
- **Related:** [ADR-0003](0003-nextjs-bff-and-stateless-python-agent.md), [ADR-0004](0004-tenancy-ownership-and-access-model.md), [ADR-0005](0005-object-storage-for-documents-minio.md), [`../architecture/multitenancy-and-auth-spec.md`](../architecture/multitenancy-and-auth-spec.md)

## Context

Collection names were **client-generated** `conversation_id`s (`s_<uuid>`) used as
the **sole** isolation key — unsafe for a multi-tenant product, since a client could
name any collection.

The native `knowledge_retrieval` already supports **layered retrieval**: it fans out
across collections and merges by score, with flags `include_base_collection`,
`include_session_collection`, and `project_collections`. The TTL reaper only reaps
`s_`-prefixed collections.

```mermaid
flowchart TD
  Q[infer query] --> BFF[Next.js BFF\ncomputes collection_scope[]]
  BFF --> PY[Python AI-Q\nlayered retrieval]
  PY --> Base[(oib_knowledge\nbase / read-only)]
  PY --> Proj[(proj_<projectId>\npersistent)]
  PY --> Conv[(conv_<conversationId>\nephemeral, TTL)]
  PY --> UserC[(user_<userId>\noptional private)]
```

## Decision

We will make collection names **server-authoritative** (assigned by the BFF), with
the following scheme:

- **Base / global OIB corpus** = `oib_knowledge` — read-only, always layered in.
- **Project corpus** = `proj_<projectId>` — persistent, shared by project members.
- **Ephemeral conversation uploads** = `conv_<conversationId>` (or keep the `s_`
  prefix so the TTL reaper still reaps it).
- **Optional private** = `user_<userId>`.

The BFF computes **`collection_scope[]`** from the authorized context (see
[ADR-0004](0004-tenancy-ownership-and-access-model.md)) and passes it to `infer()`.
The TTL reaper reaps only **ephemeral** collections; base and project corpora
persist.

## Consequences

### Positive

- Safe multi-tenant retrieval — clients cannot choose collections.
- Durable project corpora plus an always-on base corpus, via layered retrieval.
- Ephemeral session uploads still auto-clean.

### Negative

- The BFF must own and enforce naming authority.

### Risks

- Collection-name authority **must** live in the BFF; any client-supplied name is
  untrusted.
- Retention policy must be defined **per scope** (base/project/ephemeral/private).

## Alternatives Considered

- **Single collection per tenant** — rejected; loses the base corpus and layering.
- **Trust client ids** — rejected; insecure (the original problem).

## Open Questions / Follow-ups

- Decide whether to keep the `s_` prefix or adopt `conv_` (and update the reaper).
- Define TTLs and retention per scope.

## References

- [`../architecture/multitenancy-and-auth-spec.md`](../architecture/multitenancy-and-auth-spec.md)
