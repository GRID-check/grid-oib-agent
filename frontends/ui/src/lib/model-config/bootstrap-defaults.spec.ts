/**
 * First-boot provisioning of the platform default model.
 *
 * The cases here are the ones that decide whether this is safe to run on a
 * deployment nobody has configured. The dangerous shape — the one a SQL seed
 * has and this replaces — is writing an OpenRouter model id into a deployment
 * whose workflow LLMs point at another provider: a platform default replaces
 * only the model id, never the base URL, so those requests would carry a model
 * that provider has never heard of. `groupsEligibleForBootstrap` is the guard,
 * and most of this file is about proving it refuses in every ambiguous case
 * rather than guessing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_GROUPS } from './agent-groups'
import {
  BOOTSTRAP_ACTOR,
  BOOTSTRAP_DEFAULT_MODEL,
  bootstrapPlatformModelDefaults,
  groupsEligibleForBootstrap,
} from './bootstrap-defaults'
import type { LlmBaseUrls } from './backend-defaults'

vi.mock('server-only', () => ({}))

const OPENROUTER = 'https://openrouter.ai/api/v1'

/** Every workflow LLM the registry references, all on one endpoint. */
function allOn(baseUrl: string | null): LlmBaseUrls {
  return Object.fromEntries(
    AGENT_GROUPS.flatMap((group) => group.configLlmRefs).map((ref) => [ref, baseUrl]),
  )
}

const getPlatformModelDefaults = vi.fn()
const savePlatformModelDefaults = vi.fn()
vi.mock('./platform-defaults', () => ({
  getPlatformModelDefaults: (): unknown => getPlatformModelDefaults(),
  savePlatformModelDefaults: (input: unknown, executor?: unknown): unknown =>
    savePlatformModelDefaults(input, executor),
}))

const getWorkflowLlmBaseUrls = vi.fn()
vi.mock('./backend-defaults', () => ({
  getWorkflowLlmBaseUrls: (): unknown => getWorkflowLlmBaseUrls(),
}))

const fetchModelCatalog = vi.fn()
const fetchZdrModelIds = vi.fn()
const validateOverrides = vi.fn()
vi.mock('./openrouter', () => ({
  fetchModelCatalog: (): unknown => fetchModelCatalog(),
  fetchZdrModelIds: (): unknown => fetchZdrModelIds(),
  validateOverrides: (...args: unknown[]): unknown => validateOverrides(...args),
  baseModelId: (id: string): string => id.split(':')[0],
}))

const recordAuditEvent = vi.fn()
vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: (input: unknown): unknown => recordAuditEvent(input),
}))
vi.mock('@/lib/authz/platform', () => ({
  getPlatformOrganizationId: async (): Promise<string> => 'org_platform',
}))

/**
 * Rows the next `db.execute` returns, in order: the advisory-lock result then
 * the count. Stated as data so a test says what the database holds.
 */
let executeResults: unknown[][] = []
const tx = { execute: async () => executeResults.shift() ?? [] }
vi.mock('@/lib/db', () => ({
  getDb: () => ({
    // The lock, the re-check and the write all run on ONE connection now, so the
    // mock hands the same `tx` to the callback rather than exposing `execute`
    // on the pooled handle.
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  }),
}))

/** Table empty, lock acquired, count 0 — the state a fresh deployment is in. */
function freshDeployment(): void {
  getPlatformModelDefaults.mockResolvedValue({})
  executeResults = [[{ locked: true }], [{ count: 0 }], []]
}

