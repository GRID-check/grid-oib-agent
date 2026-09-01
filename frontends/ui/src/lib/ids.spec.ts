import { describe, expect, it } from 'vitest'
import { isUuid } from './ids'

describe('isUuid', () => {
  it('accepts a v4 uuid, which is what documents.id is', () => {
    expect(isUuid('da1b111c-1b75-4230-b497-f9b9d3509d78')).toBe(true)
  })

  it('rejects a filename, which postgres will not coerce to uuid (#572)', () => {
    expect(isUuid('HdB-Hamm_Schnitt-1_Ansicht-Nord-West.jpg')).toBe(false)
  })

  it('rejects empty and obviously short values', () => {
    expect(isUuid('')).toBe(false)
    expect(isUuid('doc-1')).toBe(false)
  })
})
