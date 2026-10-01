import * as cloudflare from "@pulumi/cloudflare";
import type * as pulumi from "@pulumi/pulumi";
import type { GridConfig } from "../config";
import type { MailZone } from "./email-routing";

/**
 * The company's contact address, e.g. `kontakt@piloti.at`: Cloudflare Email
 * Routing on the app zone's apex, forwarding that ONE address to the founders'
 * own mailboxes (`contactForwardTo`).
 *
 * Created only when `contactAddress` is set, and only on the stack that owns
 * the zone (`dnsZoneBaseline`; `loadConfig` refuses the rest). Nothing here
 * runs in the cluster; the web pods get the account id from here and send the
 * contact form through Cloudflare's Email Service to the same addresses
 * (`app/web.ts`).
 *
 * ## One literal rule; the catch-all is the inbox's
 *
 * This module routes exactly the one address. Email Routing on the zone (the
 * provider, the guards, the enablement) is `installMailZones` in
 * `email-routing.ts`, which the project mail inbox (`inbound-mail.ts`) shares
 * when it lives on the same apex. Cloudflare matches this literal rule before
 * the inbox's catch-all, so the contact address never reaches the inbox's
 * Worker. Without the inbox, every other address on the apex has no rule and
 * is refused by Cloudflare; with it, the Worker refuses every address that is
 * not a project address with the same "unknown address" answer.
 *
 * ## The apex must not already receive mail elsewhere
 *
 * Enabling routing moves the apex's MX to Cloudflare, so a company mailbox
 * already delivered there would stop arriving. The preview refuses that
 * (`assertNoForeignMx` in `email-routing.ts`), and refuses a `dnsZoneId` whose
 * real name is not `dnsZoneName` (`assertZoneApex`).
 *
 * ## Destination addresses must be verified, once, by a person
 *
 * Cloudflare forwards only to VERIFIED destination addresses, and the Email
 * Service sends free only to those. Creating an `EmailRoutingAddress` makes
 * Cloudflare send a verification mail to that inbox; until its owner clicks
 * the link, the address is `unverified` and mail to it is not delivered.
 * `pulumi up` succeeds either way, so the click is a deploy step
 * (docs/deployment/kubernetes.md, "Contact address and form"). Destination
 * addresses belong to the ACCOUNT, not the zone: one that already exists
 * there (added by hand in the dashboard) makes the create fail, and is
 * adopted with `pulumi import` instead.
 *
 * ## Email Sending onboarding is a dashboard step, and must not break DMARC
 *
 * The form sends from `contactAddress` through Cloudflare's Email Service,
 * which requires the domain to be onboarded for Email Sending. The provider
 * (@pulumi/cloudflare 6.19) has no resource for that, so it is a one-time
 * dashboard step (docs/deployment/kubernetes.md §3d). It adds records on
 * `cf-bounce.<apex>` (MX, SPF, DKIM at `cf-bounce._domainkey`), which neither
 * the MX guard (apex only) nor the routing resources touch, and a `_dmarc`
 * record (`v=DMARC1; p=reject;`), which would sit beside `dnsDmarc`'s. The
 * preview refuses a zone with two (`assertSingleDmarc`, run by
 * `installMailZones` on the contact zone). Its "Email preview" keeps SENT
 * messages for about seven days and is on by default: it must be switched
 * off, since form messages are personal data. Neither is in the API this
 * program can reach.
 *
 * ## Cloudflare API token scopes (the stack's `cloudflareApiToken`)
 *
 *   - Account · Email Routing Addresses · Edit (the destination addresses)
 *   - Zone · Email Routing Rules · Edit (the rule), on the app zone
 *   - Zone · Zone Settings · Edit (enabling routing, `email/routing/dns`)
 *   - Zone · DNS · Edit (routing adds and locks its MX and SPF records; the
 *     MX guard reads them)
 *   - Zone · Zone · Read (`getZone`: the apex check and the account id)
 *
 * The web pods never hold this token. They get `contactEmailToken`, a token of
 * its own with Account · Email Sending · Edit and nothing else.
 */

export interface ContactMail {
  zone: MailZone;
  addresses: cloudflare.EmailRoutingAddress[];
  rule: cloudflare.EmailRoutingRule;
  /** The account that owns the app zone: the one the web pods send through. */
  accountId: pulumi.Output<string>;
}

/** A Pulumi name for a destination address, stable across reorderings of the list. */
function addressResourceName(address: string): string {
  return `contact-mail-destination-${address.replace(/[^a-z0-9]+/g, "-")}`;
}

/**
 * The contact address on `zone` (from `installMailZones`), which is undefined
 * exactly when the contact address is off.
 */
export function installContactMail(cfg: GridConfig, zone: MailZone | undefined): ContactMail | undefined {
  const contact = cfg.contact;
  if (!contact.enabled || zone === undefined) {
    return undefined;
  }
  const opts = { provider: zone.provider };

  // Creating one sends Cloudflare's verification mail to that inbox. Until
  // its owner clicks the link, nothing is forwarded to it (see the header).
  // `zone.accountId` comes out of the guarded zone lookup, so nothing here is
  // registered unless the zone, MX and DMARC guards passed.
  const addresses = contact.forwardTo.map(
    (email) =>
      new cloudflare.EmailRoutingAddress(
        addressResourceName(email),
        { accountId: zone.accountId, email },
        opts,
      ),
  );

  const rule = new cloudflare.EmailRoutingRule(
    "contact-mail-rule",
    {
      zoneId: zone.zoneId,
      name: `Contact address (${contact.address})`,
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: contact.address }],
      actions: [{ type: "forward", values: addresses.map((a) => a.email) }],
    },
    { ...opts, dependsOn: [zone.routing, ...addresses] },
  );

  return { zone, addresses, rule, accountId: zone.accountId };
}
