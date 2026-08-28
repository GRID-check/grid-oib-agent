import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
// Type-only: `config.ts` imports the host-set derivation from here at runtime,
// so a value import in this direction would close a module cycle.
import type { GridConfig } from "../config";

/**
 * Public DNS for the stack's hosts, in Cloudflare.
 *
 * This exists to delete a manual step. Every deploy used to end with an
 * operator reading the Envoy LoadBalancer's external IP and retyping it into a
 * registrar's web UI for each host — `docs/deployment/kubernetes.md` said so in
 * as many words. That step has no failure mode that looks like a failure: a
 * typo'd or forgotten record produces a healthy cluster serving nobody, and a
 * cert-manager HTTP-01 challenge that never solves because the CA cannot reach
 * the name it is validating.
 *
 * The record set is derived from the SAME config the Gateway listeners are
 * built from (`platform/gateway.ts`), so the two cannot drift: every listener
 * has an A record and no A record points at a host with no listener.
 *
 * **Registrar vs. nameservers.** Cloudflare here is a DNS *operator*, not the
 * registrar — the domain can stay registered wherever it is, with its NS
 * records delegated to Cloudflare. GoDaddy in particular cannot be driven from
 * code at all below their API eligibility bar (10+ domains or a Discount Domain
 * Club membership), which is why the delegation is the prerequisite rather than
 * one provider choice among several.
 */

/** Cloudflare's "automatic" TTL sentinel. Mandatory on proxied records. */
export const TTL_AUTOMATIC = 1;

/**
 * RFC 5737 TEST-NET-1 — an address guaranteed never to be routable. It is the
 * content of the apex placeholder record, which exists only to give Cloudflare
 * something to attach the proxy to: a redirect rule runs at the edge and never
 * forwards, so no packet is ever sent here. A real IP in this slot would be a
 * trap — the day the redirect rule is removed, traffic would silently start
 * flowing to whatever that address is instead of failing visibly.
 */
export const UNROUTABLE_PLACEHOLDER = "192.0.2.1";

/**
 * Which of this stack's hosts may sit behind Cloudflare's proxy (orange cloud),
 * and — for the ones that may not — why.
 *
 * The decision is a property of what a host SERVES, not of an operator's
 * preference, so it lives here rather than in stack config. The two hard
 * refusals below were paid for once already, in the comment this replaces: the
 * proxy was left off for EVERY host because two of them break behind it, and
 * the rest lost the free WAF, the free edge cache and a hidden origin for
 * company. Neither constraint was ever zone-wide.
 *
 * Each refusal names a failure that Cloudflare does not report. That is the
 * whole reason this is code: `proxied: true` on the wrong record produces a
 * site that works in every smoke test and fails on the request that matters.
 */
export type ProxyDecision =
  | { host: string; proxied: true }
  | { host: string; proxied: false; reason: string };

/**
 * Cloudflare's free and pro plans reject a request body over this size at the
 * edge, with a 413 the origin never sees and no entry in any log this repo
 * collects.
 *
 * This binds `appDomain`, NOT the object-storage host. Browser uploads do not
 * go to S3 directly: `use-file-upload.ts` POSTs multipart `FormData` to the
 * same-origin `/api/documents/upload`, and the origin writes to storage
 * server-side (`lib/documents/service.ts`). Every uploaded byte therefore
 * crosses the app host.
 */
export const FREE_PLAN_MAX_BODY_MB = 100;

/**
 * `frontends/ui`'s own default maximum file size, in bytes (`shared/config/
 * file-upload.ts`, asserted in `app/layout.spec.ts`).
 *
 * The margin against the cap above is the whole problem: 100 MB decimal against
 * a Cloudflare limit documented as "100 MB" without saying which one, before
 * multipart framing and the other form fields are counted. Too thin to put
 * uploads behind, and the failure is a 413 nothing on our side records.
 * `FILE_UPLOAD_MAX_FILE_SIZE` can raise it further at runtime.
 */
export const UI_DEFAULT_MAX_FILE_BYTES = 100_000_000;

