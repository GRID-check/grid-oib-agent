# ADR-0023: File-gateway service (mounted drive) and per-file FGA

- **Status:** Proposed
- **Date:** 2026-07-13
- **Deciders:** Grid Agent team
- **Related:** [ADR-0002](0002-outsource-identity-to-workos.md), [ADR-0004](0004-tenancy-ownership-and-access-model.md), [ADR-0005](0005-object-storage-for-documents-minio.md), [ADR-0020](0020-dragonfly-shared-cache.md), [`../roadmap/collaborative-workspace-vision.md`](../roadmap/collaborative-workspace-vision.md)

## Context

Documents live in S3-compatible object storage keyed
`org/<orgId>/project/<projectId>/.../doc/<docId>/<filename>` (ADR-0005). Access is
authorized in the BFF via per-project WorkOS FGA (`requireProjectAccess`) and then a
short-lived **presigned URL** is minted. Two gaps motivated this ADR:

1. **No mounted-drive access.** Architects want their project files to appear as a
   network drive on their PC (no browser, no plugin), while still only seeing files
   their WorkOS role allows. There is no OS-filesystem surface today.
2. **Presigned URLs are unauthenticated bearer capabilities.** Once minted they are
   valid for their whole TTL (600s download / 3600s preview) and are **not
   re-checked** at fetch time — access is decided only at mint time.

`collaborative-workspace-vision.md` argued against a *file-first product* competing
with Dropbox, and against duplicating the authorization brain. Both concerns are
honored below: this is an internal serving/mount surface (not a file product), and it
**delegates every decision to the BFF's existing FGA** rather than re-implementing it.

## Decision

Introduce **`services/file-gateway/`** — an independent service that exposes project
documents as a **mountable network drive (NFSv3 today)** backed by the same S3 store,
and **authorizes every file operation, per access, against the same WorkOS FGA the web
app uses**.

- **Single authz brain.** The gateway does not talk to WorkOS FGA directly by default.
  It calls a new internal BFF endpoint `POST /api/internal/file-access`
  (`GRID_INTERNAL_API_TOKEN`-guarded) which runs the existing per-project FGA check.
  A file on the drive and the same file in the web UI are authorized identically.
- **Per-file model, project inheritance.** A `document` FGA resource type (child of
  `project`) is provisioned in WorkOS (see
  [`../deployment/workos-fga-provisioning.md`](../deployment/workos-fga-provisioning.md)).
  Documents **inherit** project access by default (a viewer on the project may view its
  files); the `document` type reserves **per-file grants** (roadmap "per-file review
  roles") for a later step without a migration.
- **Fail-closed, narrow seam.** The gateway is ports-and-adapters: protocol adapters
  depend on a narrow storage port whose every mutating method is authorized, so a
  missed check is a compile error, not a silent bypass. Reads require `project:view`;
  writes require `project:edit`.
- **Shared decision cache.** FGA decisions are memoized in **Dragonfly** (ADR-0020,
  which explicitly anticipated "FGA check memoization"), namespaced `fga:`. The BFF
  check is now cached too (`@/lib/authz/file-access`), fixing the previously-uncached
  WorkOS round-trip(s) on every project-scoped request. Role changes invalidate the
  `fga:<membership>:project:<project>:` prefix.

The gateway closes gap (2) for the drive surface because access is checked on **every**
open/read/write, not once at URL-mint time.

## Consequences

### Positive

- Mounted-drive UX with server-side, per-file authorization — the client stays dumb.
- One authorization model across web + drive; no duplicated policy logic.
- Faster project-scoped requests (cached FGA) and a survivable dependency (grace
  window on a brief WorkOS/BFF outage instead of a hard down).

### Negative / Risks

- **Identity mapping is the weak link.** NFSv3 `AUTH_SYS` is client-asserted. The dev
  resolver maps the export path to a user+org; production must use a **signed mount
  token** (BFF-issued) or **NFSv4+Kerberos / SMB session** for authenticated identity.
  Config fails closed: the dev resolver refuses to start when `GATEWAY_ENV != dev`.
- **Windows.** Windows mounts SMB natively; NFS is a second-class client there. An
  SMB front (Samba) is the documented follow-up for the primary architect audience.
- **Cache staleness.** Bounded by TTL + explicit invalidation; a webhook from WorkOS
  on warrant changes is the tightening follow-up.

## Alternatives Considered

- **Per-file logic inside the BFF only (no service)** — good for the web app, but does
  not deliver a mountable drive. Adopted for the web path (the internal endpoint +
  cache live in the BFF); the gateway adds the mount surface on top.
- **Gateway calls WorkOS FGA directly** — duplicates org-membership resolution and the
  policy model in a second language. Rejected as default; retained as an optional
  `workos` policy mode for deployments without the BFF on the path.
- **Sign shorter-lived presigned URLs only** — narrows but does not close the
  fetch-time re-check gap, and gives no mount surface.

## Open Questions / Follow-ups

- Signed mount-token issuance in the BFF; SMB/NFSv4+Kerberos identity front.
- Per-file grant UI + `document`-resource role assignment on upload/delete.
- Migrate the BFF's own download/preview to re-check at fetch (or proxy) to close gap
  (2) for the web surface too.

## References

- `services/file-gateway/README.md`, `services/file-gateway/docs/ARCHITECTURE.md`
- [`../deployment/workos-fga-provisioning.md`](../deployment/workos-fga-provisioning.md)
