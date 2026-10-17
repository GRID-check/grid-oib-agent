/**
 * A stack that manages the app zone and owns it (`dnsEnabled` +
 * `dnsZoneBaseline`), with nothing routing mail yet: what the project mail
 * inbox on the app zone's apex builds on, on top of {@link baseStackConfig}.
 *
 * Test support only; no value here is a real credential.
 */
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