describe('groupsEligibleForBootstrap', () => {
  it('accepts every group when the whole workflow runs on the platform provider', () => {
    expect(groupsEligibleForBootstrap(allOn(OPENROUTER)).sort()).toEqual(
      AGENT_GROUPS.map((group) => group.id).sort(),
    )
  })

  it('refuses every group on a deployment pointed at another provider', () => {
    // config_web_kimi.yml (Kimi) and config_web_default_llamaindex.yml (NVIDIA)
    // are shipped, supported BACKEND_CONFIG values. Seeding an OpenRouter id
    // into either sends an unknown model to that provider on every request.
    expect(groupsEligibleForBootstrap(allOn('https://api.kimi.com/coding/v1'))).toEqual([])
    expect(groupsEligibleForBootstrap(allOn('https://integrate.api.nvidia.com/v1'))).toEqual([])
  })

  it('refuses a group whose endpoint is unknown rather than assuming OpenRouter', () => {
    // A null base URL is what an LLM config without one reports. "Unknown"
    // must never be read as "the provider I happen to validate against".
    expect(groupsEligibleForBootstrap(allOn(null))).toEqual([])
    expect(groupsEligibleForBootstrap({})).toEqual([])
  })

  it('refuses a group when only SOME of its LLMs are on the platform provider', () => {
    // deep_research spans three LLMs. Re-pointing the group moves all three, so
    // one straggler on another endpoint disqualifies the whole group.
    const deepResearch = AGENT_GROUPS.find((group) => group.id === 'deep_research')
    expect(deepResearch?.configLlmRefs.length).toBeGreaterThan(1)
    const mixed: LlmBaseUrls = {
      ...allOn(OPENROUTER),
      [deepResearch!.configLlmRefs[0]]: 'https://integrate.api.nvidia.com/v1',
    }
    expect(groupsEligibleForBootstrap(mixed)).not.toContain('deep_research')
    expect(groupsEligibleForBootstrap(mixed)).toContain('shallow_research')
  })

  it('leaves ingest_vlm out when the ingestion VLM is on its own provider', () => {
    // The shipped AIQ_VLM_BASE_URL default routes to NVIDIA while the chat
    // models route to OpenRouter. Seeding ingest_vlm there would make an
    // operator's AIQ_VLM_MODEL dead config and fail every caption call.
    const vlmElsewhere: LlmBaseUrls = {
      ...allOn(OPENROUTER),
      vlm: 'https://integrate.api.nvidia.com/v1',
    }
    const eligible = groupsEligibleForBootstrap(vlmElsewhere)
    expect(eligible).not.toContain('ingest_vlm')
    expect(eligible).toContain('shallow_research')
  })

  it('is not fooled by a look-alike host', () => {
    // A prefixed domain is the one a bare `endsWith` lets through: it really
    // does end with "openrouter.ai" while belonging to someone else.
    expect(groupsEligibleForBootstrap(allOn('https://notopenrouter.ai/v1'))).toEqual([])
    expect(groupsEligibleForBootstrap(allOn('https://openrouter.ai.evil.test/v1'))).toEqual([])
    expect(groupsEligibleForBootstrap(allOn('not a url'))).toEqual([])
  })

  it('accepts a real subdomain', () => {
    expect(groupsEligibleForBootstrap(allOn('https://eu.openrouter.ai/api/v1')).length).toBe(
      AGENT_GROUPS.length,
    )
  })
})

