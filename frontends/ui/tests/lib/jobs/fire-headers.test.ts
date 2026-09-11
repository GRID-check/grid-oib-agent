/**
 * @vitest-environment node
 *
 * The BFF half of the job fire path's header contract (ledger item 10).
 *
 * ADR-0046's Risks section is the reason this file exists, and it says the
 * lesson better than a comment can: the backend's route guard read
 * `x-internal-token` while every caller in the repo sent
 * `x-grid-internal-token`, so **every scheduled run 403'd in a real
 * deployment** — and nothing caught it, "because the two sides are tested
 * separately and each test pinned its own spelling". A fire path has no human
 * on it, so a silent 403 is indistinguishable from a quiet week.
 *
 * The fix that ADR asked for was "a test that crosses the service boundary
 * rather than two that agree with themselves". This is one of its two halves:
 * a shared fixture (`tests/fixtures/job_fire_headers.json`) names the headers,
 * this spec asserts the BFF really puts them on the wire, and
 * `tests/aiq_agent/test_fire_path_contract.py` asserts what the Python side
 * demands is a subset of the same file. Neither side can move a name alone.
 *
 * It asserts against what `submitJob` ACTUALLY sends — a stubbed `fetch`
 * capturing the real request — rather than against a second list of header
 * names, which would just be a third thing that agrees with itself.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// The twin under `frontends/ui/tests/fixtures/`, imported rather than read off
// disk: the frontend's typecheck/test Docker context is scoped to
// `frontends/ui` and cannot reach the repo-root copy. The Python side asserts
// the two are byte-identical, so this is the same contract.
import fixture from '../../fixtures/job_fire_headers.json'

import { submitJob, type JobSubmitPayload } from '@/lib/jobs/backend-client'
import {
  buildGridRequestContextWireHeaders,
  type GridRequestContextInput,
} from '@/lib/request-context'

const INTERNAL_TOKEN = 'test-internal-token'

/**
 * A fully-populated fire: every context lookup in `submitAgentRun` returned
 * something, so every optional header is present. The fixture's `sentByBff` is
 * the ceiling of what goes out, and this is the case that reaches it.
 */
const CONTEXT_INPUT: GridRequestContextInput = {
  organizationId: 'org_123',
  userId: 'user_456',
  projectId: 'proj_789',
  collectionScope: ['oib_knowledge', 'proj_proj_789'],
  projectContext: 'Projekt: Wohnbau Simmering',
  projectMemory: '- Bevorzugt knappe Zitate',
  modelOverrides: { deep_research: 'openrouter/anthropic/claude-3.7-sonnet' },
  budget: { remainingOrgUsd: 42.5, remainingUserUsd: 10, remainingProjectUsd: 5.25 },
  bundesland: 'Wien',
  memoryReflectionEnabled: true,
}

const PAYLOAD: JobSubmitPayload = {
  input: 'Prüfe den Einreichplan gegen OIB-Richtlinie 4.',
  skills: [],
  output: 'deep-research',
  data_sources: ['knowledge_layer'],
  // `GridRequestContextInput.collectionScope` is a readonly union that also
  // admits the ADR-0047 object shape; the submit payload takes bare names, the
  // same narrowing `computeCollectionScope` produces for this path.
  collection_scope: ['oib_knowledge', 'proj_proj_789'],
  project_context: CONTEXT_INPUT.projectContext ?? null,
  project_memory: CONTEXT_INPUT.projectMemory ?? null,
  memory_reflection_enabled: true,
  organization_id: 'org_123',
  user_id: 'user_456',
  project_id: 'proj_789',
  owner_email: 'ziviltechniker@example.at',
  budget_header: null,
  model_overrides: CONTEXT_INPUT.modelOverrides ?? null,
}

const lower = (names: string[]): string[] => names.map((name) => name.toLowerCase())

