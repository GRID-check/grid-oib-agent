import type { ISecurityPolicySpec } from "@kubernetes-models/envoy-gateway/gateway.envoyproxy.io/v1alpha1/SecurityPolicySpec";
import { GridConfig } from "../config";

/**
 * WorkOS permission that grants platform-tier access — the same value the app
 * uses as `PLATFORM_PERMISSIONS.organizationsView`. Requested as an OAuth scope
 * and enforced as the authorization rule, so the two cannot drift apart.
 */
export const PLATFORM_VIEW_PERMISSION = "platform:organizations:view";

/**
 * Header a non-browser client (a coding agent, a script) puts its WorkOS access
 * token in, instead of `Authorization`. Separate because the tools behind these
 * routes need `Authorization` for their OWN credential: Langfuse's public API
 * and MCP server take `Basic base64(pk:sk)` there, and a request has only one
 * such header.
 */
export const AGENT_TOKEN_HEADER = "x-workos-token";

/**
 * The narrower permission that admits read-only observability users (business
 * analysts, the Fachbereich) to Langfuse without the platform-operator one.
 * Mirrors `PLATFORM_PERMISSIONS.observabilityView` in
 * frontends/ui/src/lib/authz/permissions.ts. Only routes that pass it in
 * `alsoAdmit` accept it; the Aspire dashboard does not.
 */
export const OBSERVABILITY_VIEW_PERMISSION = "platform:observability:view";

export interface PlatformOidcGate {
  /** HTTPRoute the policy attaches to. */
  routeName: string;
  /** Public hostname of that route — the redirect URI is built from it. */
  domain: string;
  /**
   * Name of the Secret holding the OIDC client secret under the key
   * `client-secret` (the key name is fixed by the Envoy Gateway API).
   */
  secretName: string;
  /**
   * Permissions admitted IN ADDITION to {@link PLATFORM_VIEW_PERMISSION}, each
   * on its own rule (holding any one is enough). Each is also requested as a
   * scope, so it must be assigned to the Connect application before the route
   * goes out: WorkOS answers a request for an unassigned scope with
   * `invalid_scope`, which fails the login for EVERYONE on that route,
   * operators included. Empty by default, so a route widens only by naming it.
   */
  alsoAdmit?: readonly string[];
}

/**
 * Edge authN + authZ for a platform-operator route (ADR-0029 Amendment 2,
 * generalized by ADR-0044 when Langfuse became a second such route).
 *
 * Three cooperating stages, run by Envoy in this order (the filter order is
 * fixed by Envoy Gateway: OAuth2=8, JWTAuthn=9, RBAC=301):
 *
 *   1. `oidc`          — browser redirect flow against WorkOS AuthKit. On
 *                        success Envoy stores the tokens in cookies and, with
 *                        `forwardAccessToken`, replays the WorkOS access token
 *                        upstream as `Authorization: Bearer <jwt>`.
 *   2. `jwt`           — verifies that token against WorkOS's JWKS, its
 *                        issuer and its audience (the environment).
 *   3. `authorization` — default-deny; allows only tokens carrying the
 *                        `platform:organizations:view` scope, or one of the
 *                        gate's `alsoAdmit` permissions (Langfuse:
 *                        `platform:observability:view`), AND minted by an
 *                        allowed application (`client_id`).
 *
 * WHY A CONNECT APPLICATION AND NOT THE APP'S AUTHKIT CLIENT. The app's client
 * speaks WorkOS's `/user_management/*` endpoints, and those cannot serve this
 * flow — for two independent reasons, both verified against live WorkOS:
 *
 *   1. `/user_management/authorize` is not a spec-complete OIDC authorization
 *      endpoint. It demands a non-standard connection selector (`provider`,
 *      `connection_id`, `organization_id` or `domain_hint`) and 302s to
 *      `error.workos.com/sso/invalid-connection-selector` without one.
 *   2. Fatally: `/user_management/authenticate` reads client credentials ONLY
 *      from the request body, and answers
 *      `invalid_request: Missing required parameter: client_id` to an HTTP
 *      Basic header. Envoy Gateway hardcodes Basic auth for the token exchange
 *      (`internal/xds/translator/oidc.go`: "every OIDC provider supports basic
 *      auth") with no SecurityPolicy field to override it, so the flow always
 *      died at the callback with "OAuth flow failed."
 *
 * A Connect application's issuer — the environment's AuthKit domain — publishes
 * a complete discovery document, so a stock OIDC client works against it
 * unmodified. The application must be a CONFIDENTIAL client: a public PKCE-only
 * client has no secret, and `clientSecret` is required here.
 *
 * **Agents: a token instead of a browser, never instead of WorkOS.** A request
 * that already carries a WorkOS token (`Authorization: Bearer`, or
 * {@link AGENT_TOKEN_HEADER}) skips the
 * browser redirect (`passThroughAuthHeader`) and goes straight to stages 2 and
 * 3: the same JWKS check and the same permission rule a browser session meets.
 * The token comes from a WorkOS M2M application holding the permission
 * (`scripts/observability-agent-token.sh`). Nothing here trusts a tool's own
 * key: a request carrying only Langfuse's `Basic` credential gets a 401
 * (`denyRedirect`), one carrying nothing gets the login redirect, and neither
 * reaches the backend. Passing through only ever lands on a check that fails
 * closed — `jwt` is not optional, so a request whose header holds no valid
 * token is refused, not admitted.
 *
 * **Only tokens minted for known applications.** Without passthrough, the only
 * token the JWT filter ever saw was the one Envoy obtained itself for
 * `oidcClientId`. With it, a caller chooses the token, and any application in
 * the WorkOS environment holding the scope would do. WorkOS names the minting
 * application in `client_id` (and, for M2M, `sub`), not in `aud`: `aud` is the
 * environment's client id for an M2M token always, and for a user token
 * whenever no resource indicator was requested (Envoy requests none). So
 * `audiences` pins the environment ({@link platformJwtAudience}), and the
 * authorization rule allows only the client ids in
 * {@link platformAllowedClientIds}: this gate's own Connect client and the M2M
 * applications named in `platformAgentClientIds`. Listing the M2M client ids as
 * audiences instead would reject every agent token, and admitting the
 * environment id without the `client_id` rule would admit every M2M
 * application in the environment that holds the scope. ADR-0044 Amendment 5.
 *
 * **One application, several routes.** Both platform routes gate on the same
 * issuer and the same operator permission (Langfuse additionally admits
 * `platform:observability:view`, through `alsoAdmit`), so they share one
 * Connect application and it carries one redirect URI per route. Splitting them would mean two
 * near-identical confidential clients and two places to get the scope
 * assignment wrong, buying a separation nobody would use — the credential is
 * already purpose-scoped to platform operators.
 *
 * One-time WorkOS setup per route: register
 * `https://<domain>/oauth2/callback` as a redirect URI on that application
 * (`docs/deployment/kubernetes.md` §9).
 */
