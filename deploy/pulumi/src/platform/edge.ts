import * as cloudflare from "@pulumi/cloudflare";
import type { GridConfig } from "../config";
import { type ManagedDns, proxiedHosts } from "./dns";

/**
 * Zone-level Cloudflare configuration — the half of proxying that is not a DNS
 * record.
 *
 * `platform/dns.ts` decides WHICH hosts sit behind the proxy. This file decides
 * what the proxy does with them, and everything here is on the free plan. The
 * split matters because the two have different blast radii: a record is one
 * host, a zone setting is every name in the zone, including the hosts of other
 * stacks. So this runs only for the stack that already declared itself the
 * zone's owner (`dnsZoneBaseline`) — the same at-most-one rule that governs
 * `www`, `_dmarc` and the apex.
 *
 * **Nothing here affects an unproxied host.** Cloudflare applies TLS policy,
 * cache rules and security headers at its edge, and a grey-clouded name never
 * reaches that edge. That is what makes this safe to enable on a zone whose
 * other stacks are still fully grey, and it is also the reason the settings are
 * not conditional on which hosts happen to be orange today.
 *
 * ## What the free plan does not do, and what this file does about it
 *
 * | Wanted | Free plan | Here |
 * |---|---|---|
 * | Managed WAF rules | The Cloudflare Free Managed Ruleset is deployed automatically on free zones | not re-declared: writing our own `http_request_firewall_managed` entrypoint would REPLACE Cloudflare's default deployment with a copy we then own |
 * | Rate limiting | 1 rule, path + IP only, 10s window | not used: the only proxied host is a static landing site, and ADR-0040 already limits the app tier at the Gateway, where the windows are ours to choose |
 * | Request body over 100 MB | Rejected at the edge | `proxyPlan` keeps the app host grey — uploads cross it |
 * | WebSocket idle over 100s | Connection closed | nothing needed: uvicorn PINGs every 20s (`deploy/start_web.py`) |
 */
export interface ManagedEdge {
  /** One resource per zone setting — Cloudflare's API is per-setting, not a document. */
  settings: cloudflare.ZoneSetting[];
  /** Cache rules for the proxied hosts. */
  cacheRules?: cloudflare.Ruleset;
}

/**
 * TLS, HTTP and security settings applied to proxied traffic.
 *
 * Every value is stated rather than left to Cloudflare's default, because a
 * default is a decision someone else can change. The ones with a real trade-off
 * carry it in the comment; the rest are here so that reading this list tells you
 * the zone's posture without opening the dashboard.
 */
function zoneSettings(): Array<{ id: string; value: unknown; why: string }> {
  return [
    {
      id: "ssl",
      value: "strict",
      // "Full (strict)" — Cloudflare validates the ORIGIN's certificate.
      // Anything weaker is the trap the orange cloud is famous for: "flexible"
      // shows a padlock to the visitor while Cloudflare talks plaintext to the
      // origin, and the site looks perfectly secure while it is not. This stack
      // can afford strict because every listener already holds a real Let's
      // Encrypt certificate (`platform/cert-manager.ts`).
      why: "Cloudflare verifies the origin certificate; anything less is a padlock over plaintext",
    },
    {
      id: "alwaysUseHttps",
      value: "on",
      why: "plain-HTTP requests are redirected at the edge, before they reach the origin",
    },
    {
      id: "automaticHttpsRewrites",
      value: "on",
      why: "rewrites http:// subresources in HTML, which is what actually silences mixed-content warnings",
    },
    {
      id: "minTlsVersion",
      value: "1.2",
      // 1.2, not 1.3: 1.3 would refuse a measurable share of real clients, and
      // the floor that matters is the one that removes the broken versions.
      why: "TLS 1.0/1.1 are broken and nothing this product supports needs them",
    },
    { id: "tls13", value: "on", why: "one fewer round trip on a first connection" },
    {
      id: "websockets",
      value: "on",
      // Currently no proxied host serves a WebSocket. Set anyway, because the
      // day one does, this being off is a failure with no error message: the
      // upgrade is answered by Cloudflare with a plain HTTP response and the
      // client just reports a closed socket.
      why: "so a future proxied WebSocket host is not broken by a zone toggle nobody remembers",
    },
    { id: "brotli", value: "on", why: "smaller responses at no cost to the origin" },
    { id: "http3", value: "on", why: "QUIC for clients that ask for it" },
    {
      id: "alwaysOnline",
      value: "on",
      // Only ever serves a cached copy of a page it already has, and only while
      // the origin is unreachable. For a marketing site an archived page beats
      // a browser error.
      why: "serves a cached copy of the landing site while the origin is down",
    },
    {
      id: "securityHeader",
      value: {
        strictTransportSecurity: {
          enabled: true,
          // Six months. Long enough to be worth having, short enough that a
          // mistake ages out rather than becoming permanent.
          maxAge: 15552000,
          // Safe here because every host in this zone is HTTPS-only already —
          // the Gateway's :80 listener exists solely for the ACME challenge,
          // which is not a browser and does not read HSTS.
          includeSubdomains: true,
          // Deliberately NOT preloaded. Preloading is the one-way door in this
          // file: browsers ship the list compiled in, removal takes months, and
          // it would apply to every future subdomain of the zone including ones
          // nobody has thought of yet.
          preload: false,
          nosniff: true,
        },
      },
      why: "HSTS with a six-month max-age; preload deliberately off",
    },
  ];
}

