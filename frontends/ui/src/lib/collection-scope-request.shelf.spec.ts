/**
 * @vitest-environment node
 */
/**
 * ADR-0047 — a document's shelf travels as DATA on the scope header.
 *
 * `X-Grid-Collection-Scope` used to be `base64url(JSON.stringify(string[]))`:
 * a bare list of collection ids. The shelf each collection sits on was erased
 * at this boundary and guessed back downstream from an `archiv_`/`proj_`/`s_`
 * name prefix — which is why a file privately attached to a chat came back
 * cited as "Projektwissen".
 *
 * These specs pin the emission half of the contract: the BFF, which BUILDS
 * every one of these collection names, states the shelf alongside each name,
 * and states nothing at all for a collection it cannot attribute.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({ findConversationTenancy: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ findProjectCollectionName: vi.fn() }))
vi.mock('@/lib/user-preferences/repository', () => ({ findUserPreferencesForSession: vi.fn() }))
// Passthrough: the real scope assembly runs, so these specs exercise the names
// actually put on the wire. One test overrides it to inject a collection the
// BFF never built — the only way to reach the "cannot attribute" branch.
vi.mock('@/lib/collection-scope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/collection-scope')>()
  return { ...actual, computeCollectionScope: vi.fn(actual.computeCollectionScope) }
})

import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import { computeCollectionScope } from '@/lib/collection-scope'
import { findConversationTenancy } from '@/lib/conversations/repository'
import { findProjectCollectionName } from '@/lib/projects/repository'
import { findUserPreferencesForSession } from '@/lib/user-preferences/repository'
import {
  buildCollectionScopeFromRequest,
  type ScopedCollection,
} from './collection-scope-request'

const PROJECT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const CONVERSATION_ID = 'conv_abc'
const ORG_ID = 'org_1'

const session = {
  userId: 'user_me',
  organizationId: ORG_ID,
  email: 'me@grid.test',
  featureFlags: null,
} as unknown as AuthorizedSession

/** Decode the header exactly as the Python reader does. */
function decodeHeader(headerValue: string): ScopedCollection[] {
  return JSON.parse(Buffer.from(headerValue, 'base64url').toString()) as ScopedCollection[]
}

function shelfOf(payload: ScopedCollection[], collection: string): string | undefined {
  const entry = payload.find((item) => item.collection === collection)
  if (!entry) throw new Error(`no entry for ${collection} in ${JSON.stringify(payload)}`)
  return entry.shelf
}

beforeEach(() => {
  process.env.REQUIRE_AUTH = 'true'
  process.env.BASE_COLLECTION_NAME = 'oib_knowledge'
  vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor' } as never)
  vi.mocked(findConversationTenancy).mockResolvedValue(null)
  vi.mocked(findProjectCollectionName).mockResolvedValue(null)
  vi.mocked(findUserPreferencesForSession).mockResolvedValue(null)
})

describe('X-Grid-Collection-Scope carries the shelf (ADR-0047)', () => {
  it('is base64url(JSON) of {collection, shelf} objects, not bare strings', async () => {
    const { headerValue } = await buildCollectionScopeFromRequest(session, {
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
    })

    expect(decodeHeader(headerValue)).toEqual([
      { collection: 'oib_knowledge', shelf: 'base' },
      { collection: `archiv_${ORG_ID}`, shelf: 'archiv' },
      { collection: `proj_${PROJECT_ID}`, shelf: 'project' },
      { collection: `s_${CONVERSATION_ID}`, shelf: 'session' },
    ])
  })

  it('emits shelf `project` for the project collection — even when its stored name has no proj_ prefix', async () => {
    // The name comes from the projects table and need not look like anything.
    // The shelf is known because the BFF is the one that put it in scope, so a
    // rename can never turn project knowledge into "unknown" (or into base law).
    vi.mocked(findProjectCollectionName).mockResolvedValue('kb_custom_7')

    const { headerValue } = await buildCollectionScopeFromRequest(session, {
      projectId: PROJECT_ID,
    })

    expect(shelfOf(decodeHeader(headerValue), 'kb_custom_7')).toBe('project')
  })

  it('emits shelf `archiv` for the org-wide Archiv collection', async () => {
    const { headerValue } = await buildCollectionScopeFromRequest(session, {})

    expect(shelfOf(decodeHeader(headerValue), `archiv_${ORG_ID}`)).toBe('archiv')
  })

  it('emits shelf `session` for a private chat attachment collection', async () => {
    // The defect ADR-0047 names: this used to reach the citation layer as
    // "Projektwissen", because ('s_', 'projekt') was the only guess available.
    const { headerValue } = await buildCollectionScopeFromRequest(session, {
      conversationId: CONVERSATION_ID,
    })

    expect(shelfOf(decodeHeader(headerValue), `s_${CONVERSATION_ID}`)).toBe('session')
  })

  it('emits shelf `session` for a conversation id that already carries the s_ prefix', async () => {
    const { headerValue } = await buildCollectionScopeFromRequest(session, {
      conversationId: 's_already',
    })

    const payload = decodeHeader(headerValue)
    expect(payload.map((entry) => entry.collection)).not.toContain('s_s_already')
    expect(shelfOf(payload, 's_already')).toBe('session')
  })

  it('emits shelf `base` for the base knowledge corpus under any configured name', async () => {
    process.env.BASE_COLLECTION_NAME = 'grid_base_corpus'

    const { headerValue } = await buildCollectionScopeFromRequest(session, {})

    expect(shelfOf(decodeHeader(headerValue), 'grid_base_corpus')).toBe('base')
  })

  it('OMITS the shelf for a collection it cannot attribute, rather than defaulting it', async () => {
    // A collection the BFF did not build has no known shelf. Missing reads as
    // unknown downstream and renders unattributed; defaulting it to `base`
    // would let a stranger collection claim to be authoritative base law —
    // exactly the fail-open this ADR removes.
    vi.mocked(computeCollectionScope).mockReturnValueOnce([
      'oib_knowledge',
      'some_custom_corpus',
    ])

    const { headerValue } = await buildCollectionScopeFromRequest(session, {})
    const payload = decodeHeader(headerValue)

    expect(payload).toContainEqual({ collection: 'some_custom_corpus' })
    expect(shelfOf(payload, 'some_custom_corpus')).toBeUndefined()
    expect(Object.keys(payload[1])).toEqual(['collection'])
    // The base corpus in the same payload is still attributed.
    expect(shelfOf(payload, 'oib_knowledge')).toBe('base')
  })

  it('keeps the returned `scope` a bare id list for callers that echo it', async () => {
    const { scope } = await buildCollectionScopeFromRequest(session, {
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
    })

    expect(scope).toEqual([
      'oib_knowledge',
      `archiv_${ORG_ID}`,
      `proj_${PROJECT_ID}`,
      `s_${CONVERSATION_ID}`,
    ])
  })
})
