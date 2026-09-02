/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_STORED_IMAGES_PER_DOCUMENT,
  buildArchivStorageKey,
  buildImageDerivedPrefix,
  buildImageStorageKey,
  buildStorageKey,
  buildThumbnailStorageKey,
  storageKeySegment,
} from './s3'

/**
 * The only parts of an object key that are not machine-generated ids.
 *
 * `assertUploadTypeAllowed` inspects the substring after the last dot and
 * nothing else, so a multipart part named `../../../../org/<other>/…/x.ifc`
 * passes every gate on the way here. Per-org buckets are off by default, which
 * makes the `org/<id>/` prefix the only separation there is — and the key is
 * persisted and reused afterwards, including by the recursive prefix delete
 * that removes a model's derived objects.
 */
describe('storageKeySegment', () => {
  it('cannot climb out of the segment it was given', () => {
    expect(storageKeySegment('../../../../org/victim/doc/x.ifc')).toBe(
      '.._.._.._.._org_victim_doc_x.ifc'
    )
    expect(storageKeySegment('..\\..\\windows\\x.ifc')).toBe('.._.._windows_x.ifc')
    expect(storageKeySegment('..')).toBe('_..')
    expect(storageKeySegment('.')).toBe('_.')
  })

  it('leaves an ordinary name — including a leading dot — alone', () => {
    expect(storageKeySegment('Haus-Mayr_V3.ifc')).toBe('Haus-Mayr_V3.ifc')
    expect(storageKeySegment('.hidden.ifc')).toBe('.hidden.ifc')
    // Not ASCII-folded: Austrian filenames are full of them, and an object key
    // is UTF-8.
    expect(storageKeySegment('Grundriss Erdgeschoß.pdf')).toBe('Grundriss Erdgeschoß.pdf')
  })

  it('never returns an empty segment, which would be a directory write', () => {
    expect(storageKeySegment('')).toBe('unnamed')
    expect(storageKeySegment('   ')).toBe('unnamed')
    expect(storageKeySegment('/')).toBe('_')
  })

  it('drops control characters and caps the length', () => {
    expect(storageKeySegment('a\u0000b\u007fc.ifc')).toBe('abc.ifc')
    expect(storageKeySegment('x'.repeat(400))).toHaveLength(255)
  })
})

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

  it('keeps an uploaded filename inside the document it belongs to', () => {
    const key = buildStorageKey('org-1', 'proj-1', 'doc-1', '../../../../org/victim/x.ifc')
    expect(key.startsWith('org/org-1/project/proj-1/doc/doc-1/')).toBe(true)
    expect(key).not.toContain('/../')
    expect(key).not.toContain('victim/')
  })

  it('keeps a folder NAME inside the project, while keeping the path a path', () => {
    // Folder names are person-chosen too, and the path arrives already joined
    // — so the separators between segments have to survive while a `..` inside
    // one of them does not.
    const key = buildStorageKey('org-1', 'proj-1', 'doc-1', 'plan.pdf', 'Plans/../../elsewhere')
    expect(key).toBe('org/org-1/project/proj-1/Plans/_../_../elsewhere/doc/doc-1/plan.pdf')
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

describe('buildImageStorageKey', () => {
  const key = buildStorageKey('org-1', 'proj-1', 'doc-1', 'plan.pdf', 'Plans/Fire Safety')

  it('files the raster under the document directory, in the _img/ prefix', () => {
    expect(buildImageStorageKey(key, 0)).toBe('org/org-1/project/proj-1/Plans/Fire Safety/doc/doc-1/_img/0.jpg')
    expect(buildImageStorageKey(key, 7)).toBe('org/org-1/project/proj-1/Plans/Fire Safety/doc/doc-1/_img/7.jpg')
  })

  it('stays under the prefix the cleanup sweeps', () => {
    const prefix = buildImageDerivedPrefix(key)
    expect(prefix).toBe('org/org-1/project/proj-1/Plans/Fire Safety/doc/doc-1/_img/')
    expect(buildImageStorageKey(key, 3)?.startsWith(prefix as string)).toBe(true)
  })

  // The index is the ONLY free variable; everything else is the document's own
  // key. An unbounded index would let one ingest mint an unbounded number of
  // objects under the tenant's prefix.
  it('refuses an index outside the per-document ceiling, or one that is not an integer', () => {
    expect(buildImageStorageKey(key, MAX_STORED_IMAGES_PER_DOCUMENT - 1)).not.toBeNull()
    expect(buildImageStorageKey(key, MAX_STORED_IMAGES_PER_DOCUMENT)).toBeNull()
    expect(buildImageStorageKey(key, -1)).toBeNull()
    expect(buildImageStorageKey(key, 1.5)).toBeNull()
    expect(buildImageStorageKey(key, Number.NaN)).toBeNull()
  })

  it('returns null rather than a bucket-root path for a key with no directory', () => {
    expect(buildImageStorageKey('plan.pdf', 0)).toBeNull()
    expect(buildImageStorageKey('a/b/', 0)).toBeNull()
    expect(buildImageDerivedPrefix('')).toBeNull()
  })
})
