/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { collectionDocumentsUrl, collectionFileRef, collectionFileUrl } from './collection-file-ref'

const row = {
  collectionName: 'proj_abc',
  filename: 'brandschutz-gutachten-2026-08-20.pdf',
  publishedVersionId: null,
} as const

/** A Piloti document under its namespace, with a version published. */
const publishedPiloti = {
  collectionName: 'proj_abc',
  filename: 'piloti/doc_1/aktenvermerk-2026-09-01.md',
  authoredBy: 'agent',
  publishedVersionId: 'ver_2',
} as const

describe('collectionFileRef', () => {
  it('names the pair for a row a person uploaded', () => {
    expect(collectionFileRef({ ...row, authoredBy: 'user' })).toMatchObject({
      collectionName: 'proj_abc',
      filename: 'brandschutz-gutachten-2026-08-20.pdf',
    })
  })

  it('names the pair for a person’s row whatever its version pointer says', () => {
    // A human upload owns its chunks from the moment it is ingested, and its
    // pointer is `null` for every row written before migration 0082. The
    // published-version clause is about machine-authored rows only.
    expect(collectionFileRef({ ...row, authoredBy: 'user', publishedVersionId: 'ver_1' })).not.toBeNull()
    expect(collectionFileRef({ ...row, authoredBy: 'user', publishedVersionId: null })).not.toBeNull()
  })

  it('refuses a row a machine wrote, however ordinary the pair looks', () => {
    // Same collection, same filename — the collision `generatedFilename` puts
    // within the model's reach. The pair is not what decides; the row is.
    expect(collectionFileRef({ ...row, authoredBy: 'agent' })).toBeNull()
  })

  it('names the pair for a PUBLISHED Piloti document under its namespace', () => {
    // The one case ADR-0054 added: this row really does own chunks, so a purge
    // or a folder mirror addressed at it addresses its own passages.
    expect(collectionFileRef(publishedPiloti)).toMatchObject({
      collectionName: 'proj_abc',
      filename: 'piloti/doc_1/aktenvermerk-2026-09-01.md',
    })
  })

  it('refuses an agent draft under the namespace: nothing was ever published', () => {
    // Only a published version is dispatched, so a draft has no chunks — and
    // asking the backend to forget a name that was never ingested is at best a
    // wasted call and at worst somebody else's document.
    expect(collectionFileRef({ ...publishedPiloti, publishedVersionId: null })).toBeNull()
  })

  it('refuses a published agent row OUTSIDE the namespace', () => {
    // A document filed before the namespace existed. Its name is
    // `slug(model's title)-YYYY-MM-DD.ext` in the project's own collection,
    // which is exactly the name a human upload can carry — the collision this
    // module was written for. `ingestPublished` refuses to index such a row for
    // the same reason, so "indexed" and "addressable" stay the same set.
    expect(
      collectionFileRef({ ...publishedPiloti, filename: 'brandschutz-gutachten-2026-08-20.pdf' }),
    ).toBeNull()
  })

  it('is not fooled by a name that merely mentions piloti', () => {
    // The prefix is a path segment, not a substring: `piloti-bericht.md` is a
    // name a person can type, and a `includes('piloti')` test would hand it a
    // ref it must not have.
    expect(collectionFileRef({ ...publishedPiloti, filename: 'piloti-bericht.md' })).toBeNull()
    expect(collectionFileRef({ ...publishedPiloti, filename: 'x/piloti/doc_1/a.md' })).toBeNull()
  })
})

describe('the URL builders', () => {
  const ref = collectionFileRef({ ...row, authoredBy: 'user' })
  if (!ref) throw new Error('unreachable: the fixture row is human-authored')

  it('builds the collection-level documents endpoint', () => {
    expect(collectionDocumentsUrl('http://backend:8000', ref)).toBe(
      'http://backend:8000/v1/collections/proj_abc/documents',
    )
  })

  it('builds a per-file endpoint from the same ref', () => {
    expect(collectionFileUrl('http://backend:8000', ref, '/visual-details')).toBe(
      'http://backend:8000/v1/collections/proj_abc/documents/brandschutz-gutachten-2026-08-20.pdf/visual-details',
    )
  })

  it('percent-encodes both segments, so a name with a slash cannot leave its collection', () => {
    const awkward = collectionFileRef({
      collectionName: 'proj_a b',
      filename: 'Schnitt A-A/EG.pdf',
      authoredBy: 'user',
      publishedVersionId: null,
    })
    if (!awkward) throw new Error('unreachable: the fixture row is human-authored')

    expect(collectionFileUrl('http://backend:8000', awkward, '/tags')).toBe(
      'http://backend:8000/v1/collections/proj_a%20b/documents/Schnitt%20A-A%2FEG.pdf/tags',
    )
  })
})
