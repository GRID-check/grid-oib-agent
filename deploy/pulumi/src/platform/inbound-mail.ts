import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import type { GridConfig } from "../config";
import type { MailZone } from "./email-routing";

/**
 * Project mail inbox: the catch-all of `inboundMailDomain`'s zone, handing
 * every unclaimed address to one Email Worker (`inbound-mail-worker.js`),
 * which streams project addresses to the BFF and refuses the rest.
 *
 * Created only when `inboundMailDomain` is set. Email Routing on the zone (the
 * provider, the guards, the enablement) is `installMailZones` in
 * `email-routing.ts`, shared with the contact address when both are on the
 * product's own apex. Nothing here runs in the cluster; the only in-cluster
 * parts are the frontend's two env vars (`app/config.ts`) and the edge
 * rate-limit bucket (`app/httproutes.ts`).
 *
 * ## The product's own apex, with the Worker as the router
 *
 * Project addresses live on the product domain (`<slug>.<token>@piloti.at`).
 * The zone's catch-all sends every address that no literal rule claims to the
 * Worker. Cloudflare matches literal rules first, so `kontakt@`
 * (`contact-mail.ts`) and any other company address given a rule never reach
 * it. The Worker checks the recipient's shape against the address contract in
 * `shared/inbound-address.json` and refuses everything that is not a project
 * address itself, so typos and spam to random names get the "unknown
 * address" answer they always got, without touching the BFF.
 *
 * The cost: the product domain's mail has to stay on Cloudflare Email Routing.
 * Moving it to another provider means moving the inbox to a domain of its own
 * (still supported: point `inboundMailDomain`/`inboundMailZoneId` at another
 * zone's apex) and giving every project a new address.
 *
 * ## Why an apex, not `eingang.<baseDomain>`
 *
 * Cloudflare's catch-all exists only for a zone's apex:
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
 *   - A child zone for the subdomain ("subdomain setup") is Enterprise-only
 *     (developers.cloudflare.com/dns/zone-setups/subdomain-setup/).
 *
 * Literal rules per project address do not scale (200 routing rules per
 * domain, and the BFF would need a Cloudflare credential to mint an address),
 * and plus-addressing (`projekt+<slug>.<token>@`) was rejected in ADR-0075.
 * `loadConfig` refuses the subdomain-of-the-DNS-zone case statically; the zone
 * lookup in `installMailZones` refuses every other mismatch at preview.
 *
 * ## The apex must not already receive mail elsewhere
 *
 * The catch-all takes every unclaimed address on the apex, so an apex whose
 * MX point at another provider would have that provider's mail captured. The
 * preview refuses it (`assertNoForeignMx` in `email-routing.ts`).
 *
 * ## One stack per inbound zone
 *
 * The catch-all is a singleton per zone. Two stacks pointed at the same zone do
 * not conflict in any way Cloudflare reports: the later `pulumi up` rewrites
 * the catch-all to its own Worker and every mail goes to that stack.
 * `loadConfig` ties an inbox on the app zone to the stack that owns the zone
 * (`dnsZoneBaseline`); `stack-files.spec.ts` checks the committed stacks.
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
  zone: MailZone;
  script: cloudflare.WorkersScript;
  catchAll: cloudflare.EmailRoutingCatchAll;
}

/** The Worker's script name. Per stack, because scripts are per ACCOUNT and stacks may share one. */
export function workerScriptName(stack: string): string {
  return `grid-inbound-mail-${stack}`;
}

/**
 * The inbox on `zone` (from `installMailZones`), which is undefined exactly
 * when the inbox is off.
 */
export function installInboundMail(cfg: GridConfig, zone: MailZone | undefined): InboundMail | undefined {
  const mail = cfg.inboundMail;
  if (!mail.enabled || zone === undefined) {
    return undefined;
  }
  const opts = { provider: zone.provider };

  const appOrigin = `https://${cfg.ingress.appDomain}`;
  const scriptName = workerScriptName(pulumi.getStack());
  // `zone.accountId` comes out of the guarded zone lookup, so the Worker is
  // not registered unless the apex and MX guards passed.
  const script = new cloudflare.WorkersScript(
    "inbound-mail-worker",
    {
      accountId: zone.accountId,
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

  const catchAll = new cloudflare.EmailRoutingCatchAll(
    "inbound-mail-catch-all",
    {
      zoneId: zone.zoneId,
      name: `Project mail inbox (${scriptName})`,
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", values: [script.scriptName] }],
    },
    { ...opts, dependsOn: [script, zone.routing] },
  );

  return { zone, script, catchAll };
}
