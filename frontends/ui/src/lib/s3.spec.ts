import { describe, expect, it } from 'vitest'
import { buildObjectKey } from './s3'

describe('buildObjectKey', () => {
  it('builds key without folder path', () => {
    const key = buildObjectKey('org-1', 'proj-1', 'doc-1', 'plan.pdf')
    expect(key).toBe('org/org-1/project/proj-1/doc/doc-1/plan.pdf')
  })

  it('builds key with folder path', () => {
    const key = buildObjectKey('org-1', 'proj-1', 'doc-1', 'plan.pdf', 'Plans/Fire Safety')
    expect(key).toBe('org/org-1/project/proj-1/Plans/Fire Safety/doc/doc-1/plan.pdf')
  })

  it('handles null folderPath', () => {
    const key = buildObjectKey('org-1', 'proj-1', 'doc-1', 'plan.pdf', null)
    expect(key).toBe('org/org-1/project/proj-1/doc/doc-1/plan.pdf')
  })
})
