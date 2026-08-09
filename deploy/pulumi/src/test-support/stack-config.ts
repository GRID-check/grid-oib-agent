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

/**
 * Everything the Langfuse tier (ADR-0044) needs on top of {@link baseStackConfig}.
 *
 * Separate rather than merged in, because `langfuseEnabled` defaults to FALSE:
 * folding these into the base would silently deploy four extra workloads in
 * every test that only wanted a Postgres knob, and the default-off path is
 * itself something the tests must be able to exercise.
 *
 * The shape of these values matters — `loadConfig` validates the encryption
 * key's hex length and both API-key prefixes — so they are realistic in FORM
 * while remaining obvious non-credentials.
 */
export function langfuseStackConfig(): Record<string, string> {
  return {
    "grid-oib:langfuseEnabled": "true",
    // 64 hex characters: this is the one secret Langfuse wants as hex, and the
    // guard in loadConfig exists because base64 (44 chars) is the natural
    // mistake given every other secret in the program.
    "grid-oib:langfuseEncryptionKey":
      "0".repeat(64), // pragma: allowlist secret
    "grid-oib:langfuseSalt": "lf-salt", // pragma: allowlist secret
    "grid-oib:langfuseNextAuthSecret": "lf-nextauth", // pragma: allowlist secret
    "grid-oib:langfusePublicKey": "pk-lf-test", // pragma: allowlist secret
    "grid-oib:langfuseSecretKey": "sk-lf-test", // pragma: allowlist secret
    "grid-oib:langfuseDbPassword": "lf-db", // pragma: allowlist secret
    "grid-oib:langfuseClickhousePassword": "lf-ch", // pragma: allowlist secret
    // Distinct from dragonflyPassword and rateLimitStorePassword above —
    // loadConfig refuses a collision, which is itself asserted in config.spec.
    "grid-oib:langfuseQueuePassword": "lf-queue", // pragma: allowlist secret
    "grid-oib:langfuseS3SecretKey": "lf-s3", // pragma: allowlist secret
    "grid-oib:langfuseInitUserPassword": "lf-init-user", // pragma: allowlist secret
    // The tier's capability gate includes the observability one, so the
    // collector's dependencies have to be present too.
    "grid-oib:otelPrimaryApiKey": "otel-key", // pragma: allowlist secret
    "grid-oib:otelOidcIssuer": "https://grid.authkit.app",
    "grid-oib:otelOidcClientId": "client_otel",
    "grid-oib:otelOidcClientSecret": "otel-client-secret", // pragma: allowlist secret
  };
}
