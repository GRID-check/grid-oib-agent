export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
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
