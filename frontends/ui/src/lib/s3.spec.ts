/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { BadRequestError } from '@/lib/api/errors'
import { inboundMailStagingPrefix, mailOriginalStorageKey } from '@/lib/inbound-mail/inbound-mail-vocabulary'
import {
  MAX_STORED_IMAGES_PER_DOCUMENT,
  buildOfficeShelfStorageKey,
  buildBaseCorpusStorageKey,
  buildImageDerivedPrefix,
  buildImageStorageKey,
  buildRenditionStorageKey,
  buildStorageKey,
  buildThumbnailStorageKey,
  LOCAL_STORAGE_ENDPOINT,
  storageEndpoint,
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

  /**
   * The Outlook import stages its archive at `<project>/mail-imports/<import
   * id>/archive` (`lib/mail-import/staging.ts`). A person's folder of that name
   * would file documents inside the stage, where a sweep of staged archives by
   * prefix would take them with it.
   */
  it('never files a document under the import’s staging prefix', () => {
    expect(storageKeySegment('mail-imports')).toBe('_mail-imports')
    expect(storageKeySegment('Mail-Imports')).toBe('_Mail-Imports')
    expect(storageKeySegment('mail-imports-2019')).toBe('mail-imports-2019')
    const importId = '7c1f0f8e-0b6a-4f41-9d3b-5a0b2f9e1a01'
    const stage = `org/org-1/project/proj-1/mail-imports/${importId}/`
    for (const folder of ['mail-imports', `mail-imports/${importId}`, `MAIL-IMPORTS/${importId}`]) {
      const key = buildStorageKey('org-1', 'proj-1', 'doc-1', 'archive', folder)
      expect(key.toLowerCase().startsWith('org/org-1/project/proj-1/mail-imports/'), folder).toBe(false)
      expect(key.startsWith(stage), folder).toBe(false)
    }
    expect(buildStorageKey('org-1', 'proj-1', 'doc-1', 'archive', `mail-imports/${importId}`)).toBe(
      `org/org-1/project/proj-1/_mail-imports/${importId}/doc/doc-1/archive`,
    )
  })

  /**
   * A mail sent to the project waits at `<project>/_inbound-mail/<mail id>/`,
   * and a filed message's original is kept at `<project>/_mail-originals/<entry
   * id>.eml` (ADR-0134, `lib/inbound-mail/inbound-mail-vocabulary.ts`). A
   * person's folder or file of either name would put the office's documents
   * among a stranger's unreviewed mail, or among evidence no model may read.
   */
  it('never files a document under the inbound mail or originals prefixes', () => {
    const mailId = '1a000000-0000-4000-8000-000000000184'
    const entryId = 'e1000000-0000-4000-8000-000000000184'
    const owner = { organizationId: 'org-1', projectId: 'proj-1' }
    const staged = inboundMailStagingPrefix(owner, mailId)
    const original = mailOriginalStorageKey(owner, entryId)
    expect(staged).toBe(`org/org-1/project/proj-1/_inbound-mail/${mailId}/`)
    expect(original).toBe(`org/org-1/project/proj-1/_mail-originals/${entryId}.eml`)

    expect(storageKeySegment('_inbound-mail')).toBe('__inbound-mail')
    expect(storageKeySegment('_Inbound-Mail')).toBe('__Inbound-Mail')
    expect(storageKeySegment('_mail-originals')).toBe('__mail-originals')
    expect(storageKeySegment('_MAIL-ORIGINALS')).toBe('__MAIL-ORIGINALS')
    // Only the exact names.
    expect(storageKeySegment('inbound-mail')).toBe('inbound-mail')
    expect(storageKeySegment('_inbound-mail-2026')).toBe('_inbound-mail-2026')

    for (const folder of ['_inbound-mail', `_inbound-mail/${mailId}`, `_INBOUND-MAIL/${mailId}`]) {
      const key = buildStorageKey('org-1', 'proj-1', 'doc-1', 'raw.eml', folder)
      expect(key.toLowerCase().startsWith('org/org-1/project/proj-1/_inbound-mail/'), folder).toBe(false)
    }
    for (const folder of ['_mail-originals', '_Mail-Originals']) {
      const key = buildStorageKey('org-1', 'proj-1', 'doc-1', `${entryId}.eml`, folder)
      expect(key.toLowerCase().startsWith('org/org-1/project/proj-1/_mail-originals/'), folder).toBe(false)
    }
    expect(buildStorageKey('org-1', 'proj-1', 'doc-1', 'raw.eml', `_inbound-mail/${mailId}`)).toBe(
      `org/org-1/project/proj-1/__inbound-mail/${mailId}/doc/doc-1/raw.eml`,
    )
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

describe('buildOfficeShelfStorageKey', () => {
  it('scopes to the organization rather than a project', () => {
    expect(buildOfficeShelfStorageKey('org-1', 'doc-1', 'plan.pdf')).toBe(
      'org/org-1/office_shelf/doc/doc-1/plan.pdf',
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

describe('storageEndpoint', () => {
  it('reads SEAWEED_ENDPOINT, and the public one first for the browser-facing client', () => {
    const env = { SEAWEED_ENDPOINT: 'http://seaweedfs:8333', SEAWEED_PUBLIC_ENDPOINT: 'https://files.piloti.test' }
    expect(storageEndpoint('internal', env)).toBe('http://seaweedfs:8333')
    expect(storageEndpoint('public', env)).toBe('https://files.piloti.test')
    expect(storageEndpoint('public', { SEAWEED_ENDPOINT: 'http://seaweedfs:8333' })).toBe('http://seaweedfs:8333')
  })

  it('never lets an unset endpoint fall through to AWS S3', () => {
    expect(storageEndpoint('internal', { NODE_ENV: 'development' })).toBe(LOCAL_STORAGE_ENDPOINT)
    expect(() => storageEndpoint('internal', { NODE_ENV: 'production', SEAWEED_ENDPOINT: ' ' })).toThrow(/SEAWEED_ENDPOINT is not set/)
  })

  it('signs for the local store, not amazonaws.com, when nothing is set in development', async () => {
    const saved = { internal: process.env.SEAWEED_ENDPOINT, browser: process.env.SEAWEED_PUBLIC_ENDPOINT }
    delete process.env.SEAWEED_ENDPOINT
    delete process.env.SEAWEED_PUBLIC_ENDPOINT
    try {
      vi.resetModules()
      const fresh = await import('./s3')
      const { GetObjectCommand } = await import('@aws-sdk/client-s3')
      const url = new URL(await fresh.presignForBackend(new GetObjectCommand({ Bucket: 'grid-documents', Key: 'a.pdf' }), 60))
      expect(url.host).toBe('localhost:8333')
    } finally {
      process.env.SEAWEED_ENDPOINT = saved.internal
      process.env.SEAWEED_PUBLIC_ENDPOINT = saved.browser
      vi.resetModules()
    }
  })
})
