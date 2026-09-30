import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import type { GridConfig } from "../config";
import { checkedRoutingZone } from "./email-routing";

/**
 * Project mail inbox: Cloudflare Email Routing for `inboundMailDomain`, and a
 * catch-all that hands every message to one Email Worker
 * (`inbound-mail-worker.js`), which streams it to the BFF.
 *
 * Created only when `inboundMailDomain` is set. Nothing here runs in the
 * cluster; the only in-cluster parts are the frontend's two env vars
 * (`app/config.ts`) and the edge rate-limit bucket (`app/httproutes.ts`).
 *
 * ## Why the domain must be a zone apex, not `eingang.<baseDomain>`
 *
 * The obvious design is a subdomain of the zone the stack already lives in.
 * It does not work, and it fails without an error:
 *
 *   - Cloudflare's Email Service docs, "Subdomains" (last updated 2026-09-25):
 *     "Once the records propagate, you can create literal routing rules for
 *     addresses on the subdomain. Catch-all rules are only available for the
 *     apex domain." And "Email routing rules and addresses": "Catch-all
 *     entries support apex domains only."
 *     developers.cloudflare.com/email-service/configuration/subdomains/
 *     developers.cloudflare.com/email-service/configuration/email-routing-addresses/
 *   - The API agrees: the catch-all is one object per ZONE
 *     (`/zones/{zone_id}/email/routing/rules/catch_all`, no domain field, and
 *     `matchers` accepts only `all`), and it applies to the apex.
 *   - Deploying `*@<subdomain>` fails with 2062 "Unknown Email Routing domain"
 *     even with the subdomain enabled (cloudflare/workers-sdk#15521, opened
 *     2026-09-05, untriaged).
 *   - The blog post that announced subdomains (blog.cloudflare.com/
 *     email-routing-subdomains/) describes custom ADDRESSES on a subdomain,
 *     which are literal rules.
 *
 * Literal rules per project address do not scale either: 200 routing rules per
 * domain (Email Routing limits page), and the BFF would need a Cloudflare
 * credential to mint an address. A child zone for the subdomain ("subdomain
 * setup") is Enterprise-only (developers.cloudflare.com/dns/zone-setups/
 * subdomain-setup/, Availability: Enterprise).
 *
 * So `inboundMailDomain` must be the APEX of `inboundMailZoneId`: a domain of
 * its own (e.g. `piloti-post.at`), or the stack's own zone apex if nothing else
 * receives mail there (the MX guard below checks). `loadConfig` refuses the
 * subdomain-of-the-DNS-zone case statically; the zone lookup below refuses
 * every other mismatch at preview.
 *
 * ## The apex must not already receive mail elsewhere
 *
 * The catch-all takes EVERY address on the apex, so an apex that is the
 * company's own mail domain would have all of its mail captured. The preview
 * refuses an apex whose MX records point anywhere but Cloudflare
 * (`assertNoForeignMx` in `email-routing.ts`, which explains the rule).
 *
 * ## One stack per inbound zone
 *
 * The catch-all is a singleton per zone. Two stacks pointed at the same zone do
 * not conflict in any way Cloudflare reports: the later `pulumi up` rewrites
 * the catch-all to its own Worker and every mail goes to that stack.
 * `stack-files.spec.ts` checks the committed stacks.
 *
 * ## Cloudflare API token scopes (on `cloudflareApiToken`)
 *
 *   - Account · Workers Scripts · Edit (the Worker)
 *   - Zone · Email Routing Rules · Edit (the catch-all), on the inbound zone
 *   - Zone · Zone Settings · Edit (enabling routing, `email/routing/dns`)
 *   - Zone · DNS · Edit (routing adds and locks its MX and SPF records; the
 *     MX guard reads them)
 *   - Zone · Zone · Read (`getZone`: the apex check and the account id)
 */

/** Largest body the edge must pass to the BFF: Cloudflare's 25 MiB inbound cap plus headroom. */
export const INBOUND_MAIL_MAX_BODY_BYTES = 26 * 1024 * 1024;

/** Runtime semantics the Worker was written against; bump deliberately. */
const COMPATIBILITY_DATE = "2026-09-01";

/** The Worker module, uploaded verbatim (no bundler: it has no imports). */
const WORKER_FILE = "inbound-mail-worker.js";

export interface InboundMail {
  provider: cloudflare.Provider;
  script: cloudflare.WorkersScript;
  routing: cloudflare.EmailRoutingDns;
  catchAll: cloudflare.EmailRoutingCatchAll;
}

/** The Worker's script name. Per stack, because scripts are per ACCOUNT and stacks may share one. */
export function workerScriptName(stack: string): string {
  return `grid-inbound-mail-${stack}`;
}

/**
 * Refuse a domain that is not its zone's apex. Thrown inside the zone lookup,
 * so `pulumi preview` fails before the Worker or the catch-all exist.
 */
export function assertZoneApex(domain: string, zoneId: string, zoneName: string): void {
  if (zoneName === domain) return;
  throw new Error(
    `grid-oib:inboundMailDomain is "${domain}" but zone ${zoneId} is "${zoneName}". The ` +
      "domain must be the zone's apex: Cloudflare Email Routing has no catch-all for " +
      "subdomains, so mail to project addresses would be refused.",
  );
}

export function installInboundMail(cfg: GridConfig): InboundMail | undefined {
  const mail = cfg.inboundMail;
  if (!mail.enabled) {
    return undefined;
  }

  // Its own provider rather than the DNS module's: that one exists only while
  // `dnsEnabled`, and the inbound zone need not be the DNS zone.
  const provider = new cloudflare.Provider("cloudflare-inbound-mail", { apiToken: mail.apiToken });
  const opts = { provider };

  // The zone lookups are the guards (see the header): the domain is the
  // zone's apex, and the apex receives no mail elsewhere. Every resource below
  // takes its account id or zone id from `checked`, so none of them is
  // registered unless both guards passed.
  const checked = checkedRoutingZone({
    configKey: "inboundMailDomain",
    zoneId: mail.zoneId,
    domain: mail.domain,
    provider,
    checkZoneName: (zoneName) => assertZoneApex(mail.domain, mail.zoneId, zoneName),
  });
  const accountId = checked.accountId;
  const zoneId = checked.zoneId;

  const appOrigin = `https://${cfg.ingress.appDomain}`;
  const scriptName = workerScriptName(pulumi.getStack());
  const script = new cloudflare.WorkersScript(
    "inbound-mail-worker",
    {
      accountId,
      scriptName,
      mainModule: WORKER_FILE,
      content: readFileSync(join(__dirname, WORKER_FILE), "utf8"),
      compatibilityDate: COMPATIBILITY_DATE,
      bindings: [
        { name: "BFF_URL", type: "plain_text", text: appOrigin },
        { name: "INBOUND_MAIL_TOKEN", type: "secret_text", text: mail.token },
      ],
    },
    opts,
  );

  // Enables Email Routing on the apex and adds (and locks) its MX and SPF
  // records. `email/routing/dns` rather than the older `email/routing/enable`
  // (`EmailRoutingSettings`): same effect, and this one names the domain.
  const routing = new cloudflare.EmailRoutingDns(
    "inbound-mail-routing",
    { zoneId, name: mail.domain },
    opts,
  );

  const catchAll = new cloudflare.EmailRoutingCatchAll(
    "inbound-mail-catch-all",
    {
      zoneId,
      name: `Project mail inbox (${scriptName})`,
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", values: [script.scriptName] }],
    },
    { provider, dependsOn: [script, routing] },
  );

  return { provider, script, routing, catchAll };
}