/**
 * Cloudflare closes a proxied WebSocket after this many seconds with no frame
 * in either direction, on every plan below Enterprise.
 *
 * **It does not bind this stack, and the obvious reading of it is wrong.** The
 * chat socket is served by uvicorn with the `websockets` implementation and
 * default `ws_ping_interval` — a protocol-level PING every 20s, pinned
 * explicitly in `deploy/start_web.py` so it stays that way. Those frames pass
 * straight through the raw `http-proxy` splice in `frontends/ui/server.js` and
 * the browser answers each one with a PONG, so a "quiet" chat still puts
 * traffic on the wire roughly five times inside every window this constant
 * describes.
 *
 * Kept, with the arithmetic, because it is the first thing anyone reaches for
 * when asked why the app tier is not proxied, and it is the wrong answer.
 */
export const FREE_PLAN_WS_IDLE_SECONDS = 100;

/** uvicorn's default WebSocket PING cadence, pinned in `deploy/start_web.py`. */
export const BACKEND_WS_PING_SECONDS = 20;

/**
 * The orange/grey verdict for every host this stack publishes.
 *
 * `enabled: false` (the default) returns every host grey with the same reason,
 * so the caller has one shape to render and the stack output always explains
 * itself.
 */
export function proxyPlan(args: {
  enabled: boolean;
  hosts: string[];
  appDomain: string;
  s3Domain: string;
  webDomain: string;
}): ProxyDecision[] {
  return args.hosts.map((host): ProxyDecision => {
    if (!args.enabled) {
      return { host, proxied: false, reason: "grid-oib:dnsProxyEnabled is false" };
    }
    if (host === args.appDomain) {
      // NOT the WebSockets, which is the answer everyone reaches for first and
      // which `FREE_PLAN_WS_IDLE_SECONDS` explains is wrong. It is the uploads:
      // they cross THIS host, and the two limits are within a few percent of
      // each other.
      return {
        host,
        proxied: false,
        reason:
          `document uploads cross this host: use-file-upload.ts POSTs multipart FormData to ` +
          `/api/documents/upload and the origin writes to storage server-side. The free plan ` +
          `rejects a body over ${FREE_PLAN_MAX_BODY_MB} MB at the edge, against a product default ` +
          `of ${UI_DEFAULT_MAX_FILE_BYTES / 1_000_000} MB before multipart framing — a 413 the ` +
          `origin never sees. Presigned direct-to-storage uploads remove this`,
      };
    }
    if (host === args.s3Domain) {
      // Downloads only — `app/httproutes.ts` routes this host at seaweedfs:8333
      // for "browser presigned preview/download URLs", and the browser never
      // PUTs here (every `PutObjectCommand` in the BFF is server-side). So the
      // body cap above does not apply, and this host IS proxyable.
      return {
        host,
        proxied: false,
        reason:
          "presigned preview/download URLs. Proxyable — the body cap applies to requests, and " +
          "the browser only GETs here — but a presigned URL is a bearer credential in the query " +
          "string, so edge caching it needs a cache-key decision this change has not made",
      };
    }
    if (host === args.webDomain) {
      return { host, proxied: true };
    }
    // Fall-through: the operator dashboards (`otelDomain`, `langfuseDomain`) and
    // anything added to the Gateway later. Grey is the posture that cannot break
    // a host nobody has thought about, so an unclassified listener gets it —
    // and gets an answer that says it is unclassified rather than pretending to
    // a reason it was never given.
    return {
      host,
      proxied: false,
      reason:
        "no case in proxyPlan claims this host. The dashboards have no cacheable traffic to win " +
        "and a live-updating socket to lose; anything newer has simply not been classified yet",
    };
  });
}

/** The subset that is actually orange, for the callers that only need the set. */
export function proxiedHosts(plan: ProxyDecision[]): string[] {
  return plan.filter((d) => d.proxied).map((d) => d.host);
}

