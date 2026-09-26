# Authentication Flow

Auth is handled by **WorkOS AuthKit v4** with session cookies. The `REQUIRE_AUTH` environment variable controls whether auth is enforced.

## Sign-in flow

1. User clicks **Sign In** → calls `getAuth()` from `@workos-inc/authkit-nextjs`
2. Browser redirects to WorkOS hosted login page
3. WorkOS authenticates the user and redirects back to `/api/auth/callback`
4. AuthKit sets an encrypted httpOnly session cookie
5. User is redirected to the home page, now authenticated

Sign-out calls `signOut({ returnTo: '/' })` which clears the WorkOS session cookie.

## Session resolution

`getGridSession()` in `frontends/ui/src/lib/auth/session.ts:38` reads the current session using `withAuth()` from AuthKit:

```typescript
export async function getGridSession(): Promise<GridSession | null>
```

It returns a `GridSession` with these fields:

| Field | Source |
|---|---|
| `userId` | `auth.user.id` (WorkOS sub claim) |
| `email` | `auth.user.email` |
| `name` | `firstName + lastName` or fallback |
| `accessToken` | `auth.accessToken` (raw WorkOS JWT) |
| `organizationId` | `auth.organizationId` from session |
| `orgMembershipId` | Resolved via `workos.userManagement.listOrganizationMemberships()` |
| `role` | `auth.role` or from JWT claims |
| `permissions` | `auth.permissions` (from WorkOS FGA) |

When no session exists, `getGridSession()` returns `null`.

## Auth guards

### requireGridSession()

`frontends/ui/src/lib/auth/require-auth.ts:18`

Requires any valid session. Throws `Error('Unauthorized: Grid session required')` if no session is present.

### requireAuthorizedSession()

`frontends/ui/src/lib/auth/require-auth.ts:18`

Extends `requireGridSession()` and additionally requires an `organizationId`. If the user has not selected an organization, it redirects to `/onboarding/organization`. Returns `AuthorizedSession` (guarantees `organizationId`, `orgMembershipId`, `role`, `permissions` are non-null).

## Anonymous mode

When `REQUIRE_AUTH=false`:

- **Server-side**: `getGridSession()` still works (returns null if no cookie), but is not called by BFF routes. `resolveSession()` in the v1 proxy returns `null`. No Authorization headers are forwarded.
- **Client-side**: `useAuth()` in `frontends/ui/src/adapters/auth/use-auth.ts:73` short-circuits and returns `DEFAULT_USER`:

```typescript
{
  user: { id: 'default-user', name: 'Default User', email: null, image: null },
  isAuthenticated: true,
  authRequired: false,
  accessToken: undefined,
  idToken: undefined,
  organizationId: undefined,
}
```

- **WebSocket**: The `fetchCollectionScopeHeader` call in `server.js` proceeds without auth; the scope endpoint returns the scope header with null session identity.

## BFF auth forwarding

In auth mode, the Next.js BFF acts as an auth gateway. When proxying to the Python backend, it attaches:

| Header | Value | Routes |
|---|---|---|
| `Authorization` | `Bearer <accessToken>` | `/chat/stream`, `/generate/stream`, `/v1/*` |
| `X-Grid-Collection-Scope` | Base64url-encoded scope array | All proxied routes |
| `X-Grid-Organization-Id` | `session.organizationId` | WebSocket upgrade only |
| `X-Grid-User-Id` | `session.userId` | WebSocket upgrade only |

The `buildCollectionScopeFromRequest()` helper constructs the collection scope from the session's organization, project, and conversation IDs.

## Python JWT validation

`src/aiq_agent/auth/workos_validator.py` creates a `JWTValidator` configured for WorkOS:

```python
JWTValidator(
    issuer_url="https://api.workos.com",
    jwks_uri=f"https://api.workos.com/sso/jwks/{client_id}",
    audience=client_id,
    algorithms=["RS256"],
)
```

`JWTValidator` (`frontends/aiq_api/src/aiq_api/auth/jwt_validator.py:39`) uses `PyJWT[cryptography]` to verify RS256 signatures:

1. Fetches JWKS from WorkOS (cached for 6 hours, cache-busted on kid miss)
2. Extracts the signing key matching the JWT `kid`
3. Verifies signature, `exp`, `iss`, and `aud`
4. Returns a dict with claims (`type: "jwt"`, `sub`, `email`, `name`, `token`) on success
5. Returns error code `token_expired` or `token_invalid` on failure

The validated principal is accessible in Python via `get_current_principal()` from `src/aiq_agent/auth/utils.py:200`, which reads the `aiq_api.auth.middleware` context.

## Token retrieval chain

`get_auth_token()` in `src/aiq_agent/auth/utils.py:149` returns a token from the first available source, checked in priority order:

1. **Registered token fetchers** — custom fetchers registered via `register_token_fetcher(fn, priority)`, sorted high-to-low
2. **NAT Context cookies** — `idToken` cookie from the NAT context (browser / web-UI mode)
3. **NAT Context Authorization header** — `Authorization: Bearer <jwt>` from the NAT context (API callers)
4. Returns `None` if no source yields a token

## WebSocket auth

During WebSocket upgrade, `server.js:199` intercepts `/websocket` connections:

1. Calls `/api/auth/websocket-scope` (internal BFF endpoint)
2. This resolves the session via `getGridSession()`, checks project access, builds the collection scope
3. If auth is required and no session, returns 401/403 and the socket is rejected
4. On success, the response includes `organizationId`, `userId`, and `accessToken`
5. `server.js` forwards these as `X-Grid-Organization-Id`, `X-Grid-User-Id`, and `Authorization: Bearer <token>` to the Python backend's WebSocket route
6. The Python `/websocket` route checks these headers to identify the caller
