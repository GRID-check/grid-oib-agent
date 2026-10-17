/**
 * @vitest-environment node
 */
/**
 * The Anmerkungen as a Protokoll (`./export.ts`).
 *
 * The read gate is the listing's: the document through
 * `getAccessibleDocument(…, 'read')` and the marks through `listAnnotations`,
 * both mocked here, so what is under test is that the export asks them and
 * nothing else, and what it makes of their answer: the order (by number), the
 * scope and Fassung filters, Piloti's unreviewed proposals left out or set
 * apart, who stands behind a mark and who wrote a reply, and the three files.
 * The bytes are read back with readers that share no code with the writers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/documents/version-repository', () => ({ listDocumentVersions: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn() }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/i18n/server', async () => {
  const { getDictionary } = await import('@/i18n/dictionaries')
  const { createTranslator } = await import('@/i18n/translate')
  return {
    getLocale: vi.fn().mockResolvedValue('de'),
    getTranslations: vi.fn(async (namespace?: string) => createTranslator(getDictionary('de'), namespace)),
  }
})
vi.mock('./service', () => ({ listAnnotations: vi.fn() }))

import { NotFoundError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { DocumentVersion } from '@/lib/db/schema'
import { getAccessibleDocument } from '@/lib/documents/access'
import { listDocumentVersions } from '@/lib/documents/version-repository'
import { getDictionary } from '@/i18n/dictionaries'
import { createTranslator } from '@/i18n/translate'
import { findProjectInOrg } from '@/lib/projects/repository'
import { makeDocument, makeProject } from '@/test-utils/db-fixtures'
import { readPdf } from '@/test-utils/read-pdf'
import { readZipEntries } from '@/test-utils/read-zip'
import type { AnnotationExportOptions } from './export-request'
import {
  blocksToMarkdown,
  buildProtocol,
  exportAnnotationProtocol,
  protocolFileName,
  selectMarks,
  type ProtocolHeader,
} from './export'
import { listAnnotations } from './service'
import type { AnnotationReplyView, AnnotationView } from './types'

const SESSION = {
  userId: 'user_anna',
  organizationId: 'org_1',
  email: 'anna@buero.test',
  name: 'Anna Berger',
} as AuthorizedSession

const t = createTranslator(getDictionary('de'), 'files')

const reply = (overrides: Partial<AnnotationReplyView> = {}): AnnotationReplyView => ({
  id: 'reply_1',
  annotationId: 'a1',
  authorKind: 'person',
  body: 'Wird im nächsten Stand korrigiert.',
  createdBy: 'user_bernd',
  createdByName: 'Bernd Huber',
  createdAt: '2026-10-08T09:00:00.000Z',
  addressesPiloti: false,
  ...overrides,
})

const mark = (overrides: Partial<AnnotationView> = {}): AnnotationView => ({
  id: `a${overrides.number ?? 1}`,
  documentId: 'doc_1',
  number: 1,
  page: 1,
  shape: 'point',
  x: 0.5,
  y: 0.5,
  w: null,
  h: null,
  kind: 'hint',
  body: 'Text',
  basis: null,
  authorKind: 'person',
  status: 'open',
  assigneeUserId: null,
  assigneeName: null,
  dueOn: null,
  fassungNumber: 3,
  onCurrentFassung: true,
  createdBy: 'user_anna',
  createdByName: 'Anna Berger',
  createdAt: '2026-10-07T08:00:00.000Z',
  updatedAt: '2026-10-07T08:00:00.000Z',
  acceptedBy: null,
  acceptedByName: null,
  closedBy: null,
  closedByName: null,
  closedAt: null,
  delegatedBy: null,
  delegatedByName: null,
  delegatedAt: null,
  replies: [],
  canEdit: true,
  canDelete: true,
  ...overrides,
})

/** A review as an office has one: out of order, a closed mark, an earlier Fassung's, Piloti's in both states. */
const ANNOTATIONS: AnnotationView[] = [
  mark({
    number: 4,
    page: 2,
    kind: 'defect',
    body: 'Lichte Breite der Fluchttür fehlt.',
    assigneeUserId: 'user_bernd',
    assigneeName: 'Bernd Huber',
    dueOn: '2026-10-20',
    replies: [
      reply(),
      reply({
        id: 'reply_2',
        authorKind: 'piloti',
        createdBy: 'user_anna',
        createdByName: 'Anna Berger',
        body: 'Erledigt: im Schnitt B-B mit 1,25 m kotiert.',
        createdAt: '2026-10-09T10:00:00.000Z',
      }),
    ],
  }),
  mark({ number: 1, body: 'Höhenkote prüfen.' }),
  mark({
    number: 2,
    status: 'resolved',
    body: 'Schon erledigt.',
    closedBy: 'user_bernd',
    closedByName: 'Bernd Huber',
    closedAt: '2026-10-09T12:00:00.000Z',
  }),
  mark({ number: 3, onCurrentFassung: false, fassungNumber: 2, body: 'Auf der alten Fassung.' }),
  mark({
    number: 8,
    onCurrentFassung: false,
    fassungNumber: 2,
    status: 'resolved',
    body: 'Auf der alten Fassung erledigt.',
    closedBy: 'user_bernd',
    closedByName: 'Bernd Huber',
    closedAt: '2026-09-01T12:00:00.000Z',
  }),
  mark({
    number: 5,
    authorKind: 'piloti',
    kind: 'question',
    body: 'Brandabschnitt über 1.600 m²?',
    acceptedBy: 'user_anna',
    acceptedByName: 'Anna Berger',
  }),
  mark({ number: 6, authorKind: 'piloti', status: 'proposed', body: 'Geländer zu niedrig?' }),
  mark({ number: 7, authorKind: 'piloti', status: 'dismissed', body: 'Verworfener Vorschlag.' }),
]

