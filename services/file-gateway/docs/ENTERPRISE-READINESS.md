# File-gateway — enterprise-readiness triage

A multi-lens review (ingest/lifecycle, type-safety, reliability/security, observability/testing)
of the first cut, with each finding's status. **Fixed** items are in this PR; **Open**
items are the remaining roadmap, ordered by severity.

## Blockers

| # | Finding | Status |
|---|---|---|
| B1 | Gateway sent `Authorization: Bearer` but Grid internal routes read `x-grid-internal-token` → every check 403 → **drive was deny-all in the default `bff` mode**. `bff_test` encoded the wrong header, so it passed green. | **Fixed** — header corrected (`policy/bff.go`); non-200 now surfaces as an *error* (fail-closed **with a signal**), not a silent deny; test rewritten to guard the real header + add a real-route integration test (Open). |
| B2 | Prod can't boot: `config.Validate` accepted `mounttoken/kerberos/smb` but `buildResolver` implements none. | **Fixed, then superseded** — the NFS front (and its resolver seam) was removed when WebDAV became the drive (ADR-0025); the same lockstep rule now guards `Validate` ↔ `buildWebDAVResolver` (`header`/`basic`), with a config-matrix test. |

## High

| # | Finding | Status |
|---|---|---|
| H2 | `Subject.OrgID` was dropped at the `policy.Client` string boundary → the advertised mount-tenancy hard-deny was **dead code** (a user in orgs A+B could mount as A and read `org/<B>/…`). | **Fixed** — `policy.Client` now takes a typed `policy.Subject{ID,OrgID}`; tenancy enforced in `bff.checkOne`; OrgID+Env folded into both cache keys. Test added. |
| H3 | No production identity: NFSv3 `AUTH_NULL` + `dirpath` is fully spoofable; anyone reaching :2049 can `mount /<anyOrg>/<anyUser>`. | **Fixed (ADR-0025)** — and the spoofable front is gone: the NFSv3 adapter was removed from the PR (it cannot carry a credential; it lives in git history for an NFSv4+Kerberos revival). The drive is WebDAV with SSO-brokered device credentials — minted only inside a WorkOS-SSO'd web session (`/api/drive/credentials`, sha256-stored, TTL'd, revocable, audited), verified by the gateway's Basic resolver against `/api/internal/mount-auth` (fail-closed; 401+`Basic` challenge pops the native OS dialog; verifier outage → 503, no re-prompt). Per-op FGA keeps authorization live, so revocation/role-loss cuts a mounted drive instantly. `GATEWAY_WEBDAV_IDENTITY=basic` is required outside dev; TLS at the ingress is a deployment invariant. |
| H4 | Gateway cache key (`fga:<subj>|<rel>|<obj>`) ≠ BFF invalidation key (`fga:<membership>:project:<proj>:`) → revocation never cleared the gateway cache (≤ `SharedCacheTTL` stale-allow even when healthy). | **Fixed** — the gateway runs no Dragonfly L2 at all: the BFF already memoizes AND invalidates in the shared cache, so a second, divergently-keyed copy is gone (the `workos` direct policy mode that used one was removed with it — the BFF is the single authz source). Post-revocation staleness is just the gateway's short in-process L1 (~2s), not 30s. |
| BFF-1 | **Drive was non-functional in the default `bff` mode:** files live at `org/<org>/project/<proj>/…`; go-nfs `Lstat`s each ancestor, but `parseObject` blanket-denied anything shorter than a full project path → traversal denied at the first component. CI missed it (e2e used mock mode + a shorter layout with ancestor inheritance). | **Fixed** — bff mode now allows VIEWER traversal of the `org` / `org/<org>` / `org/<org>/project` scaffolding **within the caller's own org** (no cross-tenant existence leak), so the client can descend to a project where the real check runs. Regression test added. |
| ING | **Async ingest on drive upload is missing** and the whole ingest path is non-durable: `dispatchIngest` is fire-and-forget (Python down at upload → permanent `failed`, manual re-ingest only); the Python job store is in-memory (restart loses jobs). | **Open — designed, next PR.** ADR-0024 decides the mechanism: a periodic **list-and-diff reconciler** (S3 → `documents` → vectors; generalizing `oib_sync.py` as a purger-family claimed worker) is the primary, durable, self-healing ingest+deletion path for BOTH web and drive uploads. An earlier per-event seam (`commitUploadedFile` + `/api/internal/commit-upload`) and a pure diff core (`reconcile-plan.ts`) were built, then deliberately pulled from this PR: the seam is superseded by the reconciler, and the diff core ships with the worker that executes it. |

