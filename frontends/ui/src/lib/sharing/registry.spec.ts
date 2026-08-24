/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { SHAREABLE_RESOURCE_TYPES } from '@/lib/db/schema'
import { SHAREABLE_REGISTRY, describeResource } from './registry'

describe('SHAREABLE_REGISTRY', () => {
  it('registers every shareable type', () => {
    expect(Object.keys(SHAREABLE_REGISTRY).sort()).toEqual([...SHAREABLE_RESOURCE_TYPES].sort())
  })

  it('conversation and document both persist visibility through the descriptor', () => {
    expect(typeof describeResource('conversation').setVisibility).toBe('function')
    expect(typeof describeResource('document').setVisibility).toBe('function')
  })

  it('reads declared descriptor fields instead of leaving them unread', () => {
    const document = describeResource('document')
    expect(document.defaultVisibility).toBe('project')
    expect(document.supportsMentions).toBe(false)
    expect(document.labelKey).toBe('document')
    expect(document.deepLink('doc-1', { projectId: 'p1' })).toBe('/app/projects/p1/files?doc=doc-1')
  })
})
