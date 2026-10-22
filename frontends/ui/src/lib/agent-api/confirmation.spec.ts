/**
 * @vitest-environment node
 */
/**
 * The person confirms an outside agent's destructive call in their own chat
 * (MCP elicitation on the 2026-07-28 multi-round-trip flow), through the real
 * SDK and the door's own handler: the question, the yes that runs it, the no
 * that changes nothing, a forged or foreign state refused, and every client the
 * feature does not reach answered exactly as before.
 */
import { webcrypto } from 'node:crypto'
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY, CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./catalog', async () => {
  const { FAKE_OPERATIONS } = await import('./test-operations')
  const { z } = await import('zod')
  const enc = encodeURIComponent
  // A write that is not destructive by itself, so only the mark puts it to the person.
  const personDecides: import('./operation').AgentOperation = {
    name: 'held-item-file',
    domain: 'documents',
    summary: 'File a held item',
    description: 'Files an item that waits for a person into the project. Runs only on the person’s own yes.',
    method: 'POST',
    path: '/api/projects/[id]/held-items/file',
    params: z.object({ id: z.string().min(1) }),
    body: z.object({ itemId: z.string().min(1) }).strict(),
    requiresPersonConfirmation: {
      decideAt: (input) => `/app/projects/${enc(input.params?.id ?? '')}/files/held/${enc((input.body as { itemId: string }).itemId)}`,
    },
    load: async () => ({}),
  }
  const operations = [...FAKE_OPERATIONS, personDecides]
  return {
    AGENT_OPERATIONS: operations,
    findOperation: (name: string) => operations.find((op) => op.name === name),
  }
})
vi.mock('./exposure.config', async (importOriginal) => {
  const faked = (await import('./test-operations')).withFakeExposure(await importOriginal<typeof import('./exposure.config')>())
  return { ...faked, EXPOSURE: { ...faked.EXPOSURE, 'held-item-file': { external: true, piloti: true } } }
})
vi.mock('./dispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dispatch')>()),
  callOperation: vi.fn(),
}))
vi.mock('./operation-targets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./operation-targets')>()),
  describeTargets: vi.fn(),
}))
vi.mock('./operation-proposals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./operation-proposals')>()),
  proposeOperation: vi.fn(),
}))
vi.mock('@/lib/db/tenant-context', () => ({ withTenant: vi.fn((_tenant: unknown, run: () => unknown) => run()) }))
vi.mock('@/lib/audit/after-commit', () => ({ recordAuditEventAfterCommit: vi.fn() }))
vi.mock('./telemetry', () => ({ recordOperationCalled: vi.fn(), recordOperationMissing: vi.fn() }))

import { recordAuditEventAfterCommit } from '@/lib/audit/after-commit'
import { AGENT_OPERATIONS } from './catalog'
import { CONFIRMATION_TTL_SECONDS } from './confirmation'
import { callOperation } from './dispatch'
import { createAgentDoorHandler } from './mcp-server'
import { annotationsOf } from './operation'
import { describeTargets } from './operation-targets'
import { proposeOperation } from './operation-proposals'
import type { AgentPrincipal } from './principal'
import { recordOperationCalled } from './telemetry'

const session = {
  userId: 'user_1',
  email: 'a@piloti.test',
  name: null,
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'admin' as const,
  permissions: [],
  featureFlags: null,
}
const outside: AgentPrincipal = { actor: 'external_agent', clientId: 'client_a', scopes: [], session }
const piloti: AgentPrincipal = { actor: 'piloti', clientId: null, scopes: [], session }

const ELICITS = { elicitation: { form: {} } }
const DELETE_P1 = { name: 'project-delete', arguments: { name: 'project-delete', input: { params: { id: 'p-1' } } } }

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
})