const OPTIONS: AnnotationExportOptions = { format: 'md', scope: 'open', fassung: 'current', includeProposals: false }

const HEADER: ProtocolHeader = {
  documentName: 'Grundriss EG.pdf',
  fassung: { number: 3, total: 5, createdAt: '2026-08-14T10:00:00.000Z' },
  projectName: 'Wohnhaus Lindengasse',
  exportedAt: new Date('2026-10-13T12:30:00.000Z'),
  exportedBy: 'Anna Berger',
}

const numbers = (marks: AnnotationView[]) => marks.map((annotation) => annotation.number)
const markdownOf = (options: Partial<AnnotationExportOptions> = {}) => {
  const all = { ...OPTIONS, ...options }
  const protocol = buildProtocol(HEADER, selectMarks(ANNOTATIONS, all), all, t, 'de')
  return blocksToMarkdown([
    { kind: 'heading', level: 1, text: protocol.title },
    ...protocol.facts.map((fact) => ({ kind: 'paragraph' as const, runs: [{ text: `${fact.label}: ${fact.value}` }] })),
    ...protocol.body,
  ])
}

describe('selectMarks', () => {
  it('orders by number and keeps every open mark, those still open from an earlier Fassung too, without proposals', () => {
    // Index C arrived before the Jour fixe: Nr. 3, set on Fassung 2, is still open and is still on the agenda.
    const { marks, proposals } = selectMarks(ANNOTATIONS, OPTIONS)
    expect(numbers(marks)).toEqual([1, 3, 4, 5])
    expect(proposals).toEqual([])
    expect(numbers(selectMarks(ANNOTATIONS, { ...OPTIONS, fassung: 'all' }).marks)).toEqual([1, 3, 4, 5])
  })

  it('takes closed marks in with scope=all, and those closed on earlier Fassungen only with fassung=all', () => {
    expect(numbers(selectMarks(ANNOTATIONS, { ...OPTIONS, scope: 'all' }).marks)).toEqual([1, 2, 3, 4, 5])
    expect(numbers(selectMarks(ANNOTATIONS, { ...OPTIONS, scope: 'all', fassung: 'all' }).marks)).toEqual([
      1, 2, 3, 4, 5, 8,
    ])
  })

  it('sets apart what Piloti proposed and nobody took over, only when asked, and by scope', () => {
    expect(numbers(selectMarks(ANNOTATIONS, { ...OPTIONS, includeProposals: true }).proposals)).toEqual([6])
    const all = selectMarks(ANNOTATIONS, { ...OPTIONS, scope: 'all', includeProposals: true })
    expect(numbers(all.proposals)).toEqual([6, 7])
    // Never among the office's marks, whatever the scope.
    expect(numbers(all.marks)).not.toContain(6)
    expect(numbers(all.marks)).not.toContain(7)
  })
})