export function platformOidcSecurityPolicySpec(
  cfg: GridConfig,
  gate: PlatformOidcGate,
): ISecurityPolicySpec {
  // Every endpoint hangs off the one issuer, so there is no way for them to
  // drift onto different WorkOS applications.
  const issuer = cfg.observability.oidcIssuer;
  const jwtProviderName = "workos";
  const admitted = [PLATFORM_VIEW_PERMISSION, ...(gate.alsoAdmit ?? [])].filter(
    (permission, index, all) => all.indexOf(permission) === index,
  );
  const allowedClientIds = platformAllowedClientIds(cfg);

  return {
    targetRefs: [
      { group: "gateway.networking.k8s.io", kind: "HTTPRoute", name: gate.routeName },
    ],
    oidc: {
      provider: {
        issuer,
        authorizationEndpoint: `${issuer}/oauth2/authorize`,
        tokenEndpoint: `${issuer}/oauth2/token`,
      },
      clientID: cfg.observability.oidcClientId,
      // Key name fixed by the SecurityPolicy API — see OIDC_CLIENT_SECRET_KEY.
      clientSecret: { name: gate.secretName },
      // `offline_access` buys the refresh token for the renewal below. The
      // permission scope is what carries the authorization decision: WorkOS
      // grants it only if the signing-in user's role actually holds that
      // permission, so requesting it here is what makes the rule below mean
      // something. It must also be assigned to the Connect application
      // ("Scopes" in the WorkOS dashboard) or it is silently not issued.
      scopes: ["openid", "profile", "email", "offline_access", ...admitted],
      redirectURL: `https://${gate.domain}/oauth2/callback`,
      logoutPath: "/logout",
      // Hands the access token to stage 2 (and 3) — without it there is no
      // token for the JWT filter to verify and the permission gate cannot run.
      forwardAccessToken: true,
      // Safety net, kept deliberately. Envoy hard-fails a login when the token
      // response carries no `expires_in` and this is unset, because the default
      // resolves to 0 ("No default or explicit access token expiration found in
      // the token exchange response", oauth2/oauth_client.cc). WorkOS's
      // /user_management endpoint does omit it; whether the Connect token
      // endpoint does has not been verified, so the net stays.
      //
      // Only a fallback: a real `expires_in` always wins. Keep it <= the
      // AuthKit application's `accessTokenExpiry` (300s on this environment) —
      // too long and Envoy replays a token the JWT filter already rejects.
      defaultTokenTTL: "5m",
      // Renew silently rather than bouncing the browser through a full
      // redirect every few minutes. Envoy's default is already true — pinned
      // because the short TTL above makes the behaviour load-bearing.
      refreshToken: true,
      // Skip the redirect for a request that carries a token in any header
      // the JWT provider below reads. Envoy Gateway builds the matchers from
      // that provider's `extractFrom`. They are stricter than the provider
      // (a prefix match where Envoy searches the value), so where the two
      // differ the request is redirected, never admitted.
      passThroughAuthHeader: true,
      // A client sending `Authorization: Basic` (Langfuse's own credential)
      // is a program, not a browser: a 302 to a login page is noise to it.
      // Without a WorkOS token it gets a 401 instead.
      denyRedirect: { headers: [{ name: "Authorization", type: "Prefix", value: "Basic " }] },
    },
    jwt: {
      providers: [
        {
          name: jwtProviderName,
          issuer,
          remoteJWKS: { uri: `${issuer}/oauth2/jwks` },
          audiences: [platformJwtAudience(cfg)],
          extractFrom: { headers: TOKEN_HEADERS },
        },
      ],
    },
    authorization: {
      // Fail closed: anything without the platform permission is denied,
      // including a request that somehow skipped stages 1-2.
      //
      // The gate is the permission, not membership of the platform org. Bare
      // membership does not match how the application decides platform access:
      // `isPlatformOwner` (frontends/ui/src/lib/authz/platform.ts) accepts the
      // `org-platform-owner` role OR this permission. Gating on the org alone
      // would mean anyone added to the platform org with WorkOS's default
      // `member` role — which grants nothing in the app, and so reads as
      // harmless to whoever does it — silently gained cross-tenant read of
      // prompts, document snippets, LLM output and presigned S3 URLs.
      //
      // The permission alone is not enough once callers choose the token: any
      // application in the environment that was assigned the scope would hold
      // it. So every rule also names the applications, by the `client_id` claim
      // WorkOS sets to the one that minted the token. Scopes and claims inside
      // one JWT principal are AND-ed; the values of one claim are OR-ed.
      //
      // For a browser session the permission was meant to be doubly scoped:
      // issued only to this Connect application (per-application scope
      // assignment) and only to a user whose role in the selected organization
      // holds it.
      //
      // UNVERIFIED AND CONTRADICTED, checked 2026-10-09: WorkOS's Connect docs
      // (https://workos.com/docs/authkit/connect/token-claims, "Authorize
      // requests") say scopes "do not enforce the user's role-based
      // permissions" and that Connect tokens carry no permissions claim. If that
      // holds for this application, the second half of "doubly scoped" is false
      // and this rule admits every WorkOS user who signs in through the Connect
      // application. kubernetes.md §9b ("Giving
      // analysts read-only access", step 3) is the live check; the fix, if it
      // fails, is to gate on the token's `org_id` plus a role claim from a JWT
      // template, or on a server-side permission lookup.
      //
      // ONE RULE PER PERMISSION, never one rule listing several: Envoy ANDs the
      // entries of a principal's `scopes`, so `[a, b]` would admit only a token
      // holding both, and the narrower role would be locked out. Rules are
      // ORed, which is the "any of these" the gate means.
      defaultAction: "Deny",
      rules: admitted.map((permission) => ({
        name: permission === PLATFORM_VIEW_PERMISSION ? "platform-permission-only" : ruleName(permission),
        action: "Allow" as const,
        principal: {
          jwt: {
            provider: jwtProviderName,
            // `scopes` matches the space-delimited `scope`/`scp` claim per
            // RFC 6749, which is how granted permissions arrive on an OAuth
            // access token. These mirror PLATFORM_PERMISSIONS in
            // frontends/ui/src/lib/authz/permissions.ts.
            scopes: [permission],
            claims: [{ name: "client_id", valueType: "String" as const, values: allowedClientIds }],
          },
        },
      })),
    },
  };
}