| CMPL | **Drive `rm` bypassed legal holds and left embeddings** — `Guard.Remove` did a raw S3 delete after the Editor check and nothing else: no `legal_holds` check (bytes destroyable under hold — a compliance/GDPR failure), no embedding removal, orphaned row. | **Fixed (synchronous half).** `Guard.Remove` now consults a `storage.HoldChecker` after authz; the BFF `POST /api/internal/file-deletable` (backed by `isDeletionUnderHold`, mirroring the purger's org/project/document predicate) gates it, **fail-closed** (unreachable BFF ⇒ delete refused). Held ⇒ `ErrLegalHold` (wraps `os.ErrPermission`), backend never touched. Tests on both sides. **Open:** embedding + row cleanup for an *allowed* delete rides the reconciler's "disappeared" branch → `document` purger + `ingestor.delete_file` (ADR-0024 §3). |

## Medium (enterprise-bar follow-ups)

| # | Finding | Status |
|---|---|---|
| M6 | Presigned URLs are unauthenticated bearer capabilities, not re-checked for their TTL (600s download / **3600s** preview); the web surface is unchanged. | **Open** — proxy download/preview through an authenticated route that re-checks FGA per fetch; at minimum align preview TTL to download and never log signed URLs. |
| M7 | `GRID_INTERNAL_API_TOKEN` is a shared static secret with a well-known dev default; the gateway (unlike the BFF) didn't refuse it outside dev. | **Partially fixed** — gateway now refuses the dev default when `Env != dev`; **Open**: per-service tokens / mTLS + rotation. |
| M8 | FUSE requires `SYS_ADMIN` + `apparmor:unconfined` (root-equivalent) on the shared network. | **Open** — ship the native `aws-sdk-go-v2` S3 backend (already behind `storage.Backend`) to drop FUSE before prod; meanwhile drop `apparmor:unconfined` / sidecar the mount. |
| M9 | Upload is S3-then-DB non-atomic with no idempotency (orphaned objects on insert failure; retries duplicate). | **Open** — idempotency key `(projectId, canonicalPath)` upsert; compensating cleanup; row+enqueue in one txn (part of the ingest work). |
| M10 | No rate limiting / large-file bounds; `bff.BatchCheck` was serial (N round-trips per `ls`). | **Partially fixed** — `BatchCheck` is now bounded-concurrent (8); **Open**: a real batch endpoint, per-subject rate/concurrency limits, VFS cache/size bounds. |

## Type-safety (the t3 bar)

| # | Finding | Status |
|---|---|---|
| T3 | Permission list hand-duplicated in 3 places (TS union, route Zod enum, Go). | **Fixed** — `PROJECT_PERMISSIONS as const` SoT; route derives the enum; a checked-in `testdata/file-access-contract.json` + Go `contract_test.go` pin the Go structs and fail CI on drift. |
| T4 | Route response had no schema; Go decoded blindly. | **Fixed** — explicit `responseSchema.parse(...)`. |
| T6 | Loose id validation (`min(1)`). | **Fixed** — `^user_…`, `^org_…`, `.uuid()` at the edge. |
| T8 | `parseObject` accepted empty org/project segments. | **Fixed** — rejects empty segments. |
| T9 | Unchecked `interface{}` assertion on the singleflight return. | **Fixed** — comma-ok, fail-closed on unexpected type. |
| T7 | `mock` policy mode dead + uses a stale object layout. | **Resolved** — the `mock` *mode* is gone from config entirely (the BFF is the only policy source); `policy.NewMock` remains strictly a unit-test fixture for the engine tests. |
| T11/T12 | Branded ids (`OrgId`/`ProjectId`…); `as never` casts in specs. | **Open** — low-risk hardening. |

## Observability / testing / ops

| # | Finding | Status |
|---|---|---|
| O2 | **Go tests never ran in CI** (`services/**` not in the paths filter). | **Fixed** — a `file-gateway` job (`go vet`/`build`/`test`) gated on `services/file-gateway/**`, added to `ci-ok`. |
| O3 | No trace/correlation id across gateway→BFF→agent. | **Open** — generate a request id per file-op, propagate as a header, log in audit + BFF route. |
| O4/O5 | RED metrics cover only authz; file-op/BFF/cache latencies uninstrumented; deny-vs-outage conflated on the same labels. | **Open** — `file_op_duration_seconds{op}` + errors in the guard, `bff_request_duration_seconds`, `cache_ops_total{layer,result}`, and an outcome/error label to separate denial spikes from outages. |
| O6/O7 | `/readyz` ignores BFF + Dragonfly; compose service has no healthcheck. | **Open.** |
| O-test | `guard.go` (the choke point), the BFF route guard, and a gateway↔BFF integration test are untested; the `make verify` harness isn't in CI. | **Open** — highest-value remaining tests. |

## Async ingest plan (the headline follow-up)

Superseded by **ADR-0024**: the per-event plan that used to live here (ingest
queue + `commitDocument` seam + `commit-upload` route + gateway commit-detector)
is replaced by a periodic **list-and-diff reconciler** (S3 → `documents` →
vectors) run as a purger-family claimed worker — one durable, self-healing
convergence path for web + drive + API uploads AND the async half of drive
deletion (embeddings via `ingestor.delete_file`, rows via a `document` purger).
The pure diff core (`reconcile-plan`: name filter, quiescence, ETag
change-detection, deletion grace, pipeline backstop — exhaustively unit-tested)
was prototyped on this branch and deliberately deferred to ship WITH the worker
that executes it; see ADR-0024 "Follow-ups" for the build list.
