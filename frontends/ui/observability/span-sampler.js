/**
 * Trace sampler for grid-ui: drops ROOT spans, keeps the logs signal (ADR-0029
 * Amendment 5).
 *
 * Why this exists: registering an OTel provider in a Next.js app makes Next's
 * server instrumentation and @vercel/otel's fetch instrumentation emit one
 * trace per HTTP request - health probes, RSC navigations, static assets,
 * every BFF POST. In Langfuse that flood drowned the agent tiers' traces under
 * low-value rows (and in the OSS build nothing ever expires, so the rows cost
 * storage forever). The information those spans carry is duplicated better
 * elsewhere:
 *
 * - BFF request work is thin transport (ADR-0017); the operation it forwards
 *   to appears as a richer span in the aiq-agent / worker tier's own trace.
 * - Errors still reach both telemetry stores through the OTel LOG bridge
 *   (`otel-logs.js`, unchanged) - and ERROR records open GitHub issues via
 *   err2issue (ADR-0031).
 * - The WS proxy (`server.js`) was never instrumented, so there are no WS
 *   spans to lose.
 *
 * Semantics: a span with no valid parent context (a root) is NOT recorded;
 * every child follows its parent's decision, exactly like `ParentBased`. So
 * one decision here removes the whole request subtree at creation time -
 * before batching, serialization or export pay for it.
 *
 * Capability doctrine: this sampler is only wired when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set (see src/instrumentation.ts). There is no
 * separate opt-out flag; if grid-ui traces are wanted again, delete the
 * `traceSampler` line, not this file's logic.
 */

const { SamplingDecision, TraceFlags, isSpanContextValid, trace } = require('@opentelemetry/api')

class RootSpanDropSampler {
  shouldSample(context) {
    const parent = trace.getSpanContext(context)
    if (parent && isSpanContextValid(parent)) {
      const sampled = (parent.traceFlags & TraceFlags.SAMPLED) !== 0
      return {
        decision: sampled ? SamplingDecision.RECORD_AND_SAMPLE : SamplingDecision.NOT_RECORD,
      }
    }
    return { decision: SamplingDecision.NOT_RECORD }
  }

  toString() {
    return 'RootSpanDropSampler'
  }
}

module.exports = { RootSpanDropSampler }
