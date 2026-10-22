/**
 * Stack configurations for project mail (ADR-0135), on top of
 * {@link baseStackConfig}. Test support only; no value here is a real
 * credential.
 */

/** A stack that manages the app zone and owns it (`dnsEnabled` + `dnsZoneBaseline`). */
export const APP_ZONE_ID = "zone-app-1";
export const APP_ZONE = "example.test";

export function appZoneStackConfig(): Record<string, string> {
  return {
    "grid-oib:dnsEnabled": "true",
    "grid-oib:dnsZoneId": APP_ZONE_ID,
    "grid-oib:dnsZoneName": APP_ZONE,
    "grid-oib:dnsZoneBaseline": "true",
    "grid-oib:loadBalancerIp": "203.0.113.10",
    "grid-oib:cloudflareApiToken": "cf-token", // pragma: allowlist secret
  };
}

/** The keyid and base64 secret of {@link SIGNING_KEYS}: 32 bytes of 0x11. */
export const SIGNING_KEY_ID = "mi-2026-10";
export const SIGNING_SECRET = Buffer.alloc(32, 0x11).toString("base64"); // pragma: allowlist secret

/** A one-key map, as `inboundMailSigningKeys` holds it. */
export const SIGNING_KEYS = JSON.stringify({ [SIGNING_KEY_ID]: SIGNING_SECRET });

/**
 * Everything project mail needs besides its domain and zone: the scanner it
 * refuses to run without, the signing keys and the Cloudflare token.
 */
export function mailStackConfig(): Record<string, string> {
  return {
    "grid-oib:malwareScanEnabled": "true",
    "grid-oib:inboundMailSigningKeys": SIGNING_KEYS,
    "grid-oib:cloudflareApiToken": "cf-token", // pragma: allowlist secret
  };
}
