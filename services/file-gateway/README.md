# file-gateway

An independent service that exposes Grid project documents as a **mountable
network drive (WebDAV)** backed by the S3-compatible object store, authorizing
**every file access, per operation, against the same WorkOS FGA the web app
uses**. Mount identity is an **SSO-brokered device credential** created in the
web app. See [ADR-0023](../../docs/adr/0023-file-gateway-and-per-file-fga.md)
and [ADR-0025](../../docs/adr/0025-mount-identity-sso-brokered-device-credentials.md);
user how-to in [docs/MOUNTING.md](docs/MOUNTING.md).

## How it fits Grid

```
user's Mac/PC                    file-gateway (this service)                  Grid
 Finder ⌘K /      ── WebDAV ──▶  Basic resolver ──HTTP──▶ BFF /api/internal/mount-auth
 Map network drive   (HTTPS)          │                    (SSO-minted device credential)
 (built-in client)                    ▼
                                 fail-closed authz guard ──HTTP──▶ BFF /api/internal/file-access
                                      │  (per file: view/edit)     (WorkOS FGA: project role)
                                      │  deletes also gated by ──▶ BFF /api/internal/file-deletable (legal holds)
                                      └─ bytes via rclone ───────▶ object-store (S3)
                                         org/<org>/project/<proj>/doc/<doc>/<file>
```

- **Single authz brain.** Every decision delegates to the BFF's existing
  per-project FGA (`checkFileAccess`), so a file on the drive and in the web UI
  are authorized identically. Documents inherit project access; the provisioned
  `document` FGA type reserves per-file grants for later.
- **SSO-brokered identity (ADR-0025).** Native mount dialogs can't run an OIDC
  flow, so the user mints a device credential inside their WorkOS-SSO'd web
  session and types it once into the OS dialog. The credential only
  authenticates — per-op FGA keeps authorization live, so role loss or
  revocation cuts a mounted drive within seconds.
- **Fail-closed seam.** Ports-and-adapters: the protocol adapter routes every op
  through a narrow storage port whose mutating methods are all authorized, so a
  missed check is a compile error. Reads → `project:view`, writes →
  `project:edit`; deletes additionally pass a synchronous legal-hold gate.

## Configuration (env)

| Var | Default | Notes |
|---|---|---|
| `GATEWAY_WEBDAV_LISTEN` | `:8090` | the drive front |
| `GATEWAY_WEBDAV_IDENTITY` | `header` | `header` (dev-only) \| `basic` (prod: device credentials; TLS at ingress required) |
| `GATEWAY_BFF_AUTHZ_URL` | `…/api/internal/file-access` | per-op authorization |
| `GATEWAY_BFF_DELETABLE_URL` | `…/api/internal/file-deletable` | legal-hold gate for deletes |
| `GATEWAY_BFF_MOUNT_AUTH_URL` | `…/api/internal/mount-auth` | device-credential verification |
| `GRID_INTERNAL_API_TOKEN` | — | shared internal token (dev default refused outside dev) |
| `GATEWAY_ENV` | `dev` | non-dev refuses the `header` resolver (fail-fast) |

## Run / test

```bash
# unit tests (authz engine, guard incl. legal holds, WebDAV fs/handler/basic,
# BFF policy client, config matrix)
cd services/file-gateway && make verify

# in the Grid stack: the `file-gateway` service in
# deploy/compose/docker-compose.yaml (delegates to the BFF).
```

## Honest status / follow-ups

- **Verified**: `go vet` + build + unit tests (write-path denial, cache
  grace/fail-closed, BFF object-parse/tenancy, legal-hold block, Basic-resolver
  caching + 401/503 semantics, config matrix); the `document` FGA type is
  provisioned in WorkOS **Staging**.
- **FUSE**: bytes go through an rclone mount, which needs `SYS_ADMIN` — the
  native `aws-sdk-go-v2` backend behind `storage.Backend` is the tracked fix.
- **Windows-native SMB** (Kerberos/Entra, zero-prompt on managed fleets) and an
  NFS front (needs NFSv4+Kerberos identity — an earlier NFSv3 adapter lives in
  git history) are future protocol adapters behind the same Guard (ADR-0024).
- Full ledger: [docs/ENTERPRISE-READINESS.md](docs/ENTERPRISE-READINESS.md).
- `docs/ARCHITECTURE.md` records the original (NFS-first) productionization
  design; ADR-0025 supersedes its identity edge, this README its wiring.