export interface ManagedDns {
  /** Explicitly constructed so the token comes from stack config, never ambient `CLOUDFLARE_*` env. */
  provider: cloudflare.Provider;
  /** The orange/grey verdict per host, exported so a stack output can explain it. */
  plan: ProxyDecision[];
  /** One A record per Gateway listener host. */
  hostRecords: cloudflare.DnsRecord[];
  /** `www` CNAME and (when configured) the `_dmarc` TXT — zone-level, not stack-level. */
  baselineRecords: cloudflare.DnsRecord[];
  /** Apex placeholder + dynamic-redirect ruleset, when `apexRedirectTo` is set. */
  apexRedirect?: { placeholder: cloudflare.DnsRecord; ruleset: cloudflare.Ruleset };
  /** Zone DNSSEC, when `dnssecEnabled` — still needs the DS record at the registrar. */
  dnssec?: cloudflare.ZoneDnssec;
}

/**
 * Every public host this stack serves, in Gateway listener order.
 *
 * `otelDomain` and `langfuseDomain` appear only when their tiers are actually
 * deployed, mirroring the conditional `https-otel` and `https-langfuse`
 * listeners: a record for a host with no listener resolves, answers with the
 * wrong certificate, and reads as a broken deployment rather than a disabled
 * feature.
 *
 * Derived here rather than inside `installDns` so that `loadConfig` validates
 * the same list it later hands over — a second derivation is a second thing to
 * keep in step with `platform/gateway.ts`.
 */
export function managedHosts(args: {
  webDomain: string;
  appDomain: string;
  s3Domain: string;
  otelDomain?: string;
  langfuseDomain?: string;
}): string[] {
  return [
    args.webDomain,
    args.appDomain,
    args.s3Domain,
    ...(args.otelDomain !== undefined ? [args.otelDomain] : []),
    ...(args.langfuseDomain !== undefined ? [args.langfuseDomain] : []),
  ];
}

/**
 * Names that would land in the wrong place if this zone is not their parent.
 *
 * Called from `loadConfig`, because what it prevents never surfaces as an
 * error. The Cloudflare API treats a record name outside the zone as relative
 * and appends the zone to it, so a `baseDomain` of `dev.piloti.at` against the
 * `example.com` zone yields `app.dev.piloti.at.example.com` — created
 * successfully, reported successfully, resolving nowhere.
 */
export function hostsOutsideZone(hosts: string[], zoneName: string): string[] {
  return hosts.filter((h) => h !== zoneName && !h.endsWith(`.${zoneName}`));
}

