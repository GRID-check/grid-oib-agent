export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Provision the fleet's default model if this deployment has none, BEFORE the
  // observability block: it must run whether or not a collector is configured,
  // and the early return below would otherwise skip it. Awaited so the defaults
  // are in place before the first request resolves an org's models, but it never
  // rejects — an empty table just means the workflow config stays in charge,
  // which is the pre-existing behaviour. See lib/model-config/bootstrap-defaults.
  try {
    const { bootstrapPlatformModelDefaults } = await import(
      "./lib/model-config/bootstrap-defaults"
    );
    await bootstrapPlatformModelDefaults();
  } catch (error) {
    console.error("[Model Config] Could not run the platform default bootstrap:", error);
  }

  // Capability derived from the dependency: no collector endpoint configured
  // (local dev, compose without observability) → no-op, zero overhead.
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;

  const { registerOTel } = await import("@vercel/otel");
  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "grid-ui",
  });

  // Bridge console.* to OTLP log records (Aspire "Strukturierte Protokolle").
  // Shared with the scheduler/purger workers; no-ops without the endpoint.
  const { initOtelLogs } = await import("../observability/otel-logs.js");
  initOtelLogs();
}
