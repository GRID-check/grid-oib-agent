/**
 * @vitest-environment node
 */
import { ROOT_CONTEXT, SamplingDecision, trace, TraceFlags } from '@opentelemetry/api'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function freshModule() {
  vi.resetModules()
  return import('./span-sampler.js')
}

afterEach(() => {
  vi.restoreAllMocks()
})

const SPAN_ID = '0123456789abcdef'
const TRACE_ID = '0123456789abcdef0123456789abcdef'

function parentContext(sampled) {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
  })
}

describe('RootSpanDropSampler', () => {
  // The whole point of the sampler is the root decision: one trace per HTTP
  // request was flooding Langfuse with health probes and RSC navigations
  // (ADR-0029 Amendment 5). If roots start being recorded again, that flood
  // returns - so this is the case the spec must pin.
  it('does not record a root span', async () => {
    const { RootSpanDropSampler } = await freshModule()
    const result = new RootSpanDropSampler().shouldSample(ROOT_CONTEXT, TRACE_ID, 'GET /api/health', 1, {}, [])
    expect(result.decision).toBe(SamplingDecision.NOT_RECORD)
  })

  it('follows a recorded parent, so children of kept spans stay kept', async () => {
    const { RootSpanDropSampler } = await freshModule()
    const sampler = new RootSpanDropSampler()
    const result = sampler.shouldSample(parentContext(true), TRACE_ID, 'fetch', 3, {}, [])
    expect(result.decision).toBe(SamplingDecision.RECORD_AND_SAMPLE)
  })

  it('follows an unrecorded parent, dropping the whole request subtree', async () => {
    const { RootSpanDropSampler } = await freshModule()
    const result = new RootSpanDropSampler().shouldSample(parentContext(false), TRACE_ID, 'fetch', 3, {}, [])
    expect(result.decision).toBe(SamplingDecision.NOT_RECORD)
  })

  it('treats an invalid parent span context as no parent', async () => {
    const { RootSpanDropSampler } = await freshModule()
    const invalid = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: 'invalid-trace-id',
      spanId: 'short',
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    })
    const result = new RootSpanDropSampler().shouldSample(invalid, TRACE_ID, 'GET /', 1, {}, [])
    expect(result.decision).toBe(SamplingDecision.NOT_RECORD)
  })

  it('never attaches attributes or mutates anything it is given', async () => {
    const { RootSpanDropSampler } = await freshModule()
    const attributes = {}
    const result = new RootSpanDropSampler().shouldSample(ROOT_CONTEXT, TRACE_ID, 'x', 1, attributes, [])
    expect(result.attributes).toBeUndefined()
    expect(attributes).toEqual({})
  })

  it('names itself for the SDK debug output', async () => {
    const { RootSpanDropSampler } = await freshModule()
    expect(new RootSpanDropSampler().toString()).toBe('RootSpanDropSampler')
  })
})
