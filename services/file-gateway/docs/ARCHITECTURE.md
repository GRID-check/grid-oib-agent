# GRID NAS Gateway — Production Architecture

**Status:** Proposed
**Date:** 2026-07-13
**Scope:** Turn the validated PoC (`go-nfs` + authz decorator + rclone→S3) into a solid, single-responsibility Go microservice: **`grid-nas-gateway`** — a file-protocol front for S3-compatible storage that authorizes every file operation, per access, against WorkOS FGA.

This document assumes the PoC's core thesis is settled and correct: no off-the-shelf product does per-file external-policy authz, and the right shape is a thin authz seam between an off-the-shelf protocol server and an off-the-shelf S3 substrate. What follows is only about production-hardening that shape.

> **Implementation status (phase 1 complete):** the code in this repository realizes §0–§3 and the phase-1 items of §4–§5. See `README.md` for the ADR→code map and the end-to-end proof that the write path is now gated.

---

## 0. The finding that reshapes the design (read first)

The PoC's `authzFS` enforces security by **overriding selected methods of a wide interface** (`billy.Filesystem`, ~15 methods) and inheriting the rest from the embedded base. It overrides the read/stat/list/setattr methods. It does **not** override `Create`, `Remove`, `Rename`, `MkdirAll`, `Symlink`, `TempFile` — those fall through to the base filesystem **ungated**. go-nfs maps `CREATE`/`REMOVE`/`RENAME` RPCs onto exactly those methods, so the write path is currently unauthorized.

This is not just a missing check to patch — it's a structural hazard: **a wide, deny-by-override interface fails open.** Every future upstream `billy` method, every refactor, is a potential silent bypass.

**Design consequence (the spine of this whole document):** the gateway's core must depend on a **narrow storage port** it defines itself — 6–8 methods, each an explicit authorization boundary — not on `billy.Filesystem` directly. `billy` becomes an implementation detail behind an adapter. A missed authorization then becomes a *compilation error* (unimplemented interface method), not a runtime hole. This is the single most important change from PoC to product.

---

## 1. Target shape: ports & adapters

One process, one job, with the authorization core at the center and everything protocol- or vendor-specific pushed to the edges behind interfaces. This keeps the two decisions the PoC flagged as open (identity front, S3 backend) swappable without touching the security logic.

```
        ┌───────────────────────── grid-nas-gateway (one Go binary) ─────────────────────────┐
        │                                                                                     │
  NFS/  │   ┌─────────────┐        ┌──────────────────────────┐        ┌──────────────────┐   │
  SMB   │   │  Protocol    │  bind  │      AUTHORIZATION CORE   │  read  │   Storage Port    │  │   S3 API
 client ├──▶│  Adapter     ├───────▶│  (protocol- & vendor-     ├───────▶│  (narrow, 6-8     ├──┼──────▶ S3 /
 (dumb) │   │  (in: proto  │  ident │   agnostic; every op is   │  write │   gated methods)   │  │   R2 /
        │   │   → FileOp)  │        │   an explicit authz gate) │        │                   │   │  SeaweedFS
        │   └──────┬──────┘        └────────┬─────────┬────────┘        └──────────────────┘   │
        │          │                        │         │                                        │
        │   ┌──────▼──────────┐    ┌────────▼───┐ ┌───▼────────────┐   ┌──────────────────┐    │
        │   │ IdentityResolver│    │ PolicyClient│ │ DecisionCache  │   │  AuditSink        │   │
        │   │ (proto identity │    │ (WorkOS FGA │ │ (LRU+single-   │   │ (structured, on   │   │
        │   │  → WorkOS subj) │    │  Check/Batch│ │  flight+TTL)   │   │  every decision)  │   │
        │   └─────────────────┘    └─────┬──────┘ └────────────────┘   └──────────────────┘    │
        └───────────────────────────────┼─────────────────────────────────────────────────────┘
                                         │ HTTPS + API key
                                         ▼
                                    WorkOS FGA
```

**Ports (interfaces the core owns):**