beforeEach(() => {
  vi.stubEnv('GRID_INTERNAL_API_TOKEN', 'a-real-internal-token-for-the-confirmation-spec')
  vi.mocked(callOperation).mockReset().mockResolvedValue({ status: 200, ok: true, body: { deleted: true } })
  vi.mocked(describeTargets).mockReset().mockResolvedValue([{ type: 'project', id: 'p-1', name: 'Haus Josef' }])
  vi.mocked(proposeOperation).mockReset().mockResolvedValue({ proposalId: 'prop_1', summary: 'Delete a project (id: p-1)' })
  vi.mocked(recordAuditEventAfterCommit).mockReset()
  vi.mocked(recordOperationCalled).mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

interface Rpc {
  result?: Record<string, unknown> & { content?: { text: string }[]; isError?: boolean; resultType?: string }
  error?: { code: number; message: string }
}

const handler = createAgentDoorHandler(() => undefined)

/** A 2026-07-28 tools/call, its client capabilities in `_meta` as the specification puts them. */
async function modernCall(
  principal: AgentPrincipal,
  call: { name: string; arguments: unknown },
  options: { capabilities?: Record<string, unknown>; mode?: 'search' | 'tools'; extra?: Record<string, unknown> } = {},
): Promise<Rpc> {
  const { capabilities = ELICITS, mode = 'search', extra = {} } = options
  const tool = mode === 'search' ? 'call-operation' : call.name
  const args = mode === 'search' ? call.arguments : (call.arguments as { input: unknown }).input
  const response = await handler.fetch(
    new Request('https://app.piloti.test/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': tool,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: tool,
          arguments: args,
          ...extra,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_INFO_META_KEY]: { name: 'spec-client', version: '1.0.0' },
            [CLIENT_CAPABILITIES_META_KEY]: capabilities,
          },
        },
      }),
    }),
    { authInfo: { token: '', clientId: principal.clientId ?? '', scopes: [], extra: { principal, mode } } },
  )
  return JSON.parse(await response.text()) as Rpc
}

/** The same call as a 2025-11-25 client sends it, Piloti's own among them: no initialize, no envelope. */
async function legacyCall(principal: AgentPrincipal, call: { name: string; arguments: unknown }): Promise<string> {
  const response = await handler.fetch(
    new Request('https://app.piloti.test/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'call-operation', arguments: call.arguments } }),
    }),
    { authInfo: { token: '', clientId: principal.clientId ?? '', scopes: [], extra: { principal, mode: 'search' } } },
  )
  return response.text()
}

const accept = (confirm: unknown) => ({ confirm: { action: 'accept', content: { confirm } } })

async function askFor(principal = outside, call = DELETE_P1, mode: 'search' | 'tools' = 'search') {
  const first = await modernCall(principal, call, { mode })
  return { first, state: first.result?.requestState as string }
}

describe('a client that declares elicitation, on a destructive write', () => {
  it('asks the person in plain English what will change, and runs nothing yet', async () => {
    const { first, state } = await askFor()
    expect(first.result?.resultType).toBe('input_required')
    const request = (first.result?.inputRequests as Record<string, { method: string; params: { message: string; requestedSchema: unknown } }>).confirm
    expect(request.method).toBe('elicitation/create')
    expect(request.params.message).toBe(
      'An agent connected to Piloti wants to make this change as you: Delete a project (id: p-1). ' +
        'This affects project "Haus Josef". Nothing changes unless you confirm.',
    )
    expect(request.params.message).not.toContain('{')
    expect(request.params.requestedSchema).toMatchObject({ type: 'object', required: ['confirm'], properties: { confirm: { type: 'boolean' } } })
    expect(state).toMatch(/^v1\./)
    expect(callOperation).not.toHaveBeenCalled()
    expect(vi.mocked(recordOperationCalled).mock.calls[0][1]).toMatchObject({ operation: 'project-delete', decision: 'confirm' })
  })

  it('runs the call as the person on their yes, and records the decision as theirs, from elicitation', async () => {
    const { state } = await askFor()
    const second = await modernCall(outside, DELETE_P1, { extra: { inputResponses: accept(true), requestState: state } })
    expect(second.result?.isError).toBeUndefined()
    expect(second.result?.content?.[0].text).toBe('{"deleted":true}')
    expect(callOperation).toHaveBeenCalledTimes(1)
    expect(vi.mocked(callOperation).mock.calls[0][0].name).toBe('project-delete')
    expect(vi.mocked(callOperation).mock.calls[0][1]).toEqual({ params: { id: 'p-1' } })
    expect(vi.mocked(callOperation).mock.calls[0][2]).toBe(session)
    expect(recordAuditEventAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent.operation.decided',
        actor: { userId: 'user_1', email: 'a@piloti.test' },
        alsoTargets: [{ type: 'project', id: 'p-1' }],
        metadata: { operation: 'project-delete', decision: 'applied', decisionSource: 'elicitation', clientId: 'client_a' },
      }),
    )
    const ran = vi.mocked(recordOperationCalled).mock.calls.find(([, call]) => call.decision === 'run')
    expect(ran?.[0].decisionSource).toBe('elicitation')
  })

  it('records a yes the route then refused as failed, with the route’s own words for the agent', async () => {
    vi.mocked(callOperation).mockResolvedValue({ status: 403, ok: false, body: { error: 'Only an owner deletes a project', code: 'forbidden' } })
    const { state } = await askFor()
    const second = await modernCall(outside, DELETE_P1, { extra: { inputResponses: accept(true), requestState: state } })
    expect(second.result?.isError).toBe(true)
    expect(second.result?.content?.[0].text).toContain('Only an owner deletes a project')
    expect(vi.mocked(recordAuditEventAfterCommit).mock.calls[0][0].metadata).toMatchObject({ decision: 'failed' })
  })

  it.each([
    ['declined', { confirm: { action: 'decline' } }],
    ['cancelled', { confirm: { action: 'cancel' } }],
    ['accepted unchecked', accept(false)],
    ['accepted with a string', accept('true')],
  ])('changes nothing when the person %s, and says so', async (_label, inputResponses) => {
    const { state } = await askFor()
    const second = await modernCall(outside, DELETE_P1, { extra: { inputResponses, requestState: state } })
    expect(second.result?.content?.[0].text).toBe(
      'The person did not confirm project-delete, so nothing was changed. Do not call it again unless they ask you to.',
    )
    expect(second.result?.structuredContent).toEqual({ decision: 'declined', operation: 'project-delete', changed: false })
    expect(callOperation).not.toHaveBeenCalled()
    expect(vi.mocked(recordAuditEventAfterCommit).mock.calls[0][0].metadata).toMatchObject({ decision: 'declined', decisionSource: 'elicitation' })
  })

  it('asks the same question in tools mode', async () => {
    const { first, state } = await askFor(outside, DELETE_P1, 'tools')
    expect(first.result?.resultType).toBe('input_required')
    const second = await modernCall(outside, DELETE_P1, { mode: 'tools', extra: { inputResponses: accept(true), requestState: state } })
    expect(second.result?.content?.[0].text).toBe('{"deleted":true}')
    expect(callOperation).toHaveBeenCalledTimes(1)
  })
})

