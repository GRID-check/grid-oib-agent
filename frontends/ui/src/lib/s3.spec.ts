/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { buildArchivStorageKey, buildStorageKey, buildThumbnailStorageKey } from './s3'

describe('buildStorageKey', () => {
  it('builds key without folder path', () => {
    const key = buildStorageKey('org-1', 'proj-1', 'doc-1', 'plan.pdf')
    expect(key).toBe('org/org-1/project/proj-1/doc/doc-1/plan.pdf')
  })

  it('builds key with folder path', () => {
    const key = buildStorageKey('org-1', 'proj-1', 'doc-1', 'plan.pdf', 'Plans/Fire Safety')
    expect(key).toBe('org/org-1/project/proj-1/Plans/Fire Safety/doc/doc-1/plan.pdf')
  })

  it('handles null folderPath', () => {
    const key = buildStorageKey('org-1', 'proj-1', 'doc-1', 'plan.pdf', null)
    expect(key).toBe('org/org-1/project/proj-1/doc/doc-1/plan.pdf')
  })
})

describe('buildArchivStorageKey', () => {
  it('scopes to the organization rather than a project', () => {
    expect(buildArchivStorageKey('org-1', 'doc-1', 'plan.pdf')).toBe(
      'org/org-1/archiv/doc/doc-1/plan.pdf',
    )
  })
})

describe('buildThumbnailStorageKey', () => {
  it('replaces the filename segment, keeping the document directory', () => {
    expect(buildThumbnailStorageKey('org/org-1/project/proj-1/doc/doc-1/plan.pdf')).toBe(
      'org/org-1/project/proj-1/doc/doc-1/_thumb.jpg',
    )
  })

  it('is a sibling of the object, so the project prefix sweep reaches it', () => {
    const key = buildStorageKey('org-1', 'proj-1', 'doc-1', 'plan.pdf')
    const thumb = buildThumbnailStorageKey(key)
    expect(thumb?.startsWith('org/org-1/project/proj-1/')).toBe(true)
  })

  it('works under a nested folder path', () => {
    const key = buildStorageKey('org-1', 'proj-1', 'doc-1', 'plan.pdf', 'Plans/Fire Safety')
    expect(buildThumbnailStorageKey(key)).toBe(
      'org/org-1/project/proj-1/Plans/Fire Safety/doc/doc-1/_thumb.jpg',
    )
  })

  // A key with no directory has no sibling slot. Returning `_thumb.jpg` — a
  // real, shared, bucket-root path — would mean a malformed or hand-edited row
  // could presign a WRITE there, and every such row would collide on one
  // object. Null instead, and the callers treat it as "no thumbnail".
  it('returns null rather than a bucket-root path for a key with no directory', () => {
    expect(buildThumbnailStorageKey('plan.pdf')).toBeNull()
    expect(buildThumbnailStorageKey('/plan.pdf')).toBeNull()
    expect(buildThumbnailStorageKey('')).toBeNull()
  })
})
