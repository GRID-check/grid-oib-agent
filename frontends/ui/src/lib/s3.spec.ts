/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { BadRequestError } from '@/lib/api/errors'
import {
  MAX_STORED_IMAGES_PER_DOCUMENT,
  buildArchivStorageKey,
  buildBaseCorpusStorageKey,
  buildImageDerivedPrefix,
  buildImageStorageKey,
  buildRenditionStorageKey,
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
  it('guards a dot-only name that only surrounding spaces hid', () => {
    expect(storageKeySegment(' .. ')).toBe('_..')
  })

  /**
   * A file may not take the name of a sibling the pipelines derive from it. A
   * `_render.pdf` upload was its own rendition, and a `_thumb.jpg` upload was
   * overwritten by its own thumbnail.
   */
  it('never produces the name of a derived sibling or prefix', () => {
    expect(storageKeySegment('_render.pdf')).toBe('__render.pdf')
    expect(storageKeySegment('_thumb.jpg')).toBe('__thumb.jpg')
    expect(storageKeySegment('_img')).toBe('__img')
    expect(storageKeySegment('_bim')).toBe('__bim')
    expect(storageKeySegment('_Render.PDF')).toBe('__Render.PDF')
    expect(storageKeySegment(' _thumb.jpg ')).toBe('__thumb.jpg')
    // Only the exact names: a file that merely resembles one is left alone.
    expect(storageKeySegment('_render.pdf.docx')).toBe('_render.pdf.docx')
    expect(storageKeySegment('render.pdf')).toBe('render.pdf')
  })

  it('keeps an uploaded file off its own derived keys', () => {
    for (const name of ['_render.pdf', '_thumb.jpg']) {
      const key = buildStorageKey('org-1', 'proj-1', 'doc-1', name)
      expect(buildRenditionStorageKey(key)).not.toBe(key)
      expect(buildThumbnailStorageKey(key)).not.toBe(key)
    }
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

  it('returns null for a legacy row whose file IS `_thumb.jpg`, so the thumbnail PUT cannot overwrite it', () => {
    expect(buildThumbnailStorageKey('org/org-1/project/proj-1/doc/doc-1/_thumb.jpg')).toBeNull()
  })
})

/**
 * The office rendition (ADR-0070). Its existence is the only state it has — no
 * column records it — so the key must be derivable from the row alone, and the
 * same row must always derive the same key.
 */
describe('buildRenditionStorageKey', () => {
  it('is a sibling of the file, beside the thumbnail', () => {
    const key = buildStorageKey('org-1', 'proj-1', 'doc-1', 'Bericht.docx', 'Plans/Fire Safety')
    expect(buildRenditionStorageKey(key)).toBe(
      'org/org-1/project/proj-1/Plans/Fire Safety/doc/doc-1/_render.pdf',
    )
  })

  it('follows the per-version directory, so each version renders its own bytes', () => {
    expect(buildRenditionStorageKey('org/org-1/project/proj-1/doc/doc-1/v2/Bericht.docx')).toBe(
      'org/org-1/project/proj-1/doc/doc-1/v2/_render.pdf',
    )
  })

  it('returns null for the shapes that have no directory to put it in', () => {
    expect(buildRenditionStorageKey('Bericht.docx')).toBeNull()
    expect(buildRenditionStorageKey('/Bericht.docx')).toBeNull()
    expect(buildRenditionStorageKey('a/b/')).toBeNull()
    expect(buildRenditionStorageKey('')).toBeNull()
  })

  it('returns null for a legacy row whose file IS `_render.pdf`: the raw upload is no rendition', () => {
    expect(buildRenditionStorageKey('org/org-1/project/proj-1/doc/doc-1/_render.pdf')).toBeNull()
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

describe('buildBaseCorpusStorageKey', () => {
  it('keeps a plain PDF basename verbatim under the base-corpus prefix', () => {
    expect(buildBaseCorpusStorageKey('OIB-RL 2 Brandschutz.pdf')).toBe('base-corpus/OIB-RL 2 Brandschutz.pdf')
    expect(buildBaseCorpusStorageKey('ÖNORM B 1300.PDF')).toBe('base-corpus/ÖNORM B 1300.PDF')
    expect(buildBaseCorpusStorageKey('50%.pdf')).toBe('base-corpus/50%.pdf')
    expect(buildBaseCorpusStorageKey('..hidden.pdf')).toBe('base-corpus/..hidden.pdf')
  })

  it('refuses anything that is not a plain PDF basename', () => {
    const refused = [
      '',
      '.',
      '..',
      'norm.txt',
      'norm.pdf.zip',
      'norm',
      '../norm.pdf',
      'a/norm.pdf',
      '/norm.pdf',
      'a\\norm.pdf',
      'nor\u0000m.pdf',
      'nor\nm.pdf',
      'nor\u007fm.pdf',
      `${'a'.repeat(252)}.pdf`,
    ]
    for (const name of refused) {
      expect(() => buildBaseCorpusStorageKey(name), JSON.stringify(name)).toThrow(BadRequestError)
    }
  })

  it('accepts the 255-character ceiling exactly', () => {
    const name = `${'a'.repeat(251)}.pdf`
    expect(name).toHaveLength(255)
    expect(buildBaseCorpusStorageKey(name)).toBe(`base-corpus/${name}`)
  })
})

describe('presignForBackend', () => {
  it('signs against the in-network endpoint, never the browser-facing one', async () => {
    // The clients read the endpoints at import, so this imports a fresh copy
    // with the two set apart, the way Compose and Kubernetes set them.
    const saved = { internal: process.env.SEAWEED_ENDPOINT, browser: process.env.SEAWEED_PUBLIC_ENDPOINT }
    process.env.SEAWEED_ENDPOINT = 'http://seaweedfs:8333'
    process.env.SEAWEED_PUBLIC_ENDPOINT = 'http://localhost:8333'
    try {
      vi.resetModules()
      const fresh = await import('./s3')
      const { PutObjectCommand } = await import('@aws-sdk/client-s3')
      const url = new URL(
        await fresh.presignForBackend(
          new PutObjectCommand({ Bucket: 'grid-documents', Key: 'base-corpus/x.pdf', ContentType: 'application/pdf' }),
          60
        )
      )
      expect(url.host).toBe('seaweedfs:8333')
    } finally {
      process.env.SEAWEED_ENDPOINT = saved.internal
      process.env.SEAWEED_PUBLIC_ENDPOINT = saved.browser
      vi.resetModules()
    }
  })
})
