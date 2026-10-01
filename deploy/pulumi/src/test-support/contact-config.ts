/**
 * What the contact address (`platform/contact-mail.ts`) needs on top of
 * {@link baseStackConfig}: the stack must manage the app zone and own it
 * (`dnsEnabled` + `dnsZoneBaseline`), and both of the web tier's secrets.
 *
 * Test support only; no value here is a real credential.
 */
export const CONTACT_ZONE_ID = "zone-app-1";
export const CONTACT_ZONE = "example.test";

/**
 * A stack that manages the app zone and owns it, with nothing routing mail:
 * what any mail feature on the app zone's apex builds on.
 */
export function appZoneStackConfig(): Record<string, string> {
  return {
    "grid-oib:dnsEnabled": "true",
    "grid-oib:dnsZoneId": CONTACT_ZONE_ID,
    "grid-oib:dnsZoneName": CONTACT_ZONE,
    "grid-oib:dnsZoneBaseline": "true",
    "grid-oib:loadBalancerIp": "203.0.113.10",
    "grid-oib:cloudflareApiToken": "cf-token", // pragma: allowlist secret
  };
}

export function contactStackConfig(): Record<string, string> {
  return {
    ...appZoneStackConfig(),
    "grid-oib:contactAddress": `kontakt@${CONTACT_ZONE}`,
    "grid-oib:contactForwardTo": "mail@founder-one.example, mail@founder-two.example",
    "grid-oib:contactEmailToken": "cf-email-sending-token", // pragma: allowlist secret
    "grid-oib:contactFormSecret": "form-hmac-key", // pragma: allowlist secret
  };
}