describe('what the answer can never do', () => {
  it('trusts no answer without the signed state: a bare yes is asked again', async () => {
    const forged = await modernCall(outside, DELETE_P1, { extra: { inputResponses: accept(true) } })
    expect(forged.result?.resultType).toBe('input_required')
    expect(callOperation).not.toHaveBeenCalled()
  })

  it('refuses a tampered state before any handler runs', async () => {
    const { state } = await askFor()
    const [version, body, mac] = state.split('.')
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as { p: { input: { params: { id: string } } } }
    payload.p.input.params.id = 'p-2'
    const tampered = [version, Buffer.from(JSON.stringify(payload)).toString('base64url'), mac].join('.')
    const call = { name: 'project-delete', arguments: { name: 'project-delete', input: { params: { id: 'p-2' } } } }
    const second = await modernCall(outside, call, { extra: { inputResponses: accept(true), requestState: tampered } })
    expect(second.error?.message).toBe('Invalid or expired requestState')
    expect(callOperation).not.toHaveBeenCalled()
  })

  it('refuses a state minted for another person, or for another client of the same person', async () => {
    const { state } = await askFor()
    const colleague: AgentPrincipal = { ...outside, session: { ...session, userId: 'user_2' } }
    const otherClient: AgentPrincipal = { ...outside, clientId: 'client_b' }
    for (const principal of [colleague, otherClient]) {
      const second = await modernCall(principal, DELETE_P1, { extra: { inputResponses: accept(true), requestState: state } })
      expect(second.error?.message).toBe('Invalid or expired requestState')
    }
    expect(callOperation).not.toHaveBeenCalled()
  })

  it('refuses a state past its time', async () => {
    const { state } = await askFor()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + (CONFIRMATION_TTL_SECONDS + 5) * 1000)
    const second = await modernCall(outside, DELETE_P1, { extra: { inputResponses: accept(true), requestState: state } })
    expect(second.error?.message).toBe('Invalid or expired requestState')
    expect(callOperation).not.toHaveBeenCalled()
  })

  it('runs nothing when the second round names a different call than the person confirmed', async () => {
    const { state } = await askFor()
    const other = { name: 'project-delete', arguments: { name: 'project-delete', input: { params: { id: 'p-2' } } } }
    const second = await modernCall(outside, other, { extra: { inputResponses: accept(true), requestState: state } })
    expect(second.result?.isError).toBe(true)
    expect(second.result?.content?.[0].text).toContain('for a different call, so nothing was changed')
    expect(callOperation).not.toHaveBeenCalled()
  })

  it('never offers a question for an operation the agent may not see: it stays unknown', async () => {
    const hidden = { name: 'project-folder-access-set', arguments: { name: 'project-folder-access-set', input: { params: { id: 'f-1' }, body: {} } } }
    const first = await modernCall(outside, hidden)
    expect(first.result?.resultType).toBe('complete')
    expect(first.result?.isError).toBe(true)
    expect(first.result?.content?.[0].text).toContain('Unknown operation')
  })

  it('hands a malformed call to today’s path, whose validator refuses it, instead of asking about it', async () => {
    const bad = { name: 'project-delete', arguments: { name: 'project-delete', input: {} } }
    const first = await modernCall(outside, bad)
    expect(first.result?.resultType).toBe('complete')
    expect(first.result?.inputRequests).toBeUndefined()
    // The dispatcher is a stub here; the real one validates the input first (`dispatch.spec.ts`).
    expect(vi.mocked(callOperation).mock.calls[0][1]).toEqual({})
  })
})

