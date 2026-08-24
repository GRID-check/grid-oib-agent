/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from 'vitest'
import { buildCollectionScopeHeader, computeCollectionScope } from './collection-scope'

afterEach(() => {
  delete process.env.BASE_COLLECTION_NAME
})

describe('computeCollectionScope', () => {
  it('always includes the base corpus first', () => {
    process.env.BASE_COLLECTION_NAME = 'oib_knowledge'
    expect(computeCollectionScope(null, {})).toEqual(['oib_knowledge'])
  })

  it('injects the org Archiv collection right after the base corpus (ADR-0024)', () => {
    process.env.BASE_COLLECTION_NAME = 'oib_knowledge'
    const scope = computeCollectionScope(null, {
      archivCollectionName: 'archiv_org-1',
      projectId: 'p1',
      projectCollectionName: 'proj_p1',
    })
    expect(scope).toEqual(['oib_knowledge', 'archiv_org-1', 'proj_p1'])
  })

  it('omits the Archiv collection when none is provided (feature off)', () => {
    process.env.BASE_COLLECTION_NAME = 'oib_knowledge'
    const scope = computeCollectionScope(null, { projectCollectionName: 'proj_p1' })
    expect(scope).toEqual(['oib_knowledge', 'proj_p1'])
  })

  it('de-duplicates and round-trips through the header encoding', () => {
    process.env.BASE_COLLECTION_NAME = 'base'
    const scope = computeCollectionScope(null, { archivCollectionName: 'archiv_org-1', conversationId: 'c1' })
    expect(scope).toEqual(['base', 'archiv_org-1', 's_c1'])
    const decoded = JSON.parse(Buffer.from(buildCollectionScopeHeader(scope), 'base64url').toString())
    expect(decoded).toEqual(scope)
  })
})