- `StoragePort` — the narrow file interface. Methods: `Open`, `Create`, `Write`, `Remove`, `Rename`, `List`, `Stat`, `Mkdir`. **Every method takes a `Subject` and is gated.** Adapters: `billyS3` (rclone/FUSE, PoC path) or `nativeS3` (aws-sdk-go-v2, no FUSE — see ADR-1).
- `PolicyClient` — `Check(ctx, subject, relation, object) (bool, error)` and `BatchCheck(...)`. Adapters: `workosFGA` (prod), `mockFGA` (tests/CI, the PoC's shape).
- `IdentityResolver` — `Resolve(ctx, ProtocolIdentity) (Subject, error)`. Adapters: `dirpathResolver` (PoC, dev-only), `kerberosResolver` (NFSv4), `smbSessionResolver` (Samba). See ADR-2.
- `AuditSink` — `Record(Decision)`. Adapters: `slogSink`, `kafkaSink`/`otlpSink`.
- `DecisionCache` — bounded, TTL'd, single-flighted. One implementation.

The **core** (`authz.Engine`) is pure: given a `FileOp{Subject, Relation, Object}` it returns allow/deny using `PolicyClient` + `DecisionCache`, emits an `AuditSink` record, and never imports `net/http`, `billy`, or any NFS/SMB package. That's what makes it unit-testable and what makes the relation/layering policy the single source of truth.

---

## 2. Suggested package layout

```
grid-nas-gateway/
  cmd/gateway/main.go            # wiring, config, signals, health server, graceful shutdown
  internal/
    authz/
      engine.go                  # core: FileOp -> Decision; owns relation semantics
      cache.go                   # bounded LRU + TTL + singleflight
      relation.go                # typed Relation (Viewer/Editor), op->relation mapping
    policy/
      client.go                  # PolicyClient interface
      workos.go                  # real WorkOS FGA adapter (Check + BatchCheck)
      mock.go                    # in-proc mock (warrants.json shape) for tests/CI
    storage/
      port.go                    # StoragePort interface (the NARROW, all-gated seam)
      s3native.go                # aws-sdk-go-v2 adapter (no FUSE)   <-- target
      billyfuse.go               # rclone/FUSE billy adapter          <-- PoC bridge
    identity/
      resolver.go                # IdentityResolver interface
      dirpath.go / kerberos.go / smb.go
    proto/
      nfs/                       # go-nfs Handler -> StoragePort adapter
      smb/                       # (later) Samba VFS bridge or gomsmb
    audit/
      sink.go / slog.go / otlp.go
    observability/
      metrics.go telemetry.go    # Prometheus + OpenTelemetry
    config/
      config.go                  # env/file load + VALIDATION (fail fast)
  deploy/
    Dockerfile helm/ ...
  test/
    integration/                 # real S3 (SeaweedFS/localstack) + mock FGA
    e2e/                         # real kernel mount on a privileged CI runner
```

---

## 3. Architecture decisions

### ADR-1 — Storage access: native S3 SDK vs. rclone/FUSE substrate

**Context.** The PoC mounts S3 via `rclone mount` (FUSE) and serves the mount through `osfs`. That requires `SYS_ADMIN` + `/dev/fuse` + `apparmor:unconfined` on the container, adds a second failure mode (mount dies → gateway serves an empty or stale tree), and couples liveness to a sidecar process started in a shell entrypoint.

| Dimension | A: rclone/FUSE (PoC) | B: native S3 (aws-sdk-go-v2) |
|---|---|---|
| Container privilege | High (SYS_ADMIN, /dev/fuse) | **None** (plain, non-privileged) |
| Failure modes | mount-death, VFS cache corruption, FUSE unmount races | fewer; direct request/response |
| Caching / streaming | Mature (rclone VFS) — free | **You build it** (range reads, write buffering) |
| K8s / OpenShift fit | Awkward (privileged pod) | **Clean** |
| Effort to production | Low now, ops cost later | Higher now, lower later |

**Decision:** Target **B (native S3)** for production; keep **A behind the same `StoragePort`** as a bridge so nothing blocks on B. Because both sit behind `StoragePort`, this is a swap, not a rewrite. Native S3 removes the privileged-container requirement entirely — a real security and ops win for a GRID deployment on managed K8s — and makes the "S3 backend is swappable to R2/AWS" claim a first-class Go config, not an rclone.conf.

**Consequences.** You own read caching (range GETs + a small content cache keyed by ETag) and write semantics (buffer-then-`PutObject`, or multipart for large files). NFS's many `GETATTR`/`LOOKUP` RPCs become `HeadObject`/`ListObjectsV2` — cache aggressively (metadata cache separate from the authz decision cache). Revisit if streaming very large files dominates, where rclone's VFS would have saved work.

### ADR-2 — Identity: make the resolver the only thing that changes per protocol

**Context.** PoC identity is `subjectFromDirpath` over NFSv3 `AUTH_NULL` — client-asserted, spoofable, dev-only. FINDINGS correctly flags this as the weak link. Production needs authenticated identity, and the realistic fronts (NFSv4+Kerberos, or SMB/Samba) differ in how identity arrives but **not** in what the core does with it.

**Decision.** Identity resolution lives behind `IdentityResolver`, bound once per connection/session, and is the *only* component that differs across protocol fronts. The core, cache, policy client, storage port, and audit are identical whether the front is NFSv3 (dev), NFSv4+Kerberos, or SMB.

- **Dev / internal pilot:** `dirpathResolver` (share-per-subject), explicitly gated behind a `GATEWAY_ENV=dev` guard so it can never be enabled in prod config (fail-fast validation rejects `dirpath` resolver when env=prod).
- **Production, Windows-facing architects:** SMB via Samba. Accept the in-tree VFS build cost FINDINGS priced out, *or* bridge Samba's authenticated session user into the Go core over a local socket so the VFS module stays a thin shim and all policy stays in Go. Prefer the latter — it keeps one authz brain.
- **Production, Linux/mixed:** NFSv4 + `RPCSEC_GSS`/Kerberos → principal → WorkOS subject.

**Consequences.** The protocol adapter is thin; the security-critical mapping (`ProtocolIdentity → WorkOS Subject`) is one tested function per front. Never trust a subject that didn't come from `IdentityResolver`.

### ADR-3 — Authorization completeness: narrow gated port, typed relations, batched dir checks

**Context.** Three issues in the PoC decorator: (1) mutating ops ungated (§0); (2) relations are bare string literals `"viewer"`/`"editor"` scattered across call sites; (3) `ReadDir` does N sequential `Check` calls — a large directory is N cold round-trips.

**Decision.**
1. Replace `billy.Filesystem` dependence with the narrow `StoragePort`; **every** method takes `Subject` and calls the core before touching storage. Mutations (`Create/Write/Remove/Rename/Mkdir`) require `Editor`; reads (`Open/Stat/List`) require `Viewer`. Metadata mutations (chmod/chown/chtimes) map to `Editor`.
2. A typed `Relation` enum and a single `opToRelation` table — no string literals at call sites.
3. `List` uses `PolicyClient.BatchCheck` for all children in one call; the cache is populated from the batch result so the subsequent `Open` is warm.

**Consequences.** Adding a storage method forces an authz decision at compile time. Directory listings cost ~1 batch round-trip instead of N. Relation semantics live in one file, matching the WorkOS warrant model (`viewer`/`editor` on `document:` resources, with OIB-core → org → project inheritance resolved *inside* WorkOS, exactly as the mock's `decide()` documents).

### ADR-4 — Cache & resilience: bounded, single-flighted, explicit failure policy

**Context.** PoC cache is an unbounded `map[string]cacheEntry` under a mutex; expired keys are only overwritten on re-check, never swept → **unbounded memory growth** over long uptimes with many distinct `(subject,relation,object)` triples. On a cache miss, concurrent identical checks each hit WorkOS (thundering herd). Failure policy is fail-closed (good) but total: WorkOS blip → whole NAS denies.

**Decision.**
- Bounded **LRU** (`hashicorp/golang-lru/v2`, already an indirect dep) with per-entry TTL and a background sweeper; size and TTL from config.
- **`singleflight`** on `(subject,relation,object)` so a cache miss collapses concurrent identical checks into one upstream call.
- **Batch** dir checks (ADR-3).
- **Explicit, tiered failure policy** instead of blanket fail-closed: (a) unknown/never-cached → **deny** (fail closed); (b) previously-**allowed** and within a bounded *grace TTL* → **serve stale-allow** and emit a `degraded` audit+metric; (c) previously-denied → stay denied. This keeps a working drive alive through a short WorkOS outage without ever *granting* new access blindly. Grace TTL is a deliberate, documented risk knob.
- **Webhook invalidation:** a small HTTP endpoint consuming WorkOS warrant-change events punches affected cache keys, so revocation isn't bounded only by TTL.

**Consequences.** Bounded memory, far fewer upstream calls, and a survivability story for the dependency that would otherwise be a single point of total failure. Stale-allow window is explicit and auditable.

### ADR-5 — Statefulness & horizontal scaling (the non-obvious one)

**Context.** NFS is **stateful**: go-nfs's `CachingHandler` holds a filehandle↔path map, and the per-subject filesystem "travels with each cached handle." That state is per-instance and in-memory. You cannot naively put N gateway replicas behind a round-robin L4 LB — a client's handles live on one instance.

**Decision.** Treat the gateway as a **connection-affine, vertically-scaled-first** service:
- One replica handles a given client's whole session (sticky by client IP / connection at the LB, or a `StatefulSet` with per-pod stable addressing).
- Scale **out by sharding tenants/orgs across instances**, not by load-balancing a single client's connection.
- The **DecisionCache is per-instance and that's fine** (it's a cache, not truth); if cross-instance warm cache ever matters, add an optional shared Redis tier behind the same `DecisionCache` interface — but don't start there.

**Consequences.** Simpler, correct scaling model. Document explicitly that NFS handle state is not shared; don't let ops assume statelessness. SMB (if adopted) has the same session-affinity property.

### ADR-6 — Observability & audit (compliance-grade, not just ops)

**Context.** GRID stores architects' project documents governed by building-code compliance workflows; *who accessed / was denied which document when* is itself a record worth keeping. The PoC logs decisions via stdlib `log` to stdout — not structured, not durable, not queryable.

**Decision.**
- **Structured decisions** via `AuditSink`: one event per authorization decision `{ts, subject, relation, object, decision, reason, source=cache|remote|grace, latency_ms}` — `slog` JSON by default, pluggable to OTLP/Kafka.
- **Metrics** (Prometheus): `authz_checks_total{decision,source}`, `authz_check_latency_seconds`, `cache_hit_ratio`, `policy_upstream_errors_total`, `storage_op_latency_seconds`, `degraded_mode` gauge.
- **Tracing** (OpenTelemetry): span per file op → child span for the policy check, so a slow `open` is attributable to authz vs. S3.

**Consequences.** Denials become alertable, latency attributable, and the access log is a compliance artifact rather than debug noise.

---

## 4. Cross-cutting production requirements

- **Config & secrets:** typed config with **fail-fast validation** at boot (reject `dirpath` resolver in prod, require WorkOS API key, require S3 creds). S3 credentials and WorkOS API key from the platform secret store — the gateway holds **one** S3 credential and is the sole S3 client; end users never receive S3 keys (this property is the whole point and must be preserved through the native-S3 move).
- **Lifecycle:** signal handling, `context`-based graceful shutdown (drain in-flight ops, unmount cleanly), separate **health/readiness** HTTP server (`/healthz` liveness, `/readyz` gated on S3 reachable + WorkOS reachable).
- **Context propagation:** thread `context.Context` from protocol op → policy check → storage call for deadlines/cancellation (PoC relies only on `http.Client.Timeout`).
- **Testing:** unit tests on `authz.Engine` (full allow/deny matrix incl. the write path that's currently a hole); **path-traversal fuzzing** on object-id derivation; integration tests against real SeaweedFS + mock FGA; a privileged-runner e2e that does a real kernel `mount` (the PoC couldn't, since the sandbox kernel was NFSv4-only) and asserts a `REMOVE`/`RENAME` is denied for a non-editor.
- **Supply chain:** pin go-nfs and audit it (v0.0.3 is early — wrap it, don't fork-entangle); `govulncheck` + SBOM in CI.

---

## 5. Phased delivery

1. **Harden-in-place (days).** Close the write-path hole by introducing `StoragePort` and routing the existing rclone/FUSE adapter through it; typed relations; bounded LRU + singleflight; structured audit + basic metrics; graceful shutdown + health. *Same protocol front, same storage substrate — purely the microservice skeleton and the security fix.* Ship this as the internal pilot.
2. **De-privilege storage (1–2 wks).** Implement `s3native` behind `StoragePort`, drop rclone/FUSE, remove `SYS_ADMIN`/`/dev/fuse`. Now K8s-clean.
3. **Authenticate identity (project).** Swap `dirpathResolver` for the chosen prod front (SMB-session bridge for Windows architects, or NFSv4+Kerberos), behind `IdentityResolver`. Core untouched.
4. **Scale & operate.** Connection affinity, tenant sharding, webhook cache invalidation, OTel tracing, alerting on denial/degraded rates.

The ordering is deliberate: **fix the security hole and get the service skeleton right first (phase 1), because it's independent of the two big swaps (storage backend, identity front) and shouldn't wait on either.**