describe('everyone the feature does not reach is answered as before', () => {
  it('runs a destructive write at once for a client that does not declare elicitation', async () => {
    const first = await modernCall(outside, DELETE_P1, { capabilities: {} })
    expect(first.result?.content?.[0].text).toBe('{"deleted":true}')
    expect(callOperation).toHaveBeenCalledTimes(1)
    expect(recordAuditEventAfterCommit).not.toHaveBeenCalled()
  })

  it('runs a write that is not destructive at once, elicitation or not', async () => {
    const add = { name: 'project-member-add', arguments: { name: 'project-member-add', input: { params: { id: 'p-1' }, body: { userId: 'u', role: 'viewer' } } } }
    const first = await modernCall(outside, add)
    expect(first.result?.resultType).toBe('complete')
    expect(callOperation).toHaveBeenCalledTimes(1)
  })

  it('asks nothing when no signing key is configured', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')
    const first = await modernCall(outside, DELETE_P1)
    expect(first.result?.content?.[0].text).toBe('{"deleted":true}')
  })

  it('answers a 2025-era call byte for byte as it did without the feature', async () => {
    const withKey = await legacyCall(outside, DELETE_P1)
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')
    const withoutKey = await legacyCall(outside, DELETE_P1)
    expect(withKey).toBe(withoutKey)
    expect(JSON.parse(withKey).result.content[0].text).toBe('{"deleted":true}')
    expect(callOperation).toHaveBeenCalledTimes(2)
  })

  it('keeps Piloti’s write a proposal, on either era, and never asks', async () => {
    const modern = await modernCall(piloti, DELETE_P1)
    expect(modern.result?.resultType).toBe('complete')
    expect(modern.result?.structuredContent).toMatchObject({ decision: 'propose', proposalId: 'prop_1' })
    const legacy = JSON.parse(await legacyCall(piloti, DELETE_P1)) as Rpc
    expect(legacy.result?.structuredContent).toMatchObject({ decision: 'propose', proposalId: 'prop_1' })
    expect(callOperation).not.toHaveBeenCalled()
  })
})

