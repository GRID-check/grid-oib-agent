import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import type { GridConfig } from "../config";
import { appOrigin } from "../app/config";
import type { MailZone } from "./email-routing";

/**
 * Project mail (ADR-0135): the catch-all of `inboundMailDomain`'s zone, handing
 * every unclaimed address to one Email Worker (`inbound-mail-worker.js`),
 * which signs project addresses' mail for the BFF and refuses the rest.
 *
 * Email Routing on the zone (the provider, the guards, the enablement) is
 * `installInboundMailZone` in `email-routing.ts`. Nothing here runs in the
 * cluster; the in-cluster parts are the frontend's env (`app/config.ts`) and
 * the signed route at the edge (`app/httproutes.ts`, `SIGNED_INTERNAL_ROUTE`).
 *
 * ## On, managed off, paused
 *
 *   - **On** (`inboundMailDomain` set): the Worker, and the catch-all enabled
 *     and pointing at it.
 *   - **Managed off** (`inboundMailEnabled: false`): the catch-all is updated
 *     in place to disabled, so Cloudflare refuses every unclaimed address at
 *     SMTP time and the sender sees a bounce, rather than Drop, which accepts
 *     and discards and so loses mail silently. Pulumi then deletes the Worker:
 *     deletions run after every update in a `pulumi up`, so the catch-all
 *     stops naming the Worker before the Worker is gone. Unsetting the domain
 *     instead would delete the catch-all resource, which the provider does not
 *     undo at Cloudflare, leaving it pointed at a deleted Worker.
 *   - **Paused** (`inboundMailPaused`): the Worker answers every project
 *     address with a temporary failure before reading the message, and the
 *     BFF answers 503. Senders retry for days; the first promote with a domain
 *     is paused, and launch gates G1–G9 run before the unpause.
 *
 * ## The product's own apex, with the Worker as the router
 *
 * Project addresses live on the product domain (`<slug>.<token>@piloti.at`).
 * The zone's catch-all sends every address that no literal rule claims to the
 * Worker. Cloudflare matches literal rules first, so a company address given a
 * rule of its own (`postmaster@`, `abuse@`, set up in the dashboard before the
 * first promote, gate G7) never reaches it. The Worker checks the recipient's
 * shape against `shared/inbound-address.json` and refuses everything that is
 * not a project address itself.
 *
 * The cost: the product domain's mail has to stay on Cloudflare Email Routing.
 * Moving it to another provider means moving project mail to a domain of its
 * own (still supported: point `inboundMailDomain`/`inboundMailZoneId` at
 * another zone's apex) and giving every project a new address.
 *
 * ## Why an apex, not a subdomain
 *
 * Cloudflare's catch-all exists only for a zone's apex:
 *
 *   - Cloudflare's Email Service docs, "Subdomains" (last updated 2026-09-25):
 *     "Catch-all rules are only available for the apex domain."
 *     developers.cloudflare.com/email-service/configuration/subdomains/
 *   - The API agrees: the catch-all is one object per ZONE
 *     (`/zones/{zone_id}/email/routing/rules/catch_all`, no domain field, and
 *     `matchers` accepts only `all`).
 *   - A child zone for the subdomain ("subdomain setup") is Enterprise-only.
 *
 * Literal rules per project address do not scale (200 routing rules per
 * domain, and the BFF would need a Cloudflare credential to mint an address).
 * `loadConfig` refuses the subdomain-of-the-DNS-zone case statically; the zone
 * lookup in `installInboundMailZone` refuses every other mismatch at preview.
 *
 * ## One stack per inbound zone
 *
 * The catch-all is a singleton per zone. Two stacks pointed at the same zone do
 * not conflict in any way Cloudflare reports: the later `pulumi up` rewrites
 * the catch-all to its own Worker. `loadConfig` ties project mail on the app
 * zone to the stack that owns the zone (`dnsZoneBaseline`);
 * `stack-files.spec.ts` checks the committed stacks.
 *
 * ## Secrets
 *
 * The signing key is a `secret_text` binding: a plain one is readable by
 * anyone with Workers read access to the account. A binding edited in the
 * dashboard is restored from state by the next `up` (and not repaired by a
 * `refresh`), so the key is rotated only through `inboundMailSigningKeys` and
 * `inboundMailSigningKeyId`, never in the dashboard.
 *
 * ## Privacy at Cloudflare
 *
 * Workers observability is OFF and said so: Workers Logs would keep a record
 * of every delivery at Cloudflare, beyond the Email Routing activity log the
 * privacy notice names.
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

/**
 * Runtime semantics the Worker was written against. Bump deliberately, and
 * re-run gates G1 and G2 after (G8): that a thrown error is a temporary SMTP
 * failure is platform behaviour Cloudflare does not document.
 * `inbound-mail.spec.ts` fails once it is a year old, to force that decision.
 */
export const COMPATIBILITY_DATE = "2026-10-01";

/** The Worker module, uploaded verbatim (no bundler: it has no imports). */
const WORKER_FILE = "inbound-mail-worker.js";

export interface InboundMail {
  zone: MailZone;
  /** Absent while switched off. */
  script?: cloudflare.WorkersScript;
  catchAll: cloudflare.EmailRoutingCatchAll;
}

/** The Worker's script name. Per stack, because scripts are per ACCOUNT and stacks may share one. */
export function workerScriptName(stack: string): string {
  return `grid-inbound-mail-${stack}`;
}

/**
 * Project mail on `zone` (from `installInboundMailZone`), which is undefined
 * exactly when no domain is set.
 */
export function installInboundMail(cfg: GridConfig, zone: MailZone | undefined): InboundMail | undefined {
  const mail = cfg.inboundMail;
  if (!mail.configured || zone === undefined) return undefined;
  const opts = { provider: zone.provider };
  const scriptName = workerScriptName(pulumi.getStack());

  if (!mail.enabled) {
    const catchAll = new cloudflare.EmailRoutingCatchAll(
      "inbound-mail-catch-all",
      {
        zoneId: zone.zoneId,
        name: "Project mail (switched off)",
        // Disabled, not Drop: Cloudflare then refuses unclaimed addresses at
        // SMTP time. The action is required by the API and inert while
        // disabled; it no longer names the Worker, which this `up` deletes.
        enabled: false,
        matchers: [{ type: "all" }],
        actions: [{ type: "drop" }],
      },
      { ...opts, dependsOn: [zone.routing] },
    );
    return { zone, catchAll };
  }

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
      observability: { enabled: false },
      bindings: [
        // The origin the BFF checks `@target-uri` against: one function for both.
        { name: "BFF_URL", type: "plain_text", text: appOrigin(cfg) },
        { name: "SIGNING_KEY_ID", type: "plain_text", text: mail.signingKeyId },
        { name: "SIGNING_KEY", type: "secret_text", text: mail.signingKey },
        { name: "PAUSED", type: "plain_text", text: String(mail.paused) },
      ],
    },
    opts,
  );

  const catchAll = new cloudflare.EmailRoutingCatchAll(
    "inbound-mail-catch-all",
    {
      zoneId: zone.zoneId,
      name: `Project mail (${scriptName})`,
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", values: [script.scriptName] }],
    },
    { ...opts, dependsOn: [script, zone.routing] },
  );

  return { zone, script, catchAll };
}
