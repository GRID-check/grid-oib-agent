import { describe, expect, it } from 'vitest'
import { ruleCandidates, versionOf, type CleanupDocumentFacts } from './cleanup-rules'

let n = 0
const doc = (filename: string, overrides: Partial<CleanupDocumentFacts> = {}): CleanupDocumentFacts => ({
  id: `d${++n}`,
  filename,
  folderId: 'f1',
  folderPath: 'Pläne',
  contentType: 'application/pdf',
  tags: [],
  summary: null,
  versionState: 'published',
  authoredBy: 'user',
  contentHash: null,
  createdAt: `2026-01-${String(10 + n).padStart(2, '0')}T00:00:00Z`,
  ...overrides,
})

const proposed = (documents: CleanupDocumentFacts[]) =>
  Object.fromEntries(ruleCandidates(documents).map((candidate) => [documents.find((d) => d.id === candidate.id)?.filename, candidate.rule]))

describe('Ausmisten by rule', () => {
  it('finds lock files, temporary and system files', () => {
    expect(
      proposed([doc('~$Baubeschreibung.docx'), doc('.~lock.Kosten.xlsx#'), doc('Export.tmp'), doc('Thumbs.db'), doc('Baubeschreibung.docx')])
    ).toEqual({
      '~$Baubeschreibung.docx': 'lock-file',
      '.~lock.Kosten.xlsx#': 'lock-file',
      'Export.tmp': 'temp-file',
      'Thumbs.db': 'system-file',
    })
  })

  it('finds working copies by their name, and leaves words that merely contain „alt"', () => {
    expect(
      proposed([
        doc('Kopie von Einreichplan.pdf'),
        doc('Einreichplan - Kopie.pdf'),
        doc('Einreichplan (1).pdf'),
        doc('Kostenschätzung_alt.xlsx'),
        doc('Altbau Bestandsplan.pdf'),
        doc('Gestaltungskonzept.pdf'),
      ])
    ).toEqual({
      'Kopie von Einreichplan.pdf': 'copy-name',
      'Einreichplan - Kopie.pdf': 'copy-name',
      'Einreichplan (1).pdf': 'copy-name',
      'Kostenschätzung_alt.xlsx': 'old-name',
    })
  })

  it('keeps the earliest of the same bytes and proposes the later copies', () => {
    const first = doc('Statik.pdf', { contentHash: 'h1', createdAt: '2025-01-01T00:00:00Z' })
    const again = doc('Statik final.pdf', { contentHash: 'h1', createdAt: '2025-06-01T00:00:00Z' })
    expect(proposed([again, first])).toEqual({ 'Statik final.pdf': 'same-content' })
  })

  it('keeps the newest numbered version in a folder, and does not compare across folders', () => {
    expect(
      proposed([doc('Grundriss EG_v1.pdf'), doc('Grundriss EG_v3.pdf'), doc('Grundriss EG_v2.pdf'), doc('Grundriss EG_v1.pdf', { folderId: 'f2' })])
    ).toEqual({ 'Grundriss EG_v1.pdf': 'older-version', 'Grundriss EG_v2.pdf': 'older-version' })
    expect(proposed([doc('Schnitt Index A.pdf'), doc('Schnitt Index B.pdf')])).toEqual({ 'Schnitt Index A.pdf': 'older-version' })
  })

  it('proposes a Piloti draft nobody published, and no person\'s draft', () => {
    expect(
      proposed([doc('Aktenvermerk.md', { authoredBy: 'agent', versionState: 'draft' }), doc('Notiz.md', { versionState: 'draft' })])
    ).toEqual({ 'Aktenvermerk.md': 'unpublished-draft' })
  })

  it('reads a version marker only at the end of a name', () => {
    expect(versionOf('Plan_v12.pdf')).toEqual({ base: 'plan', version: 12 })
    expect(versionOf('Rev 3 Plan.pdf')).toBeNull()
    expect(versionOf('Bescheid.pdf')).toBeNull()
  })
})