export function installDns(cfg: GridConfig): ManagedDns | undefined {
  const dns = cfg.dns;
  if (!dns.enabled) {
    return undefined;
  }

  const provider = new cloudflare.Provider("cloudflare", { apiToken: dns.apiToken });
  const opts = { provider };

  const plan = proxyPlan({
    enabled: dns.proxyEnabled,
    hosts: dns.hosts,
    appDomain: cfg.ingress.appDomain,
    s3Domain: cfg.ingress.s3Domain,
    webDomain: cfg.ingress.webDomain,
  });

  // Orange vs. grey, per host, decided by `proxyPlan` above rather than here —
  // the reason a host is grey belongs next to the classification, not at the one
  // call site that happens to read it. What the plan buys the hosts it CAN
  // proxy: the free WAF managed ruleset, L3/L4 and L7 DDoS absorption, the edge
  // cache (`platform/edge.ts`), and an origin address that never appears in a
  // DNS answer.
  //
  // A proxied record cannot carry an explicit TTL — Cloudflare answers for it
  // itself and rejects the field — so the TTL follows the verdict.
  const hostRecords = plan.map(
    (decision) =>
      new cloudflare.DnsRecord(
        `dns-${decision.host}`,
        {
          zoneId: dns.zoneId,
          name: decision.host,
          type: "A",
          content: dns.targetIp,
          ttl: decision.proxied ? TTL_AUTOMATIC : dns.ttl,
          proxied: decision.proxied,
          comment: decision.proxied
            ? "Managed by Pulumi — proxied (deploy/pulumi/src/platform/dns.ts)"
            : `Managed by Pulumi — not proxied: ${decision.reason}`.slice(0, 100),
        },
        opts,
      ),
  );

  // Zone-level records, owned by AT MOST ONE stack. `loadConfig` refuses the
  // combination that would have two stacks fighting over the apex, because
  // Cloudflare would not: the second `pulumi up` simply overwrites the first
  // one's record and reports success.
  const baselineRecords: cloudflare.DnsRecord[] = [];
  let apexRedirect: ManagedDns["apexRedirect"];
  let dnssec: cloudflare.ZoneDnssec | undefined;

  if (dns.zoneBaseline) {
    // Follows the apex. While the apex is a proxied redirect placeholder this
    // MUST be proxied too — an unproxied CNAME to a proxied apex hands the
    // client Cloudflare's edge address without the proxy state that makes the
    // redirect rule run, so www would answer from the edge instead of
    // redirecting. Proxied records also cannot carry an explicit TTL.
    const apexProxied = plan.some((d) => d.host === dns.zoneName && d.proxied);
    const wwwProxied = dns.apexRedirectTo !== undefined || apexProxied;
    baselineRecords.push(
      new cloudflare.DnsRecord(
        "dns-www",
        {
          zoneId: dns.zoneId,
          name: `www.${dns.zoneName}`,
          type: "CNAME",
          content: dns.zoneName,
          ttl: wwwProxied ? TTL_AUTOMATIC : dns.ttl,
          proxied: wwwProxied,
        },
        opts,
      ),
    );

    if (dns.dmarc !== undefined) {
      baselineRecords.push(
        new cloudflare.DnsRecord(
          "dns-dmarc",
          {
            zoneId: dns.zoneId,
            name: `_dmarc.${dns.zoneName}`,
            type: "TXT",
            content: dns.dmarc,
            ttl: dns.ttl,
            proxied: false,
          },
          opts,
        ),
      );
    }

    if (dns.apexRedirectTo !== undefined) {
      const placeholder = new cloudflare.DnsRecord(
        "dns-apex-placeholder",
        {
          zoneId: dns.zoneId,
          name: dns.zoneName,
          type: "A",
          content: UNROUTABLE_PLACEHOLDER,
          // Proxied is not a preference here: a dynamic-redirect rule only runs
          // on traffic that reaches Cloudflare's edge, so an unproxied record
          // would hand the client the unroutable address above and time out.
          proxied: true,
          // Cloudflare rejects an explicit TTL on a proxied record.
          ttl: TTL_AUTOMATIC,
          comment: "Redirect placeholder — never receives traffic (Pulumi)",
        },
        opts,
      );

      const hosts = [dns.zoneName, `www.${dns.zoneName}`].map((h) => `"${h}"`).join(" ");
      const ruleset = new cloudflare.Ruleset(
        "dns-apex-redirect",
        {
          zoneId: dns.zoneId,
          name: "apex-redirect",
          kind: "zone",
          phase: "http_request_dynamic_redirect",
          description: `Apex and www to ${dns.apexRedirectTo} until a stack owns ${dns.zoneName}`,
          rules: [
            {
              action: "redirect",
              expression: `http.host in {${hosts}}`,
              description: "Apex placeholder redirect",
              actionParameters: {
                fromValue: {
                  targetUrl: { value: dns.apexRedirectTo },
                  // 302, NOT 301. This redirect is scaffolding that goes away
                  // the moment a stack claims the apex for real, and a 301 is
                  // cached by browsers indefinitely — every visitor who hit the
                  // apex once would keep being bounced away from the site that
                  // later lives there, with no way to reach it and no server-side
                  // fix.
                  statusCode: 302,
                  preserveQueryString: true,
                },
              },
            },
          ],
        },
        opts,
      );

      apexRedirect = { placeholder, ruleset };
    }

    // ── CAA ────────────────────────────────────────────────────────────────
    //
    // Names the CAs allowed to issue for this zone. Without any CAA record every
    // public CA on earth may issue for these names, and the first anyone hears
    // of a mis-issued certificate is a CT-log alert nobody is subscribed to.
    //
    // The allowed set is DERIVED from the proxy plan, not listed by hand,
    // because proxying changes it: an orange host is served by a Cloudflare
    // EDGE certificate, and Cloudflare issues those from Let's Encrypt, Google
    // Trust Services or SSL.com at its own discretion. Pin only
    // `letsencrypt.org` while a host is proxied and Universal SSL eventually
    // fails to renew — months later, on a name that has worked all along.
    //
    // `issuewild ";"` refuses wildcards outright: nothing here asks for one, and
    // a wildcard is the certificate whose compromise costs the most.
    if (dns.caaEnabled) {
      const issuers = [
        // The origin's own certificates (`platform/cert-manager.ts`), proxied or not.
        "letsencrypt.org",
        // Cloudflare's edge certificate issuers, needed only while a host is
        // orange — and harmless when none is, which is why they are not
        // conditional: a CAA set that changes as hosts flip proxy state is a
        // second thing to get right at exactly the wrong moment.
        //
        // The first two are the ones Cloudflare's own documentation lists for
        // Universal SSL. `sectigo.com` is NOT in that list, and is here because
        // the Certificate Transparency log for this zone says otherwise: on
        // 2026-08-10, the day the apex placeholder first went proxied,
        // Cloudflare issued TWO edge certificates for `piloti.at` +
        // `*.piloti.at` — one from Google Trust Services and one from Sectigo.
        // The documentation warns that its list "is not exhaustive"; this is
        // what that sentence costs if you take the list literally. Check the
        // logs again before removing it:
        //
        //   curl -s 'https://api.certspotter.com/v1/issuances?domain=<zone>\
        //     &include_subdomains=true&expand=issuer' | jq -r '.[].issuer.name'
        "pki.goog; cansignhttpexchanges=yes",
        "ssl.com",
        "sectigo.com",
      ];
      issuers.forEach((value, i) => {
        baselineRecords.push(
          new cloudflare.DnsRecord(
            `dns-caa-issue-${i}`,
            {
              zoneId: dns.zoneId,
              name: dns.zoneName,
              type: "CAA",
              data: { flags: 0, tag: "issue", value },
              ttl: dns.ttl,
              comment: "Managed by Pulumi (deploy/pulumi/src/platform/dns.ts)",
            },
            opts,
          ),
        );
      });
      baselineRecords.push(
        new cloudflare.DnsRecord(
          "dns-caa-issuewild",
          {
            zoneId: dns.zoneId,
            name: dns.zoneName,
            type: "CAA",
            data: { flags: 0, tag: "issuewild", value: ";" },
            ttl: dns.ttl,
            comment: "Managed by Pulumi — no wildcard certificates for this zone",
          },
          opts,
        ),
      );
      // Where a CA reports a refused issuance request. Reuses the ACME account
      // address rather than inventing a second one: it is already the mailbox
      // that hears about this zone's certificates.
      baselineRecords.push(
        new cloudflare.DnsRecord(
          "dns-caa-iodef",
          {
            zoneId: dns.zoneId,
            name: dns.zoneName,
            type: "CAA",
            data: { flags: 0, tag: "iodef", value: `mailto:${cfg.ingress.letsEncryptEmail}` },
            ttl: dns.ttl,
            comment: "Managed by Pulumi (deploy/pulumi/src/platform/dns.ts)",
          },
          opts,
        ),
      );
    }

    // ── DNSSEC ─────────────────────────────────────────────────────────────
    //
    // Signs the zone so a resolver can tell a real answer from an injected one.
    //
    // HALF of this is outside the program: Cloudflare signs, but the chain is
    // only trusted once the DS record it generates is published AT THE
    // REGISTRAR, which is not Cloudflare here (see the note on delegation at the
    // top of this file). Until that paste happens the zone is signed and nobody
    // validates it — no error, no warning, no benefit. `pulumi stack output
    // dnssecDs` prints what to paste.
    if (dns.dnssecEnabled) {
      dnssec = new cloudflare.ZoneDnssec("dns-dnssec", { zoneId: dns.zoneId, status: "active" }, opts);
    }
  }

  return { provider, plan, hostRecords, baselineRecords, apexRedirect, dnssec };
}

/** Convenience for stack outputs: the FQDNs this stack put in DNS. */
export function managedRecordNames(dns: ManagedDns): pulumi.Output<string>[] {
  return [...dns.hostRecords, ...dns.baselineRecords].map((r) => r.name);
}