/**
 * Paths that must never be served from cache, whatever the origin says.
 *
 * The cost of being wrong is asymmetric — a cached admin page is a session
 * handed to the next visitor — and the rule that prevents it costs one of ten
 * free cache rules.
 */
const NEVER_CACHE_PATHS = [
  // Keystatic's admin UI and its API (`frontends/web`, @keystatic/astro).
  "/keystatic",
  "/api/keystatic",
  "/api",
  // The sign-in hand-off. It 302s to a host read from the environment at
  // request time and sets `no-store` itself for exactly that reason
  // (`frontends/web/src/pages/sign-in.ts`); listed here so no edge TTL can
  // override the origin's own answer and freeze one stack's app URL into the
  // other's landing page.
  "/sign-in",
];

/** Astro's hashed build output and its on-demand image endpoint. */
const CACHEABLE_PREFIXES = ["/_astro/", "/_image"];

/**
 * Edge lifetime for page HTML.
 *
 * Short on purpose: nothing purges this cache on deploy, so this interval IS
 * the delay between merging a content change and a visitor seeing it. Five
 * minutes still absorbs a traffic spike and a repeat visitor, which is the
 * value being bought — the landing site is prerendered and cheap, so the win
 * is surviving a launch, not shaving milliseconds.
 *
 * Raising it means adding a purge to the deploy (a Cloudflare token with
 * `Zone:Cache Purge:Edit` and a step in `.github/workflows/deploy.yml`). Until
 * that exists, this number is the honest one.
 */
const HTML_EDGE_TTL_SECONDS = 300;

export function installEdge(cfg: GridConfig, dns: ManagedDns | undefined): ManagedEdge | undefined {
  if (dns === undefined || !cfg.dns.zoneBaseline || !cfg.dns.proxyEnabled) {
    return undefined;
  }
  const opts = { provider: dns.provider };
  const zoneId = cfg.dns.zoneId;

  const settings = zoneSettings().map(
    (s) =>
      new cloudflare.ZoneSetting(
        `edge-${s.id}`,
        { zoneId, settingId: s.id, value: s.value },
        opts,
      ),
  );

  const hosts = proxiedHosts(dns.plan);
  if (hosts.length === 0) {
    return { settings };
  }
  const hostList = hosts.map((h) => `"${h}"`).join(" ");
  const onProxiedHost = `http.host in {${hostList}}`;

  // ORDER IS LOAD-BEARING, AND NOT IN THE DIRECTION IT LOOKS.
  //
  // Cache rules are NOT first-match-wins. Every matching rule in the phase runs,
  // in order, and for conflicting settings the LAST match wins. So the broad
  // rule goes FIRST and the exclusions go LAST — the opposite of how a firewall
  // reads, and the reason this comment exists.
  //
  // Put the catch-all last instead and it silently overrides the never-cache
  // rule above it: Cloudflare accepts the ruleset, reports success, and starts
  // caching the Keystatic admin UI.
  const cacheRules = new cloudflare.Ruleset(
    "edge-cache-rules",
    {
      zoneId,
      name: "grid-cache",
      kind: "zone",
      phase: "http_request_cache_settings",
      description: "Page HTML and static assets cached at the edge; admin, API and sign-in never",
      rules: [
        {
          action: "set_cache_settings",
          description: "Cache page HTML at the edge, but never in the browser",
          expression: onProxiedHost,
          actionParameters: {
            cache: true,
            // `override_origin`, and this is the one place that is right. The
            // landing site is prerendered (`frontends/web` has no `output:`,
            // so every route without `prerender = false` is a static file), and
            // @astrojs/node serves those files with `public, max-age=0`. That
            // header is CORRECT for a browser and useless for a shared cache:
            // taken literally it means the edge stores nothing and every page
            // view reaches the origin. Overriding the shared TTL is the only
            // way to cache HTML here short of patching the adapter's static
            // file serving, which would have to be re-done on every upgrade.
            edgeTtl: { mode: "override_origin", default: HTML_EDGE_TTL_SECONDS },
            // The browser keeps `max-age=0` and revalidates every navigation.
            // That is what makes the edge copy the only stale one, and the only
            // one that can be purged — a browser cache cannot be.
            browserTtl: { mode: "respect_origin" },
            serveStale: { disableStaleWhileUpdating: false },
            respectStrongEtags: true,
          },
        },
        {
          action: "set_cache_settings",
          description: "Astro's hashed build output and processed images keep the origin's year",
          expression:
            `${onProxiedHost} and (` +
            CACHEABLE_PREFIXES.map((p) => `starts_with(http.request.uri.path, "${p}")`).join(
              " or ",
            ) +
            ")",
          actionParameters: {
            cache: true,
            // These are content-addressed and the origin says
            // `max-age=31536000, immutable` (verified on the live host), so the
            // origin's answer is better than any number written here. This rule
            // exists only to take those paths back off the five-minute TTL the
            // catch-all above just gave them.
            edgeTtl: { mode: "respect_origin" },
            browserTtl: { mode: "respect_origin" },
            serveStale: { disableStaleWhileUpdating: false },
            respectStrongEtags: true,
          },
        },
        {
          action: "set_cache_settings",
          // LAST, so it wins over both rules above.
          description: "Never cache the admin UI, the API, or the sign-in hand-off",
          expression:
            `${onProxiedHost} and (` +
            NEVER_CACHE_PATHS.map((p) => `starts_with(http.request.uri.path, "${p}")`).join(" or ") +
            ")",
          actionParameters: { cache: false },
        },
      ],
    },
    opts,
  );

  return { settings, cacheRules };
}
