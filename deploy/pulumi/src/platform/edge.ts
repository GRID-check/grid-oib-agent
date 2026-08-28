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
 * | Request body over 100 MB | Rejected at the edge | `proxyPlan` keeps the upload host grey |
 * | WebSocket idle over 100s | Connection closed | `proxyPlan` keeps the app host grey |
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
 * Belt and braces: the origin already marks these uncacheable, and Cloudflare's
 * defaults would not cache an authenticated response anyway. It is here because
 * the cost of being wrong is asymmetric — a cached admin page is a session
 * handed to the next visitor, and the rule that prevents it costs one of ten
 * free cache rules.
 */
const NEVER_CACHE_PATHS = [
  // Keystatic's admin UI and its API (`frontends/web`, @keystatic/astro).
  "/keystatic",
  "/api/keystatic",
  "/api",
];

/** Astro's hashed build output and its on-demand image endpoint. */
const CACHEABLE_PREFIXES = ["/_astro/", "/_image"];

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

  // Cache rules are evaluated in order and the FIRST match wins, so the bypass
  // has to come first. Reversing these two silently caches the admin UI.
  const cacheRules = new cloudflare.Ruleset(
    "edge-cache-rules",
    {
      zoneId,
      name: "grid-cache",
      kind: "zone",
      phase: "http_request_cache_settings",
      description: "Static assets cached at the edge; admin and API never",
      rules: [
        {
          action: "set_cache_settings",
          description: "Never cache the admin UI or any API response",
          expression:
            `${onProxiedHost} and (` +
            NEVER_CACHE_PATHS.map((p) => `starts_with(http.request.uri.path, "${p}")`).join(" or ") +
            ")",
          actionParameters: { cache: false },
        },
        {
          action: "set_cache_settings",
          description: "Cache Astro's hashed build output and processed images",
          expression:
            `${onProxiedHost} and (` +
            CACHEABLE_PREFIXES.map((p) => `starts_with(http.request.uri.path, "${p}")`).join(
              " or ",
            ) +
            ")",
          actionParameters: {
            cache: true,
            // `respect_origin`, never a fixed TTL. These paths are hashed or
            // query-addressed and the origin already marks them immutable; a
            // TTL set here would be a second, quieter answer to a question the
            // build output already answers, and the two would disagree the
            // first time the build changes.
            edgeTtl: { mode: "respect_origin" },
            browserTtl: { mode: "respect_origin" },
            // A stale asset beats an error while the origin is redeploying —
            // and these URLs only change when their content does.
            serveStale: { disableStaleWhileUpdating: false },
            respectStrongEtags: true,
          },
        },
      ],
    },
    opts,
  );

  return { settings, cacheRules };
}
