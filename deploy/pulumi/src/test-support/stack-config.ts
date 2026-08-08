/**
 * A minimal stack configuration that satisfies every `require` /
 * `requireSecret` in `loadConfig`, so a test about one knob is never defeated
 * by a different missing one.
 *
 * Test support only. Nothing here is a real credential — the values exist to
 * be non-empty.
 */
export function baseStackConfig(): Record<string, string> {
  return {
    "grid-oib:kubeconfig": "apiVersion: v1",
    "grid-oib:baseDomain": "example.test",
    "grid-oib:storageClass": "premium",
    "grid-oib:letsEncryptEmail": "ops@example.test",
    "grid-oib:seaweedfsSecretKey": "s3-secret", // pragma: allowlist secret
    "grid-oib:seaweedfsBackendReadSecretKey": "read-secret", // pragma: allowlist secret
    "grid-oib:seaweedfsFilerDbPassword": "filer-secret", // pragma: allowlist secret
    "grid-oib:seaweedfsTenantAdminSecretKey": "tenant-secret", // pragma: allowlist secret
    "grid-oib:pgAppPassword": "pg-secret", // pragma: allowlist secret
    "grid-oib:pgRuntimePassword": "rw-secret", // pragma: allowlist secret
    "grid-oib:workosApiKey": "workos", // pragma: allowlist secret
    "grid-oib:workosClientId": "client",
    "grid-oib:workosCookiePassword": "cookie-cookie-cookie-cookie-cookie-x", // pragma: allowlist secret
    "grid-oib:gridInternalApiToken": "internal", // pragma: allowlist secret
    "grid-oib:gridAdminToken": "admin", // pragma: allowlist secret
    "grid-oib:tavilyApiKey": "tavily", // pragma: allowlist secret
    "grid-oib:openrouterApiKey": "or", // pragma: allowlist secret
    "grid-oib:dragonflyPassword": "df", // pragma: allowlist secret
    "grid-oib:rateLimitStorePassword": "rl", // pragma: allowlist secret
  };
}