describe('the Protokoll', () => {
  it('states the document, its Fassung and Stand, the project, and who exported it when', () => {
    const md = markdownOf()
    expect(md).toContain('# Anmerkungen – Grundriss EG')
    expect(md).toContain('Dokument: Grundriss EG.pdf')
    expect(md).toContain('Fassung: Fassung 3 von 5 · Stand vom 14.08.2026')
    expect(md).toContain('Projekt: Wohnhaus Lindengasse')
    // Nr. 3 came along from Fassung 2, so the open marks are those of every Fassung, and the entry says which.
    expect(md).toContain('Umfang: Offene Anmerkungen · alle Fassungen')
    expect(md).toContain('### Nr. 3 · Seite 1 · Hinweis · offen')
    expect(md).toContain('*auf Fassung 2 gesetzt*')
    // 12:30 UTC is 14:30 in the office.
    expect(md).toContain('Exportiert am: 13.10.2026, 14:30')
    expect(md).toContain('Exportiert von: Anna Berger')
  })

  it('writes one entry per mark: number, page, kind, status, the text, Zuständige, Termin and the thread', () => {
    const md = markdownOf()
    expect(md).toContain('### Nr. 4 · Seite 2 · Mangel · offen')
    expect(md).toContain('Lichte Breite der Fluchttür fehlt.')
    expect(md).toContain('**Zuständig:** Bernd Huber')
    expect(md).toContain('**Termin:** 20.10.2026')
    expect(md).toContain('- **Bernd Huber · 08.10.2026:** Wird im nächsten Stand korrigiert.')
    expect(md.indexOf('Nr. 1 ·')).toBeLessThan(md.indexOf('Nr. 4 ·'))
    expect(md.indexOf('Nr. 4 ·')).toBeLessThan(md.indexOf('Nr. 5 ·'))
  })

  it("names whom Piloti wrote a reply for, and who stands behind a mark Piloti set", () => {
    const md = markdownOf()
    expect(md).toContain('- **Piloti · für Anna Berger · 09.10.2026:** Erledigt: im Schnitt B-B mit 1,25 m kotiert.')
    expect(md).toContain('*von Piloti gesetzt · für Anna Berger · 07.10.2026*')
    expect(md).toContain('*Gesetzt von Anna Berger · 07.10.2026*')
  })

  it('leaves the proposals out by default, and puts them under their own heading when asked', () => {
    expect(markdownOf()).not.toContain('Geländer zu niedrig?')
    expect(markdownOf()).not.toContain('Vorschläge von Piloti, nicht geprüft')

    const md = markdownOf({ includeProposals: true })
    const heading = md.indexOf('## Vorschläge von Piloti, nicht geprüft')
    expect(heading).toBeGreaterThan(md.indexOf('Nr. 5 ·'))
    expect(md.indexOf('### Nr. 6 · Seite 1 · Hinweis · Vorschlag')).toBeGreaterThan(heading)
    expect(md).toContain('*Vorschlag von Piloti · für Anna Berger · 07.10.2026*')
    expect(md).toContain('Umfang: Offene Anmerkungen · alle Fassungen · mit Vorschlägen von Piloti')
  })

  it('names the Fassungen it covers as they are: the current one alone only while nothing earlier came along', () => {
    const currentOnly = ANNOTATIONS.filter((annotation) => annotation.onCurrentFassung)
    const cover = (annotations: AnnotationView[], options: Partial<AnnotationExportOptions>) => {
      const all = { ...OPTIONS, ...options }
      const scope = buildProtocol(HEADER, selectMarks(annotations, all), all, t, 'de').facts.find(
        (fact) => fact.label === 'Umfang'
      )
      return scope?.value
    }
    expect(cover(currentOnly, {})).toBe('Offene Anmerkungen · aktuelle Fassung')
    expect(cover(ANNOTATIONS, { scope: 'all' })).toBe(
      'Alle Anmerkungen, auch erledigte und verworfene · aktuelle Fassung, dazu Offenes aus früheren Fassungen'
    )
    expect(cover(ANNOTATIONS, { scope: 'all', fassung: 'all' })).toBe(
      'Alle Anmerkungen, auch erledigte und verworfene · alle Fassungen'
    )
  })

  it('says who closed a closed mark, and on which Fassung an earlier mark was set', () => {
    const md = markdownOf({ scope: 'all', fassung: 'all' })
    expect(md).toContain('### Nr. 2 · Seite 1 · Hinweis · erledigt')
    expect(md).toContain('*Erledigt von Bernd Huber · 09.10.2026*')
    expect(md).toContain('*auf Fassung 2 gesetzt*')
  })

  it('says so when nothing is in the selection', () => {
    const protocol = buildProtocol(HEADER, { marks: [], proposals: [] }, OPTIONS, t, 'de')
    expect(blocksToMarkdown(protocol.body)).toContain('Keine Anmerkungen in dieser Auswahl.')
  })

  it('keeps what a person typed as text, never as Markdown', () => {
    const md = blocksToMarkdown([{ kind: 'paragraph', runs: [{ text: '# Nicht *fett*\n- kein Punkt' }] }])
    expect(md).toBe('\\# Nicht \\*fett\\*  \n\\- kein Punkt\n')
  })
})

