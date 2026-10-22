import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { assertNoForeignMx, ROUTING_RESOURCE_OPTIONS } from "./email-routing";

/**
 * The apex MX guard the inbox's Email Routing runs before creating anything
 * (`email-routing.ts`). The refusal is tested on the function: under Pulumi's
 * mocks a failed guard surfaces only as an unhandled rejection from resource
 * registration. `inbound-mail.spec.ts` shows that the lookup is made and that
 * the resources are created when it passes.
 */

const DOMAIN = "post.example.test";
const ZONE_ID = "zone-mail-1";
const KEY = "grid-oib:inboundMailDomain";

const mx = (content: string, name = DOMAIN) => ({ name, content });
const CLOUDFLARE_MX = ["route1", "route2", "route3"].map((h) => mx(`${h}.mx.cloudflare.net`));

const guard = (records: Array<{ name: string; content: string }>) => () =>
  assertNoForeignMx(KEY, DOMAIN, ZONE_ID, records);

describe("the apex MX guard", () => {
  it("refuses an apex whose mail goes elsewhere, naming the key and the hosts", () => {
    expect(guard([mx("post-example-test.mail.protection.outlook.com")])).toThrow(
      /grid-oib:inboundMailDomain.*already receives mail elsewhere.*post-example-test\.mail\.protection\.outlook\.com/,
    );
  });

  it("refuses a foreign MX even beside Cloudflare's own", () => {
    // A half-migrated domain: Email Routing would still take the mail that
    // lands on Cloudflare's MX, which is some of the company's.
    expect(guard([...CLOUDFLARE_MX, mx("aspmx.l.google.com")])).toThrow(/aspmx\.l\.google\.com/);
  });

  it("refuses a null MX, which says the domain takes no mail at all", () => {
    expect(guard([mx(".")])).toThrow(/point at \./);
  });

  it("refuses a look-alike that is not under mx.cloudflare.net", () => {
    expect(guard([mx("route1.mx.cloudflare.net.evil.example")])).toThrow(/elsewhere/);
    expect(guard([mx("mx.cloudflare.net")])).toThrow(/elsewhere/);
  });

  it("allows an apex with no MX records (the first run)", () => {
    expect(guard([])).not.toThrow();
  });

  it("allows Cloudflare's MX (every later run), in any case and with the root dot", () => {
    expect(guard(CLOUDFLARE_MX)).not.toThrow();
    expect(
      guard([mx("Route1.MX.Cloudflare.NET."), mx("route2.mx.cloudflare.net", `${DOMAIN}.`)]),
    ).not.toThrow();
  });

  it("ignores MX records on other names, which routing on the apex does not touch", () => {
    // Cloudflare Email Sending's own bounce MX, and an outbound provider's.
    expect(
      guard([
        mx("route1.mx.cloudflare.net", `cf-bounce.${DOMAIN}`),
        mx("feedback-smtp.eu-central-1.amazonses.com", `send.${DOMAIN}`),
      ]),
    ).not.toThrow();
  });
});

describe("Email Routing on the zone", () => {
  it("is left on when the inbox is switched off or the stack destroyed", () => {
    // Deleting the routing resource switches Email Routing off for the whole
    // zone, and every company address on the domain stops receiving mail.
    expect(ROUTING_RESOURCE_OPTIONS.retainOnDelete).toBe(true);
    // A resource option, which the mocks do not carry: check it is applied.
    expect(readFileSync(join(__dirname, "email-routing.ts"), "utf8")).toMatch(
      /new cloudflare\.EmailRoutingDns\([^;]*\{ provider, \.\.\.ROUTING_RESOURCE_OPTIONS \}/,
    );
  });
});
