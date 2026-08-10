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

export interface ManagedDns {
  /** Explicitly constructed so the token comes from stack config, never ambient `CLOUDFLARE_*` env. */
  provider: cloudflare.Provider;
  /** One A record per Gateway listener host. */
  hostRecords: cloudflare.DnsRecord[];
  /** `www` CNAME and (when configured) the `_dmarc` TXT — zone-level, not stack-level. */
  baselineRecords: cloudflare.DnsRecord[];
  /** Apex placeholder + dynamic-redirect ruleset, when `apexRedirectTo` is set. */
  apexRedirect?: { placeholder: cloudflare.DnsRecord; ruleset: cloudflare.Ruleset };
}

/**
 * Every public host this stack serves, in Gateway listener order.
 *
 * `otelDomain` appears only when the observability tier is actually deployed,
 * mirroring the conditional `https-otel` listener: a record for a host with no
 * listener resolves, answers with the wrong certificate, and reads as a broken
 * deployment rather than a disabled feature.
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
}): string[] {
  return [
    args.webDomain,
    args.appDomain,
    args.s3Domain,
    ...(args.otelDomain !== undefined ? [args.otelDomain] : []),
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

  // Deliberately NOT proxied (Cloudflare "grey cloud"). Three separate things
  // in this stack break behind the orange cloud, and all three break quietly:
  //
  //   - cert-manager solves ACME HTTP-01 through the Gateway
  //     (`platform/cert-manager.ts`). Proxying terminates TLS at Cloudflare and
  //     serves its own certificate, so the Gateway's own certificate never
  //     renews and nobody notices until it expires.
  //   - `s3Domain` carries browser uploads via presigned URLs. Cloudflare's
  //     free plan caps a request body at 100 MB; past that the upload fails at
  //     the edge, with no entry in any log this repo collects.
  //   - The app tier is WebSocket-heavy (ADR-0028 pins a conversation to its
  //     owning replica). Proxied WebSockets work, but add an idle timeout the
  //     Gateway's own configuration no longer controls.
  //
  // Turning this on is a real option — it just has to be a deliberate one, made
  // together with a DNS-01 issuer and a paid upload limit, not a default.
  const hostRecords = dns.hosts.map(
    (host) =>
      new cloudflare.DnsRecord(
        `dns-${host}`,
        {
          zoneId: dns.zoneId,
          name: host,
          type: "A",
          content: dns.targetIp,
          ttl: dns.ttl,
          proxied: false,
          comment: "Managed by Pulumi (deploy/pulumi/src/platform/dns.ts)",
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

  if (dns.zoneBaseline) {
    // Follows the apex. While the apex is a proxied redirect placeholder this
    // MUST be proxied too — an unproxied CNAME to a proxied apex hands the
    // client Cloudflare's edge address without the proxy state that makes the
    // redirect rule run, so www would answer from the edge instead of
    // redirecting. Proxied records also cannot carry an explicit TTL.
    const wwwProxied = dns.apexRedirectTo !== undefined;
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
  }

  return { provider, hostRecords, baselineRecords, apexRedirect };
}

/** Convenience for stack outputs: the FQDNs this stack put in DNS. */
export function managedRecordNames(dns: ManagedDns): pulumi.Output<string>[] {
  return [...dns.hostRecords, ...dns.baselineRecords].map((r) => r.name);
}
