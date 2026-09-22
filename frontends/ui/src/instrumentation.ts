export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // What this process is, before anything else it does (ledger item 1). The
  // gateway (`server.js`) prints the same line, but only in the deployment
  // where it fronts Next; `next start` and `next dev` never load it, and this
  // hook runs in every one of them. Two lines in the compose deployment is the
  // right trade for never having a deployment that prints none. Rationale and
  // the shared format: `lib/boot.ts`.
  try {
    const { bootLine } = await import("./lib/boot");
    // This line IS the deliverable: it has to reach stdout at info level,
    // where a container log collector picks it up. `console.warn` would file a
    // normal boot as a problem, and routing it through a logger would make the
    // first line of the process depend on the logger having booted.
    // eslint-disable-next-line no-console
    console.log(bootLine());
  } catch (error) {
    console.error("[boot] could not read the boot identity:", error);
  }

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
  const { RootSpanDropSampler } = await import("../observability/span-sampler.js");
  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "grid-ui",
    // One trace per HTTP request flooded Langfuse with health probes, RSC
    // navigations and BFF POSTs whose real work already appears in the
    // backend tiers' traces. Root spans are dropped at creation; errors stay
    // visible through the OTel log bridge below (and err2issue). See the
    // module's header and ADR-0029 Amendment 5.
    traceSampler: new RootSpanDropSampler(),
  });

  // Bridge console.* to OTLP log records (Aspire "Strukturierte Protokolle").
  // Shared with the scheduler/purger workers; no-ops without the endpoint.
  const { initOtelLogs } = await import("../observability/otel-logs.js");
  initOtelLogs();
}
