# AI-Q research findings — master index

This directory holds raw research output produced by subagents investigating the AI-Q
worktree. The goal is to capture what we learned, where we learned it, and what it means
for Grid's design before we write implementation specs.

Each sub-directory corresponds to a subsystem:

- `auth/` — identity, authentication, WorkOS fit.
- `conversations/` — how conversations are persisted and what to reuse.
- `documents/` — upload, ingestion, and durable storage gaps.
- `knowledge/` — retrieval, collection scoping, and access policy.

---

## Findings summary

### Auth (`docs/aiq/auth/workos-and-aiq-auth.md`)

- AI-Q auth is provider-agnostic ASGI middleware + a generic `JWTValidator`.
- It can verify WorkOS access tokens via JWKS, but it has no concept of WorkOS orgs,
  memberships, roles, or Grid projects.
- Next.js BFF must own WorkOS session, org resolution, project authorization, and derived
  scope. The Python agent verifies the forwarded JWT and trusts the BFF for scope.

### Conversations (`docs/aiq/conversations/persistence.md`, `reuse-assessment.md`)

- Today: frontend `localStorage` only; server-side graph state in LangGraph checkpoints.
- Reuse: WebSocket handler/registry, NAT message schema, FastAPI plugin pattern,
  LangGraph checkpoints for graph state.
- Build new: `conversations` and `messages` tables in `grid_app`, CRUD service, REST
  routes, WebSocket history load, Zustand server-fetch action.

### Documents (`docs/aiq/documents/upload-and-ingestion.md`)

- Today: client mints `s_<uuid>` collection name, uploads to temp files, embedding deletes
  originals, only chunks survive.
- Gaps: no durable bytes, no ownership record, no access control.
- Target: MinIO for bytes, Postgres `documents` table for metadata, server-authoritative
  collection naming, BFF-driven upload/ingest flow.

### Knowledge (`docs/aiq/knowledge/retrieval-and-scoping.md`)

- Today: `knowledge_retrieval` fans out across base + session + project collections and
  merges by cosine score.
- Session collections (`s_` prefix) are TTL-reaped; base/project collections persist.
- Target: BFF computes `collection_scope[]` from authorized context and passes it to the
  agent; never trust client collection names.

---

## How these feed the spec

These research docs are the evidence for the target design in
`docs/architecture/multitenancy-and-auth-spec.md`. Any implementation plan must account
for both the reuse verdicts above and the gaps that require new code.

When implementation begins, each subsystem doc should be updated or superseded by a
matching implementation note that reflects the actual code.