/** Fire once through the real client and return the headers that went out. */
async function capturedFireHeaders(
  input: GridRequestContextInput = CONTEXT_INPUT
): Promise<Record<string, string>> {
  let sent: Record<string, string> = {}
  const fetchSpy = vi.fn(async (_url: unknown, init: RequestInit) => {
    // `submitJob` passes a plain object; normalise through Headers so the
    // assertion is on the wire form, case-folded, exactly as the worker reads it.
    sent = Object.fromEntries(new Headers(init.headers as HeadersInit).entries())
    return new Response(JSON.stringify({ jobId: 'job_abc' }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchSpy)

  const headers = buildGridRequestContextWireHeaders(input, process.env.GRID_INTERNAL_API_TOKEN)
  await submitJob(PAYLOAD, headers)

  expect(fetchSpy).toHaveBeenCalledTimes(1)
  return sent
}

describe('the headers the BFF puts on a job fire', () => {
  beforeEach(() => {
    process.env.GRID_INTERNAL_API_TOKEN = INTERNAL_TOKEN
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.GRID_INTERNAL_API_TOKEN
  })

  it('sends every header the shared fixture names', async () => {
    const sent = await capturedFireHeaders()
    const missing = lower(fixture.sentByBff).filter((name) => !(name in sent))

    expect(missing, `the fire path stopped sending: ${missing.join(', ')}`).toEqual([])
  })

  it('sends the internal token under the spelling the backend guard accepts', async () => {
    const sent = await capturedFireHeaders()
    const accepted = lower(fixture.internalTokenAcceptedSpellings)
    const used = accepted.filter((name) => sent[name] === INTERNAL_TOKEN)

    // This is the exact failure ADR-0046 records: a token sent under a name the
    // guard does not read is a 403 on every unattended run, and it looks like
    // nothing at all.
    expect(used.length, `no accepted internal-token header carried the token`).toBeGreaterThan(0)
  })

  it('sends the signed context envelope, exemption notwithstanding', async () => {
    const sent = await capturedFireHeaders()

    // The envelope middleware exempts internal-token callers on this path, so
    // nothing REFUSES a fire without it. That exemption is a bad thing to
    // discover you were relying on, which is why the contract pins it here.
    for (const name of lower(fixture.contextEnvelope)) {
      expect(sent[name], `missing ${name}`).toBeTruthy()
    }
  })

  it('spells the worker identity headers the way the worker synthesises them', async () => {
    const sent = await capturedFireHeaders()

    // `jobs/runner.WORKER_IDENTITY_HEADERS`. A rename made on one side only is
    // how `remember` answered "no project in scope" on every unattended run.
    expect(lower(fixture.workerIdentityHeaders).filter((name) => !(name in sent))).toEqual([])
    expect(sent['x-grid-organization-id']).toBe('org_123')
    expect(sent['x-grid-project-id']).toBe('proj_789')
    expect(sent['x-grid-user-id']).toBe('user_456')
  })

  it('still carries the floor when every optional context lookup came back empty', async () => {
    // A brand-new org: no model overrides, no budget snapshot, no profile, no
    // memory. Those headers are legitimately absent — `requiredOnEveryFire` is
    // what may never be.
    const sent = await capturedFireHeaders({
      organizationId: 'org_new',
      userId: 'user_new',
      projectId: 'proj_new',
      collectionScope: ['oib_knowledge'],
      memoryReflectionEnabled: false,
    })

    expect(lower(fixture.requiredOnEveryFire).filter((name) => !(name in sent))).toEqual([])
    expect(sent['x-grid-model-overrides']).toBeUndefined()
    expect(sent['x-grid-budget']).toBeUndefined()
  })

  it('refuses to fire at all rather than sending an unauthenticated submit', async () => {
    delete process.env.GRID_INTERNAL_API_TOKEN
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    // Without the token the request must not be made: an unauthenticated fire
    // would 403 at the guard and be recorded as a backend failure, which points
    // the next investigation at the backend rather than at the missing secret.
    await expect(submitJob(PAYLOAD, {})).rejects.toThrow(/GRID_INTERNAL_API_TOKEN/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('the fire path in lib/jobs/service.ts', () => {
  // `submitAgentRun` needs a database, WorkOS and the budget service to run,
  // so what is pinned here is the WIRING: that it still builds the wire headers
  // with the shared builder and hands them to `submitJob`. A refactor that
  // passes a hand-rolled object instead would keep every test above green while
  // dropping the envelope from production.
  const source = readFileSync(new URL('../../../src/lib/jobs/service.ts', import.meta.url), 'utf8')

  it('builds its headers with the shared wire builder', () => {
    expect(source).toContain('buildGridRequestContextWireHeaders(')
    expect(source).toContain('process.env.GRID_INTERNAL_API_TOKEN')
  })

  it('hands those headers, and not a second object, to submitJob', () => {
    expect(source).toContain('await submitJob(payload, contextHeaders)')
  })
})
