# ADR-0025: Mount identity — SSO-brokered device credentials over WebDAV Basic

- **Status:** Accepted (implemented for the WebDAV front)
- **Date:** 2026-07-14
- **Related:** ADR-0023 (file-gateway + per-file FGA), ADR-0024 (protocol adapters), the
  H3 "production identity" blocker in `services/file-gateway/docs/ENTERPRISE-READINESS.md`

## Context

The product goal: **a macOS or Windows user mounts the Grid drive, passes an SSO
step, and sees their files** — with no special client software.

The immovable constraint: **native OS mount clients cannot run a browser SSO flow.**
Finder's "Connect to Server" and Windows' "Map network drive" speak exactly one
authentication UI — a username/password dialog (WebDAV Basic) or a Kerberos ticket
(SMB, domain-joined). No stock WebDAV/NFS/SMB client can execute an OIDC redirect.
Every product in this space therefore lands on one of three shapes:

| Shape | Where SSO happens | Client software | Status |
|---|---|---|---|
| **A. SSO-brokered device credential** | in the browser, at credential *issuance* (+ every TTL-forced re-issue) | none | **this ADR — implemented** |
| B. Helper app (tray icon does OIDC, mounts via loopback WebDAV/FUSE) | literally at mount time | required | future; reuses this ADR's endpoint unchanged |
| C. SMB + Kerberos / Entra ID | invisible (ticket, no prompt) | none, but managed/domain-joined fleet | documented Windows-native ideal (ADR-0023) |

## Decision

**Shape A.** The web app (already behind WorkOS SSO) mints a *device credential*;
the user types it once into the native mount dialog; the OS keychain keeps it.

- **Issuance (the SSO moment).** `POST /api/drive/credentials` — session-authenticated,
  so reaching it *is* passing WorkOS SSO (including any org SSO policy). Returns
  username (the user's email) + a high-entropy secret `gdk_<32-hex uuid>.<32B base64url>`,
  **shown exactly once**; only its SHA-256 lands in `drive_credentials` (migration 0017),
  with TTL (`DRIVE_CREDENTIAL_TTL_DAYS`, default 90), revocation, last-used stamps, and
  audit events. Managed from the profile page ("Network drive" card).
- **Verification.** The gateway's WebDAV front gains a `BasicResolver`
  (`GATEWAY_WEBDAV_IDENTITY=basic`): parses Basic auth, verifies against
  `POST /api/internal/mount-auth` (internal-token guarded). The secret embeds the
  credential id → one PK lookup + one constant-time hash compare; every failure mode
  is a uniform `{allow:false}`. A short in-process verdict cache (60s allow / 5s deny)
  absorbs WebDAV's PROPFIND bursts.
- **Challenge semantics.** 401 carries `WWW-Authenticate: Basic realm="Grid Drive"` —
  this is precisely what makes Finder/Explorer pop their credential dialog. A verifier
  outage is answered **503 without a challenge**, so mounted clients retry silently
  instead of re-prompting every user for a password that isn't wrong.
- **Config lockstep.** `header` identity stays dev-only; `basic` is required outside
  dev (needs internal token + endpoint, refuses the dev-default token). The prior
  blanket "WebDAV is dev-only" refusal is replaced by this matrix.

### Why this is SSO-equivalent, not an app-password hack

The credential **only authenticates**. Every file operation is still authorized
live against WorkOS FGA via the same BFF brain the web app uses (ADR-0023). Remove a
user's role or org membership and their already-mounted drive goes dark within
seconds — a valid keychain password grants nothing by itself. The TTL bounds how long
a device can operate without its user re-passing SSO in the web app; revocation (user
or admin) is immediate. Conditional-access lives at issuance; continuous authorization
lives at every file op.

### Transport

Basic auth is plaintext-equivalent: the WebDAV front **must only be reachable through
TLS** (terminated at the ingress). Windows' WebClient refuses Basic over `http://` by
default — the correct client-side backstop, not a bug to work around.

## Consequences

- Mount UX on stock macOS/Windows: browser SSO → copy credential → native dialog →
  keychain → files. No agent, no FUSE, no registry surgery (except the well-known
  Windows 50 MB WebDAV size limit for large files — see `docs/MOUNTING.md`).
- NFSv3 cannot carry a credential at all, so with this ADR the NFSv3 adapter was
  **removed** rather than left as a permanently-dev-only front (it lives in git history
  for an NFSv4+Kerberos revival); WebDAV is the drive.
- Brute force: 256-bit secrets, uniform denials, per-attempt BFF round trip, short
  negative cache. Lockout counters were deliberately skipped (they'd be a self-DoS
  vector against a known username).
- Shape B (helper app with a true mount-time SSO popup) and Shape C (SMB/Kerberos,
  zero-prompt on managed fleets) both remain open, and both consume this ADR's
  issuance/verification machinery unchanged.
