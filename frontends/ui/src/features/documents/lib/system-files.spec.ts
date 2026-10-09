import { describe, expect, it } from 'vitest'
import { isSystemFile } from './system-files'

describe('isSystemFile', () => {
  it.each(['.DS_Store', 'Thumbs.db', 'desktop.ini', '._EG_Grundriss.pdf', '~$Vertrag.docx', '.~lock.Kosten.xlsx#'])(
    'drops %s',
    (name) => expect(isSystemFile(name)).toBe(true)
  )

  it.each(['EG_Grundriss.pdf', 'Vertrag.docx', '_Index.pdf', 'Thumbs.db.pdf', 'Kosten~$.xlsx'])('keeps %s', (name) =>
    expect(isSystemFile(name)).toBe(false)
  )
})
