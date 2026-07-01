# WorkOS identity and AI‑Q authentication machinery

How AI‑Q's existing authentication layer fits into Grid's WorkOS‑first design, and
where we must add new code.

- **Scope:** authentication and identity for the Grid product.
- **Status:** implementation complete. WorkOS AuthKit is wired into the Next.js
  BFF (`frontends/ui/`) and the Python agent validates the same WorkOS access
  token via JWKS.

---

## What AI‑Q provides today

AI‑Q ships a provider‑agnostic ASGI auth layer in `frontends/aiq_api/src/aiq_api/auth/`.

### 1. `AuthMiddleware` (`frontends/aiq_api/src/aiq_api/auth/middleware.py`)

- Raw ASGI middleware that runs **before** FastAPI requests reach route handlers.
- Three independent checks:
  1. **Path allowlist** — external requests must match `EXTERNAL_ALLOWED_PATHS`
     (`/health`, `/docs`, `/chat`, `/v1/chat/completions`, `/v1/collections/...`, etc.).
  2. **Token validation** — controlled by `REQUIRE_AUTH`.
  3. **Caller type detection** — sets `user.type` (`jwt`, `internal`, `anonymous`, `unverified_jwt`).
- Stores the resolved user dict in a `ContextVar` so NAT workflow functions can read it
  via `get_current_user()`.
- Extracts tokens from:
  - `Authorization: Bearer <token>`
  - `idToken=<token>` cookie

### 2. `TokenValidator` base (`frontends/aiq_api/src/aiq_api/auth/base.py`)

Return contract for `validate(token)`:

```python
{
    "type": str,            # provider label
    "sub": str | None,      # subject / user id
    "email": str | None,
    "name": str | None,
    "token": str,           # raw token, forwarded downstream
    "skip_clarifier": bool, # True for headless/service callers
}
```

### 3. `JWTValidator` (`frontends/aiq_api/src/aiq_api/auth/jwt_validator.py`)

- Implements OIDC discovery + JWKS signature verification.
- Configurable `issuer_url`, `audience`, `jwks_uri`, algorithms.
- Caches JWKS keys for 6 hours.
- Verifies `exp`, optional `iss`/`aud`.
- Returns claims merged with the contract fields above.

This is **almost** what we need for WorkOS access‑token verification: WorkOS issues
standard JWT access tokens with a JWKS endpoint at
`https://api.workos.com/sso/jwks/<clientId>`.

---

## Why AI‑Q auth is not enough for Grid

| Capability | AI‑Q auth today | Grid needs |
|---|---|---|
| JWT signature verification | yes, via `JWTValidator` | yes — reuse |
| Identity provider | generic OIDC | **WorkOS specifically** |
| WorkOS organization / membership | no | yes — authz is org‑scoped |
| Project membership | not a concept | yes — `project_members` table |
| Role / permission claims | surface‑level | yes — drive UI and API gates |
| Session handling (cookie, refresh) | none | yes — Next.js BFF owns this |
| Server‑authoritative collection naming | none | yes — BFF computes `collection_scope[]` |

### Critical: AI‑Q does not understand WorkOS orgs

A WorkOS access token contains claims like:

| Claim | Present? |
|---|---|
| `sub` | always |
| `org_id` | only when an org is active |
| `role` | only when an org is active |
| `permissions` | only when an org is active |

AI‑Q's `JWTValidator` can verify the token and extract these claims, but it has no
notion of:

- "does this user belong to this organization?"
- "is this user a member of this Grid project?"
- "what collections is this user allowed to search?"

Those decisions belong to the **Next.js BFF**, because:

1. WorkOS session management is SDK‑driven and cookie‑based — NAT/AI‑Q has no session layer.
2. Grid projects are a Grid concept; WorkOS does not know about them.
3. Collection naming and scoping is a Grid policy decision.

---

## Target design: how the pieces compose

```mermaid
flowchart LR
    Browser["Browser"]
    Next["Next.js BFF"]
    WorkOS["WorkOS"]
    Agent["Python AI‑Q agent"]

    Browser -.->|OAuth2/PKCE login| WorkOS
    Next -->|session cookie| Browser
    Next -->|WorkOS API| WorkOS
    Next -->|Authorize + derive scope| Next
    Next -->|Bearer JWT + context{project_id, collection_scope[], ...}| Agent
    Agent -->|JWKS verify| WorkOS
```

### Next.js BFF responsibilities

- Use `@workos-inc/authkit-nextjs` for hosted AuthKit login.
- Hold the encrypted session cookie and rotating refresh token.
- On each request, read the session → access token (JWT).
- Authorize from `org_id` / `role` / `permissions` claims **plus**
  `project_members` lookups.
- Compute derived context (`project_id`, `collection_scope[]`).
- Forward the **raw WorkOS access token** to the Python agent.

## Next.js AuthKit callback route

AuthKit v4 uses a single App Router callback endpoint handled by
`@workos-inc/authkit-nextjs`:

- **File:** `frontends/ui/src/app/api/auth/callback/route.ts`
- **Export:** `export const GET = handleAuth();`

