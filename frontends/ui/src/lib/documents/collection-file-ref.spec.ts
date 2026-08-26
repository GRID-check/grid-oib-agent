/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { collectionDocumentsUrl, collectionFileRef, collectionFileUrl } from './collection-file-ref'

const row = {
  collectionName: 'proj_abc',
  filename: 'brandschutz-gutachten-2026-08-20.pdf',
} as const

describe('collectionFileRef', () => {
  it('names the pair for a row a person uploaded', () => {
    expect(collectionFileRef({ ...row, authoredBy: 'user' })).toMatchObject({
      collectionName: 'proj_abc',
      filename: 'brandschutz-gutachten-2026-08-20.pdf',
    })
  })

  it('refuses a row a machine wrote, however ordinary the pair looks', () => {
    // Same collection, same filename — the collision `generatedFilename` puts
    // within the model's reach. The pair is not what decides; the row is.
    expect(collectionFileRef({ ...row, authoredBy: 'agent' })).toBeNull()
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
    })
    if (!awkward) throw new Error('unreachable: the fixture row is human-authored')

    expect(collectionFileUrl('http://backend:8000', awkward, '/tags')).toBe(
      'http://backend:8000/v1/collections/proj_a%20b/documents/Schnitt%20A-A%2FEG.pdf/tags',
    )
  })
})
