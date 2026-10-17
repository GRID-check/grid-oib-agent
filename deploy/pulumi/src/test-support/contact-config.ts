import { APP_ZONE, APP_ZONE_ID, appZoneStackConfig } from "./app-zone-config";

/**
 * What the contact address (`platform/contact-mail.ts`) needs on top of
 * {@link appZoneStackConfig}: the address on the app zone's apex, where it goes,
 * and both of the web tier's secrets.
 *
 * Test support only; no value here is a real credential.
 */
export const CONTACT_ZONE_ID = APP_ZONE_ID;
export const CONTACT_ZONE = APP_ZONE;

export { appZoneStackConfig };

export function contactStackConfig(): Record<string, string> {
  return {
    ...appZoneStackConfig(),
    "grid-oib:contactAddress": `kontakt@${CONTACT_ZONE}`,
    "grid-oib:contactForwardTo": "mail@founder-one.example, mail@founder-two.example",
    "grid-oib:contactEmailToken": "cf-email-sending-token", // pragma: allowlist secret
    "grid-oib:contactFormSecret": "form-hmac-key", // pragma: allowlist secret
  };
}
