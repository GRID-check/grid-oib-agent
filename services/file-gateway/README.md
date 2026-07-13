# file-gateway

An independent service that exposes Grid project documents as a **mountable network
drive (NFSv3)** backed by the S3-compatible object store, authorizing **every file
access, per operation, against the same WorkOS FGA the web app uses**. See
[ADR-0023](../../docs/adr/0023-file-gateway-and-per-file-fga.md).

## How it fits Grid

```
architect's PC                 file-gateway (this service)                Grid
  mount -t nfs  ── NFSv3 ──▶  go-nfs ─▶ fail-closed authz guard ──HTTP──▶ BFF /api/internal/file-access
  (dumb client)                          │  (per file: view/edit)          (WorkOS FGA: project role)
                                         │
                                         ├─ decisions cached in ──▶ Dragonfly (fga: prefix, ADR-0020)
                                         └─ bytes via rclone ─────▶ object-store (S3)  org/<org>/project/<proj>/doc/<doc>/<file>
```

- **Single authz brain.** Default `GATEWAY_POLICY_MODE=bff` delegates each decision to
  the BFF's existing per-project FGA (`checkFileAccess`), so a file on the drive and in
  the web UI are authorized identically. Documents inherit project access; the
  provisioned `document` FGA type reserves per-file grants for later.
- **Shared cache.** FGA decisions are memoized in the same Dragonfly the BFF uses
  (`REDIS_URL`), namespaced `fga:` — the tenant ADR-0020 anticipated.
- **Fail-closed seam.** Ports-and-adapters: the protocol adapter routes every op
  through a narrow storage port whose mutating methods are all authorized, so a missed
  check is a compile error. Reads → `project:view`, writes → `project:edit`.

## Configuration (env)

| Var | Default | Notes |
|---|---|---|
| `GATEWAY_POLICY_MODE` | `bff` | `bff` \| `workos` |
| `GATEWAY_BFF_AUTHZ_URL` | `http://frontend:3000/api/internal/file-access` | bff mode |
| `GRID_INTERNAL_API_TOKEN` | — | shared internal token (bff mode) |
| `REDIS_URL` | — | Dragonfly shared decision cache; unset = in-process L1 only |
| `GATEWAY_IDENTITY_RESOLVER` | `dirpath` | dev-only; prod uses a signed mount token / Kerberos / SMB |
| `GATEWAY_ENV` | `dev` | non-dev refuses the `dirpath` resolver (fail-fast) |

## Run / test

```bash
# unit tests (authz engine, write path, resilience, BFF policy client)
cd services/file-gateway && make test

# standalone dev stack (mock policy + SeaweedFS) — allow/deny + write-path proof
make run && make verify

# in the Grid stack: added as the `file-gateway` service in
# deploy/compose/docker-compose.yaml (delegates to the BFF, shares Dragonfly).
```

## Honest status / follow-ups

- **Verified**: Go build + `go vet` + unit tests (incl. write-path denial, cache
  grace/fail-closed, BFF object-parse/tenancy); the `document` FGA type is provisioned
  in WorkOS **Staging**; the mount allow/deny mechanism is proven over the NFSv3 wire
  protocol via the userspace client.
- **NFSv3 only** today; **SMB (Windows-native)** is the follow-up for the primary
  architect audience.
- **Identity** is the weak link (dev `dirpath` resolver). Prod needs a BFF-issued
  signed mount token or NFSv4+Kerberos / SMB session.
- Real **kernel-mount** verification and **production compose (Coolify)** wiring
  (privileged FUSE container review) are follow-ups.
- `docs/ARCHITECTURE.md` describes the original standalone design; the Grid wiring
  above supersedes its storage/identity edges.