describe('protocolFileName', () => {
  it('names the document and the Fassung, as the office files it', () => {
    expect(protocolFileName(HEADER, { format: 'pdf', fassung: 'current' }, t)).toBe(
      'Anmerkungen – Grundriss EG – Fassung 3.pdf'
    )
    expect(protocolFileName(HEADER, { format: 'docx', fassung: 'all' }, t)).toBe(
      'Anmerkungen – Grundriss EG – alle Fassungen.docx'
    )
    expect(protocolFileName({ ...HEADER, fassung: null }, { format: 'md', fassung: 'current' }, t)).toBe(
      'Anmerkungen – Grundriss EG.md'
    )
  })
})

describe('exportAnnotationProtocol', () => {
  const doc = makeDocument({
    id: 'doc_1',
    filename: 'Grundriss EG.pdf',
    displayName: null,
    projectId: 'proj_1',
    publishedVersionId: 'ver_3',
  })
  const version = (id: string, versionNumber: number) =>
    ({ id, versionNumber, createdAt: new Date('2026-08-14T10:00:00.000Z') }) as DocumentVersion

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getAccessibleDocument).mockResolvedValue(doc)
    vi.mocked(listAnnotations).mockResolvedValue({ annotations: ANNOTATIONS, canAnnotate: true, pilotiWakes: false })
    vi.mocked(listDocumentVersions).mockResolvedValue([1, 2, 3, 4, 5].map((n) => version(`ver_${n}`, n)))
    vi.mocked(findProjectInOrg).mockResolvedValue(makeProject({ id: 'proj_1', name: 'Wohnhaus Lindengasse' }))
  })

  it('reads through the listing gate: the document for reading, and its marks as the listing shows them', async () => {
    await exportAnnotationProtocol(SESSION, 'doc_1', OPTIONS)
    expect(getAccessibleDocument).toHaveBeenCalledWith(SESSION, 'doc_1', 'read')
    expect(listAnnotations).toHaveBeenCalledWith(SESSION, 'doc_1')
  })

  it('is a 404 for a reader who may not read the document (a held upload, a restricted folder), and leaves no trail', async () => {
    vi.mocked(getAccessibleDocument).mockRejectedValue(new NotFoundError())
    await expect(exportAnnotationProtocol(SESSION, 'doc_1', OPTIONS)).rejects.toMatchObject({ status: 404 })
    expect(listAnnotations).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('writes Markdown, and audits the export by what it carried, never by a name', async () => {
    const file = await exportAnnotationProtocol(SESSION, 'doc_1', OPTIONS)
    expect(file.filename).toBe('Anmerkungen – Grundriss EG – Fassung 3.md')
    expect(file.mediaType).toBe('text/markdown; charset=utf-8')
    expect(new TextDecoder().decode(file.bytes)).toContain('Fassung 3 von 5 · Stand vom 14.08.2026')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'document.annotations.exported',
        targetType: 'document',
        targetId: 'doc_1',
        metadata: {
          format: 'md',
          scope: 'open',
          fassung: 'current',
          includeProposals: false,
          markCount: 4,
          proposalCount: 0,
        },
      })
    )
  })

  it('writes a Word document Word can open', async () => {
    const file = await exportAnnotationProtocol(SESSION, 'doc_1', { ...OPTIONS, format: 'docx' })
    expect(file.mediaType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    const xml = readZipEntries(file.bytes).get('word/document.xml') ?? ''
    expect(xml).toContain('Nr. 4 · Seite 2 · Mangel · offen')
    expect(xml).toContain('Piloti · für Anna Berger')
  })

  it('writes a PDF whose words survive layout', async () => {
    const file = await exportAnnotationProtocol(SESSION, 'doc_1', { ...OPTIONS, format: 'pdf' })
    expect(file.mediaType).toBe('application/pdf')
    const pdf = await readPdf(file.bytes)
    expect(pdf.text).toContain('Anmerkungen – Grundriss EG')
    expect(pdf.text).toContain('Nr. 4 · Seite 2 · Mangel · offen')
    expect(pdf.text).toContain('Fassung 3 von 5')
  })

  it('refuses a PDF too long to lay out, and points at the formats that have no such limit', async () => {
    const long = Array.from({ length: 300 }, (_, index) => mark({ number: index + 1, body: 'x'.repeat(2000) }))
    vi.mocked(listAnnotations).mockResolvedValue({ annotations: long, canAnnotate: true, pilotiWakes: false })
    await expect(exportAnnotationProtocol(SESSION, 'doc_1', { ...OPTIONS, format: 'pdf' })).rejects.toMatchObject({
      status: 422,
    })
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })
})