/**
 * Where the JWT filter looks for a WorkOS token. `Authorization: Bearer` stays
 * first and must stay: it is where `forwardAccessToken` puts the browser
 * session's token, so dropping it would lock out every browser. Setting
 * `extractFrom` at all also retires Envoy's `?access_token=` default, which
 * put tokens in URLs and therefore in access logs.
 */
const TOKEN_HEADERS = [{ name: "Authorization", valuePrefix: "Bearer " }, { name: AGENT_TOKEN_HEADER }];

/**
 * The `aud` every token at the platform edge carries: the WorkOS environment's
 * client id (`workosClientId`, the app's own AuthKit client id). WorkOS sets it
 * on every M2M token, and on a user token when the authorization request named
 * no resource indicator, which Envoy's (no `oidc.resources`) does not.
 * https://workos.com/docs/authkit/connect/token-claims
 */
export function platformJwtAudience(cfg: GridConfig): string {
  return cfg.auth.workosClientId;
}

/**
 * Applications whose tokens pass the platform edge, matched against `client_id`:
 * the gate's Connect application (browser sessions) first, then the M2M
 * applications agents mint from.
 */
export function platformAllowedClientIds(cfg: GridConfig): string[] {
  return [cfg.observability.oidcClientId, ...cfg.observability.agentClientIds];
}

/** `platform:observability:view` -> `observability-view-permission`: a valid, stable rule name. */
function ruleName(permission: string): string {
  return `${permission.split(":").slice(1).join("-")}-permission`;
}