describe('an operation that runs only on the person’s own yes', () => {
  const FILE_ITEM = {
    name: 'held-item-file',
    arguments: { name: 'held-item-file', input: { params: { id: 'p-1' }, body: { itemId: 'm 7' } } },
  }
  const LINK = 'https://app.piloti.test/app/projects/p-1/files/held/m%207'
  const REFUSAL =
    'held-item-file runs only on the person\'s own yes, and this client cannot ask them for it (MCP form elicitation), ' +
    `so nothing was changed. Give the person this link, where they decide it in Piloti themselves: ${LINK} ` +
    'Do not call it again unless they ask you to.'

  beforeEach(() => {
    vi.stubEnv('WORKOS_REDIRECT_URI', 'https://app.piloti.test/callback')
  })

  function expectRefused(result: Rpc['result']) {
    expect(result?.isError).toBe(true)
    expect(result?.content?.[0].text).toBe(REFUSAL)
    expect(result?.structuredContent).toEqual({ decision: 'person_required', operation: 'held-item-file', changed: false, url: LINK })
    expect(callOperation).not.toHaveBeenCalled()
    expect(vi.mocked(recordOperationCalled).mock.calls.map(([, call]) => call)).toEqual([
      expect.objectContaining({ operation: 'held-item-file', decision: 'person_required', status: 403 }),
    ])
  }

  it('is refused, never run, for a 2025-era client, which cannot carry the question', async () => {
    expectRefused((JSON.parse(await legacyCall(outside, FILE_ITEM)) as Rpc).result)
  })

  it('is refused for a 2026-07-28 client that does not declare form elicitation, in either mode', async () => {
    expectRefused((await modernCall(outside, FILE_ITEM, { capabilities: {} })).result)
    vi.mocked(recordOperationCalled).mockReset()
    expectRefused((await modernCall(outside, FILE_ITEM, { capabilities: { elicitation: { url: {} } }, mode: 'tools' })).result)
  })

  it('is refused when no signing key exists to carry the question to a second round', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')
    expectRefused((await modernCall(outside, FILE_ITEM)).result)
  })

  it('refuses a second round that dropped the elicitation capability, whatever state it carries', async () => {
    const { state } = await askFor(outside, FILE_ITEM)
    vi.mocked(recordOperationCalled).mockReset()
    const second = await modernCall(outside, FILE_ITEM, { capabilities: {}, extra: { inputResponses: accept(true), requestState: state } })
    expectRefused(second.result)
  })

  it('names no link when the deployment pins no origin, and still changes nothing', async () => {
    vi.stubEnv('WORKOS_REDIRECT_URI', '')
    vi.stubEnv('NEXT_PUBLIC_WORKOS_REDIRECT_URI', '')
    const result = (await modernCall(outside, FILE_ITEM, { capabilities: {} })).result
    expect(result?.content?.[0].text).toContain('so nothing was changed. The person decides it in Piloti themselves.')
    expect(result?.structuredContent).toMatchObject({ decision: 'person_required', url: null })
    expect(callOperation).not.toHaveBeenCalled()
  })

  it('is put to the person when the client can ask, though it is not destructive, and runs on their yes', async () => {
    const { first, state } = await askFor(outside, FILE_ITEM)
    expect(first.result?.resultType).toBe('input_required')
    expect(callOperation).not.toHaveBeenCalled()
    const second = await modernCall(outside, FILE_ITEM, { extra: { inputResponses: accept(true), requestState: state } })
    expect(second.result?.isError).toBeUndefined()
    expect(callOperation).toHaveBeenCalledTimes(1)
    expect(vi.mocked(recordAuditEventAfterCommit).mock.calls[0][0].metadata).toMatchObject({ decision: 'applied', decisionSource: 'elicitation' })
  })

  it('changes nothing when the person says no', async () => {
    const { state } = await askFor(outside, FILE_ITEM)
    const second = await modernCall(outside, FILE_ITEM, { extra: { inputResponses: accept(false), requestState: state } })
    expect(second.result?.structuredContent).toEqual({ decision: 'declined', operation: 'held-item-file', changed: false })
    expect(callOperation).not.toHaveBeenCalled()
  })

  it('stays Piloti’s proposal, which the person accepts, on either era', async () => {
    const modern = await modernCall(piloti, FILE_ITEM, { capabilities: {} })
    expect(modern.result?.structuredContent).toMatchObject({ decision: 'propose', proposalId: 'prop_1' })
    const legacy = JSON.parse(await legacyCall(piloti, FILE_ITEM)) as Rpc
    expect(legacy.result?.structuredContent).toMatchObject({ decision: 'propose', proposalId: 'prop_1' })
    expect(callOperation).not.toHaveBeenCalled()
  })

  it('leaves a malformed call to today’s validator, so the agent learns what to fix before the person is sent anywhere', async () => {
    const bad = { name: 'held-item-file', arguments: { name: 'held-item-file', input: { params: { id: 'p-1' }, body: {} } } }
    const result = (JSON.parse(await legacyCall(outside, bad)) as Rpc).result
    expect(result?.structuredContent).not.toHaveProperty('decision', 'person_required')
    // The dispatcher is a stub here; the real one validates the input first (`dispatch.spec.ts`).
    expect(vi.mocked(callOperation).mock.calls[0][1]).toEqual({ params: { id: 'p-1' }, body: {} })
  })

  it('tells every client to confirm it with the person', () => {
    const op = AGENT_OPERATIONS.find((candidate) => candidate.name === 'held-item-file')
    expect(op && annotationsOf(op)).toMatchObject({ readOnlyHint: false, destructiveHint: true })
  })

  it('marks writes only in the real catalog: a read Piloti runs would never reach the person', async () => {
    const real = await vi.importActual<typeof import('./catalog')>('./catalog')
    const marked = real.AGENT_OPERATIONS.filter((op) => op.requiresPersonConfirmation)
    expect(marked.filter((op) => annotationsOf(op).readOnlyHint).map((op) => op.name)).toEqual([])
  })
})