describe('bootstrapPlatformModelDefaults', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('GRID_APP_DATABASE_URL', 'postgres://stub')
    executeResults = []
    getWorkflowLlmBaseUrls.mockResolvedValue(allOn(OPENROUTER))
    fetchModelCatalog.mockResolvedValue([{ id: BOOTSTRAP_DEFAULT_MODEL }])
    fetchZdrModelIds.mockResolvedValue(new Set([BOOTSTRAP_DEFAULT_MODEL]))
    validateOverrides.mockImplementation((_catalog: unknown, defaults: Record<string, string>) => ({
      ok: true,
      errors: {},
      snapshot: Object.fromEntries(
        Object.keys(defaults).map((group) => [group, { id: BOOTSTRAP_DEFAULT_MODEL }]),
      ),
    }))
    savePlatformModelDefaults.mockResolvedValue([])
    recordAuditEvent.mockResolvedValue(undefined)
  })

  it('provisions every eligible group and records what it wrote', async () => {
    freshDeployment()

    const written = await bootstrapPlatformModelDefaults()

    expect(written.sort()).toEqual(AGENT_GROUPS.map((group) => group.id).sort())
    const input = savePlatformModelDefaults.mock.calls[0][0]
    expect(new Set(Object.values(input.defaults))).toEqual(new Set([BOOTSTRAP_DEFAULT_MODEL]))
    expect(input.actorUserId).toBe(BOOTSTRAP_ACTOR)
    // The ZDR signal is the control migration 0026 built so tenants enforcing
    // Zero-Data-Retention can be warned; a seed that leaves it NULL disables it.
    expect(input.modelSnapshot.shallow_research._zdr.safe).toBe(true)
  })

  it('records an audit event for a decision no human made', async () => {
    freshDeployment()

    await bootstrapPlatformModelDefaults()

    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.model_defaults.bootstrapped',
        organizationId: 'org_platform',
        actor: { userId: BOOTSTRAP_ACTOR, email: null },
      }),
    )
  })

  it('does nothing when the deployment already has defaults', async () => {
    getPlatformModelDefaults.mockResolvedValue({ shallow_research: 'vendor/owner-pick' })

    expect(await bootstrapPlatformModelDefaults()).toEqual([])
    expect(savePlatformModelDefaults).not.toHaveBeenCalled()
  })

  it('does nothing when rows appeared between the pre-check and the lock', async () => {
    getPlatformModelDefaults.mockResolvedValue({})
    executeResults = [[{ locked: true }], [{ count: 7 }], []]

    expect(await bootstrapPlatformModelDefaults()).toEqual([])
    expect(savePlatformModelDefaults).not.toHaveBeenCalled()
  })

  it('leaves the deployment alone when the backend cannot be asked', async () => {
    // Unreachable backend is NOT "assume OpenRouter" — it is "do not decide".
    freshDeployment()
    getWorkflowLlmBaseUrls.mockRejectedValue(new Error('backend down'))

    expect(await bootstrapPlatformModelDefaults()).toEqual([])
    expect(savePlatformModelDefaults).not.toHaveBeenCalled()
  })

  it('writes nothing on a deployment running another provider', async () => {
    freshDeployment()
    getWorkflowLlmBaseUrls.mockResolvedValue(allOn('https://api.kimi.com/coding/v1'))

    expect(await bootstrapPlatformModelDefaults()).toEqual([])
    expect(savePlatformModelDefaults).not.toHaveBeenCalled()
  })

  it('provisions only the eligible groups on a mixed-provider deployment', async () => {
    freshDeployment()
    getWorkflowLlmBaseUrls.mockResolvedValue({
      ...allOn(OPENROUTER),
      vlm: 'https://integrate.api.nvidia.com/v1',
    })

    const written = await bootstrapPlatformModelDefaults()

    expect(written).not.toContain('ingest_vlm')
    expect(written).toContain('shallow_research')
    expect(Object.keys(savePlatformModelDefaults.mock.calls[0][0].defaults)).not.toContain(
      'ingest_vlm',
    )
  })

  it('refuses to write an unvalidated id when the catalog is unavailable', async () => {
    // Mirrors the admin PUT, which rejects a save rather than pinning the fleet
    // to something it could not check.
    freshDeployment()
    fetchModelCatalog.mockRejectedValue(new Error('catalog down'))

    expect(await bootstrapPlatformModelDefaults()).toEqual([])
    expect(savePlatformModelDefaults).not.toHaveBeenCalled()
  })

  it('refuses to write a model that fails a group capability gate', async () => {
    freshDeployment()
    validateOverrides.mockReturnValue({
      ok: false,
      errors: { deep_research: 'context length 32768 is below the required 131072' },
      snapshot: {},
    })

    expect(await bootstrapPlatformModelDefaults()).toEqual([])
    expect(savePlatformModelDefaults).not.toHaveBeenCalled()
  })

  it('records ZDR as unknown, never as safe, when the listing is unreachable', async () => {
    freshDeployment()
    fetchZdrModelIds.mockRejectedValue(new Error('zdr listing down'))

    await bootstrapPlatformModelDefaults()

    expect(savePlatformModelDefaults.mock.calls[0][0].modelSnapshot.shallow_research._zdr.safe).toBeNull()
  })

  it('keeps the defaults when the audit sink fails', async () => {
    // Losing the trail must not un-write a decision that is already live.
    freshDeployment()
    recordAuditEvent.mockRejectedValue(new Error('workos down'))

    expect(await bootstrapPlatformModelDefaults()).not.toEqual([])
    expect(savePlatformModelDefaults).toHaveBeenCalled()
  })

  it('takes the lock, re-checks and writes on ONE connection', async () => {
    // `getDb()` is a pool. A session-scoped lock taken on one pooled connection
    // and released on another leaks forever, and every later boot would then
    // skip provisioning silently — so the whole sequence must share a session,
    // and the save must be handed that same transaction.
    freshDeployment()

    await bootstrapPlatformModelDefaults()

    expect(savePlatformModelDefaults.mock.calls[0][1]).toBe(tx)
  })

  it('writes nothing when another replica holds the lock', async () => {
    getPlatformModelDefaults.mockResolvedValue({})
    executeResults = [[{ locked: false }]]

    expect(await bootstrapPlatformModelDefaults()).toEqual([])
    expect(savePlatformModelDefaults).not.toHaveBeenCalled()
  })

  it('never throws into boot when the database is unreachable', async () => {
    vi.stubEnv('GRID_APP_DATABASE_URL', 'postgres://stub')
    getPlatformModelDefaults.mockRejectedValue(new Error('db down'))

    await expect(bootstrapPlatformModelDefaults()).resolves.toEqual([])
    vi.unstubAllEnvs()
  })

  it('skips quietly when no application database is configured', async () => {
    // Local dev, the screenshot harness and build steps all run without one.
    // Reporting that as a failure on every boot trains people to ignore the log
    // line that matters.
    vi.stubEnv('GRID_APP_DATABASE_URL', '')

    expect(await bootstrapPlatformModelDefaults()).toEqual([])
    expect(getPlatformModelDefaults).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })
})