The `handleAuth()` helper negotiates the OAuth2/PKCE callback with WorkOS,
creates the encrypted session cookie, and redirects the user back into the
application. The previous NextAuth dynamic route
(`frontends/ui/src/app/api/auth/[...nextauth]/route.ts`) has been removed.

### BFF implementation summary

The Next.js BFF now uses `@workos-inc/authkit-nextjs`:

- `src/adapters/auth/use-auth.ts` exposes a provider-agnostic `useAuth()` hook
  that wraps the AuthKit client context. `idToken` is mapped to the WorkOS
  access token for backward compatibility with existing callers.
- `src/lib/auth/session.ts` wraps `withAuth()` and `refreshSession()` to produce
  a `GridSession` object on the server.
- `src/lib/auth/require-auth.ts` provides `requireAuthorizedSession()` which
  redirects to `/onboarding/organization` when no org is active.
- `src/lib/authz/projects.ts` checks `project_members` and allows admin or
  `cross_project_access` overrides.
- `src/proxy.ts` uses `authkitMiddleware` (deprecated alias of `authkitProxy`)
  so that session cookies are refreshed and API routes receive the current
  access token. `/auth/error` is excluded from the middleware matcher.
- API routes (`/api/v1/*`, `/api/chat`, `/api/generate`, `/api/generate/respond`,
  `/api/jobs/async/*`) use `withAuth()` and forward the raw WorkOS access token
  to the Python agent as `Authorization: Bearer <access_token>`.
- `src/features/chat/hooks/use-websocket-chat.ts` requests fresh access tokens
  via `getAccessToken()` and reconnects before token expiry using
  `getTokenExpiration()`.
- The `AppBar` consumes `useAuth()` directly for sign-out and user/org display.
- `AppConfigContext` no longer carries `authProviderId` or
  `sessionRefreshIntervalSeconds`.

### Python agent responsibilities

- Accept `Authorization: Bearer <workos_access_token>`.
- Use a `JWTValidator` configured for WorkOS JWKS to verify signature + expiry.
- Extract `sub`, `org_id`, `role`, `permissions` for personalization / logging.
- **Trust the BFF for derived scope** (`project_id`, `collection_scope[]`).
- Never decide tenancy or collection naming itself.

### What we reuse vs. build

| Component | Action |
|---|---|
| `AuthMiddleware` ASGI wrapper | Reuse — it already sets `scope["state"]["user"]` |
| `JWTValidator` with WorkOS JWKS | Reuse — configure issuer/audience/JWKS URI |
| WorkOS session / cookie / refresh | **Build new** in Next.js BFF |
| WorkOS org/membership resolution | **Build new** in Next.js BFF |
| Project authorization (`project_members`) | **Build new** in Next.js BFF |
| Collection naming / scoping policy | **Build new** in Next.js BFF |

---

## Python JWT verification

The Python agent provides a thin WorkOS-aware factory in
`src/aiq_agent/auth/workos_validator.py`:

```python
from aiq_agent.auth.workos_validator import create_workos_validator

validator = create_workos_validator()
```

`create_workos_validator()` reads `WORKOS_CLIENT_ID` from the environment and
returns a `JWTValidator` configured with:

- `issuer_url`: `https://api.workos.com`
- `jwks_uri`: `https://api.workos.com/sso/jwks/{WORKOS_CLIENT_ID}`
- `audience`: `{WORKOS_CLIENT_ID}`
- `algorithms`: `["RS256"]`

This lets the agent independently verify WorkOS access-token signatures and
extract claims such as `sub`, `org_id`, `role`, and `permissions`.

## Relevant files

- `frontends/aiq_api/src/aiq_api/auth/middleware.py`
- `frontends/aiq_api/src/aiq_api/auth/base.py`
- `frontends/aiq_api/src/aiq_api/auth/jwt_validator.py`
- `frontends/aiq_api/src/aiq_api/auth/utils.py`
- `frontends/aiq_api/tests/test_auth.py`
- `src/aiq_agent/auth/workos_validator.py`
- `tests/aiq_agent/auth/test_workos_validator.py`
- `frontends/ui/src/adapters/auth/use-auth.ts`
- `frontends/ui/src/lib/auth/session.ts`
- `frontends/ui/src/lib/auth/require-auth.ts`
- `frontends/ui/src/lib/authz/projects.ts`
- `frontends/ui/src/proxy.ts`
- `frontends/ui/src/app/api/auth/callback/route.ts`
- `frontends/ui/src/app/api/organizations/route.ts`
- `frontends/ui/src/app/api/v1/[...path]/route.ts`
- `frontends/ui/src/features/chat/hooks/use-websocket-chat.ts`

---

## Consequences for implementation

1. The Python agent only needs a thin WorkOS‑aware validator config; most auth work
   happens in Next.js.
2. The BFF must pass the **access token** (not a custom token) to the agent so the
   agent can verify it independently.
3. Because `org_id`/`role`/`permissions` are absent when no org is active, the BFF must
   force an org‑creation onboarding flow before any tenant‑scoped action.
4. The BFF must add `project_id` and `collection_scope[]` to the context object sent to
   the agent; the agent must never construct collection names from conversation ids.
