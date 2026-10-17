/**
 * Fassungen und Freigabe, as the reader meets it: ONE section, a header that
 * says where the newest Fassung stands, and one numbered timeline under it.
 *
 * Pinned here: the header and the rows cannot contradict each other (the header
 * is about the newest Fassung and names the older one Piloti still answers from
 * by number); rows are „Fassung 3, 2, 1" across uploads and linked documents,
 * with the index as a tag and „aktuell" only on the Fassung Piloti answers
 * from; a plain upload claims no approval; the next step names a person, and
 * „ein Teammitglied" stands in only when the name is truly unknown; every fact
 * once; one visible action per row and the rest behind ⋯; Freigeben and
 * Änderungen anfordern visible and the other two decisions behind ⋯. Carried
 * over: a refusal cannot be sent without words, a lost race says so and
 * re-reads, the section opens itself when something is asked of the reader and
 * stays shut once they close it, the unlink is per row, a decision answered
 * after the rail moved on is dropped.
 *
 * The visibility of each control per state and permission is proved over the
 * transition table in `../lib/document-lifecycle.spec.ts`; the merge, numbering
 * and standing rules over plain data in `../lib/fassung-timeline.spec.ts` and
 * `../lib/fassung-standing.spec.ts`. Copy another worker owns is read from the
 * dictionary, so a wording change there does not break a behaviour pinned here.
 */

import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { act, render, screen, waitFor, within } from '@/test-utils'
import { toast } from 'sonner'
import { I18nProvider } from '@/i18n'
import { de } from '@/i18n/dictionaries/de'
import { EMPTY_FASSUNG, type FassungFacts, type FassungRef } from '@/lib/documents/fassung'
import { DocumentLifecycleError, type DocumentLifecycleClient } from '@/lib/documents/lifecycle-client'
import type {
  DocumentVersionListResponse,
  DocumentVersionState,
  DocumentVersionView,
} from '@/lib/documents/lifecycle-types'
import type { FileItem } from '../file-types'
import { requestFassungLink } from '../lib/fassung-request'
import { NotComparableError } from './fassung-compare/types'
import { DocumentFassungen, type DocumentFassungenProps } from './document-fassungen'

const compareOpened = vi.hoisted(() => vi.fn())

// The real comparison, with a spy on the pair it is opened with.
vi.mock('./fassung-compare', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fassung-compare')>()
  return {
    ...actual,
    useFassungCompare: (...args: Parameters<typeof actual.useFassungCompare>) => {
      const handle = actual.useFassungCompare(...args)
      return {
        ...handle,
        openFassungCompare: (...pair: Parameters<typeof handle.openFassungCompare>) => {
          compareOpened(...pair)
          handle.openFassungCompare(...pair)
        },
      }
    },
  }
})

vi.mock('../lib/fassung-request', () => ({
  requestFassungLink: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const copy = de.files
const fill = (template: string, params: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key]))

const fileFixture = (overrides: Partial<FileItem> = {}): FileItem => ({
  id: 'doc_1',
  filename: 'Grundriss_C.pdf',
  displayName: null,
  fileSize: 1024,
  contentType: 'application/pdf',
  status: 'completed',
  folderId: null,
  createdAt: '2026-08-14T00:00:00.000Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
  topics: null,
  capture: null,
  ...overrides,
})

const facts = (overrides: Partial<FassungFacts> = {}): FassungFacts => ({ ...EMPTY_FASSUNG, ...overrides })
const ref = (id: string, filename: string): FassungRef => ({ id, filename })
const answer = (newer: FassungFacts, older: FassungFacts = EMPTY_FASSUNG) => ({ newer, older })

function makeVersion(
  versionNumber: number,
  state: DocumentVersionState,
  overrides: Partial<DocumentVersionView> = {},
): DocumentVersionView {
  return {
    id: `ver_${versionNumber}`,
    documentId: 'doc_1',
    versionNumber,
    state,
    contentType: 'text/markdown',
    fileSize: 1200,
    contentHash: 'sha256:abc',
    submittedBy: null,
    submittedAt: null,
    reviewedBy: null,
    reviewedAt: null,
    approvedBy: null,
    approvedAt: null,
    publishedBy: null,
    publishedAt: null,
    reviewComment: null,
    createdBy: 'user_author',
    createdAt: `2026-09-0${versionNumber}T08:00:00.000Z`,
    updatedAt: `2026-09-0${versionNumber}T08:00:00.000Z`,
    ...overrides,
  }
}

/** A version that went through review: submitted, so its acts are acts. */
const reviewed = (versionNumber: number, state: DocumentVersionState, overrides: Partial<DocumentVersionView> = {}) =>
  makeVersion(versionNumber, state, {
    submittedBy: 'user_author',
    submittedAt: `2026-09-0${versionNumber}T09:00:00.000Z`,
    ...overrides,
  })

/** What the listing resolves for the people who acted. */
const PEOPLE = [
  { userId: 'user_author', name: 'Anna Berger' },
  { userId: 'user_sabine', name: 'Sabine Gruber' },
  { userId: 'user_markus', name: 'Markus Feld' },
  { userId: 'user_clara', name: 'Clara Schmid' },
]

function listing(
  versions: readonly DocumentVersionView[],
  overrides: Partial<DocumentVersionListResponse> = {},
): DocumentVersionListResponse {
  return {
    documentId: 'doc_1',
    lifecycle: 'active',
    publishedVersionId: versions.find((v) => v.state === 'published')?.id ?? null,
    versions: [...versions],
    people: PEOPLE,
    ...overrides,
  }
}

/** A client double: every method present, only the ones a test needs behaving. */
function fakeClient(overrides: Partial<DocumentLifecycleClient> = {}): DocumentLifecycleClient {
  const unexpected = () => Promise.reject(new Error('not stubbed'))
  return {
    listVersions: unexpected,
    getVersion: unexpected,
    forkDraft: unexpected,
    replaceContent: unexpected,
    submit: unexpected,
    approve: unexpected,
    requestChanges: unexpected,
    reject: unexpected,
    publish: unexpected,
    archive: unexpected,
    diff: unexpected,
    ...overrides,
  } as DocumentLifecycleClient
}

const clientOf = (
  versions: readonly DocumentVersionView[],
  overrides: Partial<DocumentLifecycleClient> = {},
  listed: Partial<DocumentVersionListResponse> = {},
) => fakeClient({ listVersions: () => Promise.resolve(listing(versions, listed)), ...overrides })

const reviewer = { permissions: ['project:view', 'project:edit'] as const, userId: 'user_reviewer' }
const viewOnly = { permissions: ['project:view'] as const, userId: 'user_x' }

/** The section under the German dictionary, the way sibling specs render a locale. */
const section = (props: Partial<DocumentFassungenProps> & { file?: FileItem }): ReactElement => (
  <I18nProvider initialLocale="de" fixedLocale>
    <DocumentFassungen file={props.file ?? fileFixture()} canManage={false} {...props} />
  </I18nProvider>
)

const renderSection = (props: Parameters<typeof section>[0] = {}) => render(section(props))

const toggle = () => screen.findByTestId('document-fassungen-toggle')

/**
 * Render and open the section. It is shut at rest unless something is asked of
 * the reader, and a shut body is not in the DOM; a test about the body opens it.
 */
async function renderOpen(props: Parameters<typeof section>[0] = {}) {
  const result = render(section(props))
  const trigger = await toggle()
  if (trigger.getAttribute('aria-expanded') !== 'true') await userEvent.click(trigger)
  return result
}

/** Open a row's ⋯ and return the menu's items by test id (the menu is a portal). */
async function openRowMenu(row: HTMLElement) {
  await userEvent.click(within(row).getByTestId('fassung-row-menu'))
  return screen.findByRole('menu')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.mocked(requestFassungLink).mockReset()
  vi.mocked(toast.error).mockClear()
})

describe('DocumentFassungen — the header says where the newest Fassung stands', () => {
  it('gives a plain upload no state word and no track: nobody approved it, Piloti answers from it', async () => {
    renderSection({
      viewer: reviewer,
      // As the server stores an upload: the uploader stands in as approver and publisher.
      client: clientOf([makeVersion(1, 'published', { approvedBy: 'user_author', publishedBy: 'user_author' })]),
    })

    expect(await screen.findByTestId('fassung-header-label')).toHaveTextContent('Fassung 1')
    expect(screen.queryByTestId('document-lifecycle-state')).toBeNull()
    expect(screen.queryByTestId('document-lifecycle-track')).toBeNull()
    expect(screen.getByTestId('fassung-answer')).toHaveTextContent('Piloti antwortet aus dieser Fassung.')
    // Who and when, once, in words: never „Freigegeben" or „Veröffentlicht" for an upload.
    const act = screen.getByTestId('fassung-header-act')
    expect(act).toHaveTextContent('Hochgeladen von Anna Berger · 01.09.2026')
    expect(screen.getByTestId('document-fassungen')).not.toHaveTextContent('Veröffentlicht')
  })

  it('gives a Fassung that went through review its state and the four stages, named, the current one in ink', async () => {
    renderSection({
      viewer: reviewer,
      client: clientOf([reviewed(1, 'published', { approvedBy: 'user_markus', publishedBy: 'user_markus' })]),
    })

    expect(await screen.findByTestId('document-lifecycle-state')).toHaveTextContent('Veröffentlicht')
    const track = screen.getByTestId('document-lifecycle-track')
    expect([...track.querySelectorAll('[data-stage-label]')].map((label) => label.textContent)).toEqual([
      'Entwurf',
      'In Prüfung',
      'Freigegeben',
      'Veröffentlicht',
    ])
    expect(track.querySelector('[data-current]')).toHaveTextContent('Veröffentlicht')
    expect(screen.getByTestId('document-lifecycle-stand')).toHaveTextContent('Schritt 4 von 4: Veröffentlicht')
  })

  it('describes the newest Fassung and names the older one Piloti still answers from, so header and rows agree', async () => {
    await renderOpen({
      viewer: viewOnly,
      client: clientOf([
        reviewed(1, 'published', { approvedBy: 'user_markus', publishedBy: 'user_markus' }),
        reviewed(2, 'in_review'),
      ]),
    })

    const header = await screen.findByTestId('fassung-header')
    expect(within(header).getByTestId('fassung-header-label')).toHaveTextContent('Fassung 2')
    expect(within(header).getByTestId('document-lifecycle-state')).toHaveTextContent('In Prüfung')
    expect(within(header).getByTestId('fassung-answer')).toHaveTextContent('Piloti antwortet weiter aus Fassung 1.')
    expect(header).not.toHaveTextContent('aktuell')

    const rows = screen.getAllByTestId('fassung-timeline-row')
    expect(within(rows[0]).getByTestId('fassung-row-label')).toHaveTextContent('Fassung 2')
    expect(within(rows[0]).queryByTestId('fassung-row-current')).toBeNull()
    expect(within(rows[1]).getByTestId('fassung-row-label')).toHaveTextContent('Fassung 1')
    expect(within(rows[1]).getByTestId('fassung-row-current')).toHaveTextContent('aktuell')
    // The state is the header's; the newest row does not say it again.
    expect(rows[0]).not.toHaveTextContent('In Prüfung')
    expect(screen.getByTestId('document-fassungen')).not.toHaveTextContent('Diese Fassung')
  })

  it('keeps naming the previous upload while a re-upload is still being read, and marks that one current', async () => {
    const upload = { approvedBy: 'user_author', publishedBy: 'user_author' }
    await renderOpen({
      viewer: viewOnly,
      file: fileFixture({ status: 'processing', authoredBy: 'user' }),
      client: clientOf([makeVersion(1, 'superseded', upload), makeVersion(2, 'published', upload)]),
    })

    const header = await screen.findByTestId('fassung-header')
    expect(within(header).getByTestId('fassung-answer')).toHaveTextContent('Piloti antwortet weiter aus Fassung 1.')
    const rows = screen.getAllByTestId('fassung-timeline-row')
    expect(within(rows[0]).queryByTestId('fassung-row-current')).toBeNull()
    expect(within(rows[1]).getByTestId('fassung-row-current')).toHaveTextContent('aktuell')
  })

  it('says a first upload answers once it has been read', async () => {
    renderSection({
      viewer: viewOnly,
      file: fileFixture({ status: 'processing' }),
      client: clientOf([makeVersion(1, 'published', { approvedBy: 'user_author', publishedBy: 'user_author' })]),
    })

    expect(await screen.findByTestId('fassung-answer')).toHaveTextContent('Piloti antwortet daraus, sobald sie gelesen ist.')
  })

  it('does not point at a published Fassung when there is none', async () => {
    renderSection({ viewer: viewOnly, client: clientOf([reviewed(1, 'in_review')]) })

    const answerLine = await screen.findByTestId('fassung-answer')
    expect(answerLine).toHaveTextContent('Piloti antwortet erst daraus, wenn sie freigegeben ist.')
    expect(answerLine).not.toHaveTextContent('Fassung 1')
  })

  it('calls a replaced Fassung „Ersetzt", without a green track, and puts the newer one on top', async () => {
    const user = userEvent.setup()
    const onOpenDocument = vi.fn()
    renderSection({
      file: fileFixture({ fassung: facts({ supersededBy: ref('doc_2', 'EG_Index_D_2026-09-30.pdf') }) }),
      viewer: reviewer,
      client: clientOf([reviewed(1, 'published', { approvedBy: 'user_markus', publishedBy: 'user_markus' })]),
      onOpenDocument,
    })

    expect(await screen.findByTestId('document-lifecycle-state')).toHaveTextContent('Ersetzt')
    expect(screen.queryByTestId('document-lifecycle-track')).toBeNull()
    expect(screen.getByTestId('fassung-answer')).toHaveTextContent('Piloti antwortet aus der neueren Fassung 2')

    const rows = await screen.findAllByTestId('fassung-timeline-row')
    expect(rows[0]).toHaveAttribute('data-kind', 'newer')
    expect(within(rows[0]).getByTestId('fassung-row-label')).toHaveTextContent('Fassung 2')
    expect(within(rows[0]).getByTestId('fassung-row-tag')).toHaveTextContent('Index D')
    expect(within(rows[0]).getByTestId('fassung-row-current')).toHaveTextContent('aktuell')
    expect(within(rows[1]).queryByTestId('fassung-row-current')).toBeNull()

    await user.click(within(rows[0]).getByRole('button', { name: 'Öffnen' }))
    expect(onOpenDocument).toHaveBeenCalledWith('doc_2')
  })

  it('says a retired document is retired', async () => {
    renderSection({ viewer: reviewer, client: clientOf([reviewed(1, 'published')], {}, { lifecycle: 'archived' }) })

    expect(await screen.findByTestId('document-lifecycle-state')).toHaveTextContent('Stillgelegt')
    expect(screen.getByTestId('fassung-answer')).toHaveTextContent(copy.lifecycle.meaning.archived)
  })
})

describe('DocumentFassungen — the next step names a person', () => {
  it('names the people the round was sent to', async () => {
    renderSection({
      viewer: reviewer,
      client: clientOf([reviewed(1, 'in_review')], {}, { reviewerUserIds: ['user_sabine'] }),
    })

    expect(await screen.findByTestId('fassung-next-step')).toHaveTextContent('Nächster Schritt: Freigabe durch Sabine Gruber')
  })

  it('names two reviewers with „oder", and more as a count', async () => {
    const { unmount } = renderSection({
      viewer: reviewer,
      client: clientOf([reviewed(1, 'in_review')], {}, { reviewerUserIds: ['user_sabine', 'user_markus'] }),
    })
    expect(await screen.findByTestId('fassung-next-step')).toHaveTextContent('Freigabe durch Sabine Gruber oder Markus Feld')
    unmount()

    renderSection({
      viewer: reviewer,
      client: clientOf([reviewed(1, 'in_review')], {}, { reviewerUserIds: ['user_sabine', 'user_markus', 'user_clara'] }),
    })
    expect(await screen.findByTestId('fassung-next-step')).toHaveTextContent('Freigabe durch Sabine Gruber oder 2 weitere')
  })

  it('says it is the reader’s own approval when the round was sent to them', async () => {
    renderSection({
      viewer: reviewer,
      client: clientOf([reviewed(1, 'in_review')], {}, { reviewerUserIds: ['user_reviewer'] }),
    })

    expect(await screen.findByTestId('fassung-next-step')).toHaveTextContent('Nächster Schritt: Ihre Freigabe')
  })

  it('sends changes back to whoever submitted, by name', async () => {
    renderSection({
      viewer: viewOnly,
      client: clientOf([reviewed(1, 'published'), reviewed(2, 'changes_requested', { reviewedBy: 'user_clara' })]),
    })

    expect(await screen.findByTestId('fassung-next-step')).toHaveTextContent(
      'Nächster Schritt: Überarbeitung durch Anna Berger',
    )
  })

  it('takes names from the assignees and the reviewer candidates too', async () => {
    renderSection({
      viewer: viewOnly,
      names: { user_lena: 'Lena Wolf' },
      client: clientOf([reviewed(1, 'in_review', { submittedBy: 'user_lena' })], {}, { people: [], reviewerUserIds: [] }),
    })
    await userEvent.click(await toggle())

    expect(await screen.findByTestId('fassung-timeline-row')).toHaveTextContent('Eingereicht von Lena Wolf')
  })

  it('says „ein Teammitglied" only when the name is truly unknown, and never „jemand"', async () => {
    await renderOpen({
      viewer: viewOnly,
      client: clientOf([reviewed(1, 'in_review', { submittedBy: 'user_ghost' })], {}, { reviewerUserIds: ['user_phantom'] }),
    })

    expect(screen.getByTestId('fassung-next-step')).toHaveTextContent('Nächster Schritt: Freigabe durch ein Teammitglied')
    expect(screen.getByTestId('fassung-timeline-row')).toHaveTextContent('Eingereicht von einem Teammitglied')
    const all = screen.getByTestId('document-fassungen')
    expect(all).not.toHaveTextContent(/jemand/i)
    expect(all).not.toHaveTextContent('user_')
  })
})

describe('DocumentFassungen — shut at rest, open when it is the reader’s turn', () => {
  it('stays shut on a plain upload', async () => {
    renderSection({ viewer: reviewer, client: clientOf([makeVersion(1, 'published')]) })

    expect(await toggle()).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens itself on a version that wants a decision from this reader', async () => {
    renderSection({ viewer: reviewer, client: clientOf([reviewed(1, 'in_review')]) })

    await waitFor(async () => expect(await toggle()).toHaveAttribute('aria-expanded', 'true'))
    expect(await screen.findByRole('button', { name: 'Freigeben' })).toBeInTheDocument()
  })

  it('names what is still open on the pages in the approve confirm, with the way into the review', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    renderSection({ viewer: reviewer, client: clientOf([reviewed(1, 'in_review')]), openMarks: { status: 'counted', count: 4, onOpen } })

    await user.click(await screen.findByRole('button', { name: 'Freigeben' }))
    expect(screen.getByTestId('document-review-approve-open-marks')).toHaveTextContent(
      '4 offene Anmerkungen – trotzdem freigeben?'
    )
    await user.click(screen.getByRole('button', { name: 'In der Prüfansicht öffnen' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('stays shut for a reader nothing is expected of, and still says what it waits for', async () => {
    renderSection({ viewer: viewOnly, client: clientOf([reviewed(1, 'in_review')]) })

    expect(await toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('document-lifecycle-state')).toHaveTextContent('In Prüfung')
    expect(screen.getByTestId('fassung-next-step')).toHaveTextContent('Nächster Schritt: Freigabe')
  })

  it('stays closed once the reader has closed it, however often the round re-renders', async () => {
    const user = userEvent.setup()
    const { rerender } = renderSection({ viewer: reviewer, client: clientOf([reviewed(1, 'in_review')]) })
    await waitFor(async () => expect(await toggle()).toHaveAttribute('aria-expanded', 'true'))

    await user.click(await toggle())
    expect(await toggle()).toHaveAttribute('aria-expanded', 'false')

    rerender(section({ viewer: reviewer, client: clientOf([reviewed(1, 'in_review')]) }))
    expect(await toggle()).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens itself for Piloti’s suggestion, which is waiting for an answer', async () => {
    renderSection({
      file: fileFixture({
        fassung: facts({ suggestion: { of: ref('doc_0', 'Grundriss_B.pdf'), confidence: 0.9, reason: '', basis: 'name' } }),
      }),
      canManage: true,
    })

    expect(await toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('fassung-suggestion')).toBeInTheDocument()
  })

  it('opens itself on an older Fassung, so the newer one is the first row read', async () => {
    renderSection({ file: fileFixture({ fassung: facts({ supersededBy: ref('doc_2', 'Grundriss_D.pdf') }) }) })

    expect(await toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByTestId('fassung-timeline-row')[0]).toHaveAttribute('data-kind', 'newer')
  })
})

describe('DocumentFassungen — controls only where the surface resolved permissions', () => {
  it('draws no section at all for a plain upload on a surface without permissions', () => {
    const { container } = renderSection({})

    expect(container).toBeEmptyDOMElement()
  })

  it('shows the timeline and the suggestion, and no review controls, without a viewer', async () => {
    const client = clientOf([makeVersion(1, 'superseded'), reviewed(2, 'in_review')])
    renderSection({
      file: fileFixture({
        versionCount: 2,
        fassung: facts({
          supersedes: [ref('doc_0', 'Grundriss_B.pdf')],
          history: [{ id: 'doc_0', filename: 'Grundriss_B.pdf', createdAt: '2026-07-01T00:00:00.000Z', changeSummary: null }],
          suggestion: { of: ref('doc_9', 'Grundriss_A.pdf'), confidence: 0.8, reason: '', basis: 'name' },
        }),
      }),
      client,
    })

    await waitFor(() => expect(screen.getAllByTestId('fassung-timeline-row')).toHaveLength(3))
    expect(screen.getByTestId('fassung-suggestion')).toBeInTheDocument()
    expect(screen.queryByTestId('document-review-controls')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Freigeben' })).toBeNull()
    expect(screen.queryByTestId('document-lifecycle-archive')).toBeNull()
  })

  it('does not read the versions of a single-upload document without a viewer', () => {
    const listVersions = vi.fn()
    renderSection({
      file: fileFixture({ fassung: facts({ supersededBy: ref('doc_2', 'Grundriss_D.pdf') }) }),
      client: fakeClient({ listVersions }),
    })

    expect(listVersions).not.toHaveBeenCalled()
  })

  it('offers no decision to a reader who only holds project:view', async () => {
    renderSection({ viewer: viewOnly, client: clientOf([reviewed(1, 'in_review')]) })

    await screen.findByTestId('document-lifecycle-state')
    expect(screen.queryByTestId('document-review-controls')).toBeNull()
    expect(screen.queryByTestId('fassung-approve-explain')).toBeNull()
  })
})

describe('DocumentFassungen — one numbered timeline', () => {
  const history = [
    { id: 'doc_b', filename: 'EG_Index_B_2026-07-02.pdf', createdAt: '2026-07-02T09:00:00Z', changeSummary: '- Stiege verschoben' },
    { id: 'doc_a', filename: 'EG_Index_A_2026-06-01.pdf', createdAt: '2026-06-01T09:00:00Z', changeSummary: null },
  ]
  const linked = facts({ supersedes: [ref('doc_b', history[0].filename)], history })

  it('lists uploads and linked documents interleaved by date and numbers them Fassung 4, 3, 2, 1', async () => {
    await renderOpen({
      file: fileFixture({ filename: 'EG_Index_C_2026-08-01.pdf', versionCount: 2, fassung: linked }),
      viewer: reviewer,
      client: clientOf([
        makeVersion(1, 'superseded', { createdAt: '2026-06-20T08:00:00.000Z' }),
        makeVersion(2, 'published', { createdAt: '2026-08-01T08:00:00.000Z' }),
      ]),
    })

    const rows = await screen.findAllByTestId('fassung-timeline-row')
    expect(rows.map((row) => [row.dataset.version ?? row.dataset.id, row.textContent?.match(/Fassung \d/)?.[0]])).toEqual([
      ['2', 'Fassung 4'],
      ['doc_b', 'Fassung 3'],
      ['1', 'Fassung 2'],
      ['doc_a', 'Fassung 1'],
    ])
    expect(screen.getByTestId('fassung-header-label')).toHaveTextContent('Fassung 4')
  })

  it('compares with the previous Fassung in one tap from its row, not only from its ⋯', async () => {
    compareOpened.mockClear()
    await renderOpen({ file: fileFixture({ filename: 'EG_Index_C_2026-08-14.pdf', fassung: linked }), canManage: true })
    const rows = await screen.findAllByTestId('fassung-timeline-row')
    // Only the Fassung directly before this one carries it.
    expect(screen.getAllByTestId('fassung-compare-previous')).toHaveLength(1)
    await userEvent.click(within(rows[1]).getByTestId('fassung-compare-previous'))
    expect(compareOpened).toHaveBeenCalledTimes(1)
    expect(compareOpened.mock.calls[0]?.[1]).toMatchObject({ filename: 'EG_Index_C_2026-08-14.pdf' })
  })

  it('tags rows with their index, says „aktuell" only on the one Piloti answers from, and never „Ersetzt"', async () => {
    await renderOpen({ file: fileFixture({ filename: 'EG_Index_C_2026-08-14.pdf', fassung: linked }), canManage: true })

    const rows = await screen.findAllByTestId('fassung-timeline-row')
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByTestId('fassung-row-tag')).toHaveTextContent('Index C')
    expect(within(rows[0]).getByTestId('fassung-row-current')).toHaveTextContent('aktuell')
    expect(within(rows[1]).getByTestId('fassung-row-tag')).toHaveTextContent('Index B')
    expect(rows[1]).toHaveTextContent('Stiege verschoben')
    expect(within(rows[2]).getByTestId('fassung-row-tag')).toHaveTextContent('Index A')
    expect(screen.getAllByTestId('fassung-row-current')).toHaveLength(1)
    expect(screen.getByTestId('fassung-timeline')).not.toHaveTextContent('Ersetzt')
  })

  it('prefers the index the title block printed to the one in the name', async () => {
    await renderOpen({
      file: { ...fileFixture({ filename: 'scan_0042.pdf', fassung: linked }), revisionFacts: { revision: 'C' } } as FileItem,
    })

    expect(within((await screen.findAllByTestId('fassung-timeline-row'))[0]).getByTestId('fassung-row-tag')).toHaveTextContent(
      'Index C',
    )
  })

  it('cuts a long file name in the middle, so its index and extension survive', async () => {
    const long = 'Wohnanlage-Schlosspark_Bauteil-B_Grundriss_1OG_Einreichung_Index-C_2026-06-30.pdf'
    await renderOpen({
      file: fileFixture({
        fassung: facts({ history: [{ id: 'doc_l', filename: long, createdAt: '2026-06-30T08:00:00Z', changeSummary: null }] }),
      }),
    })

    const row = (await screen.findAllByTestId('fassung-timeline-row'))[1]
    const name = within(row).getByTitle(long)
    // The tail is kept whole while there is room; the head ellipsizes first.
    expect(name.lastElementChild).toHaveTextContent('Index-C_2026-06-30.pdf')
    expect(name.lastElementChild).toHaveAttribute('data-part', 'tail')
  })

  it('says each date once, on the act line, with the person', async () => {
    await renderOpen({
      file: fileFixture({ versionCount: 2 }),
      viewer: reviewer,
      client: clientOf([makeVersion(1, 'superseded', { createdBy: 'user_reviewer' }), makeVersion(2, 'published')]),
    })

    const rows = await screen.findAllByTestId('fassung-timeline-row')
    expect(rows[0]).toHaveTextContent('Hochgeladen von Anna Berger · 02.09.2026')
    expect(rows[0].textContent?.match(/02\.09\.2026/g)).toHaveLength(1)
    expect(rows[1]).toHaveTextContent('Hochgeladen von Ihnen · 01.09.2026')
    expect(screen.getByTestId('fassung-timeline')).not.toHaveTextContent('user_')
  })

  it('names the reviewer’s words and every act on the newest, the refusal included', async () => {
    await renderOpen({
      viewer: reviewer,
      client: clientOf([
        reviewed(1, 'published'),
        reviewed(2, 'changes_requested', {
          submittedAt: '2026-09-02T09:00:00.000Z',
          reviewedBy: 'user_clara',
          reviewedAt: '2026-09-03T10:00:00.000Z',
          reviewComment: 'Bitte die Fluchtweglänge ergänzen.',
        }),
      ]),
    })

    const rows = await screen.findAllByTestId('fassung-timeline-row')
    expect(rows[0]).toHaveTextContent('Eingereicht von Anna Berger · 02.09.2026')
    expect(rows[0]).toHaveTextContent(`${copy.lifecycle.versions.changesRequested} von Clara Schmid · 03.09.2026`)
    expect(within(rows[0]).getByTestId('document-version-comment')).toHaveTextContent('Bitte die Fluchtweglänge ergänzen.')
  })

  it('never reads an approval as a refusal', async () => {
    await renderOpen({
      viewer: reviewer,
      client: clientOf([
        makeVersion(1, 'superseded'),
        reviewed(2, 'approved', {
          reviewedBy: 'user_clara',
          reviewedAt: '2026-09-03T10:00:00.000Z',
          approvedBy: 'user_clara',
          approvedAt: '2026-09-03T10:00:00.000Z',
        }),
      ]),
    })

    const rows = await screen.findAllByTestId('fassung-timeline-row')
    expect(rows[0]).toHaveTextContent('Freigegeben von Clara Schmid')
    expect(rows[0]).not.toHaveTextContent(copy.lifecycle.versions.changesRequested)
    expect(rows[0]).not.toHaveTextContent('Abgelehnt von')
  })

  it('shows a lone upload as no timeline: the header already says all of it', async () => {
    await renderOpen({ viewer: reviewer, client: clientOf([makeVersion(1, 'published')]) })

    await screen.findByTestId('fassung-header')
    expect(screen.queryByTestId('fassung-timeline')).toBeNull()
  })

  it('shows the reviewer’s words on a lone version they are about', async () => {
    await renderOpen({
      viewer: reviewer,
      client: clientOf([reviewed(1, 'rejected', { reviewComment: 'Außerhalb des Auftrags.' })]),
    })

    expect(await screen.findByTestId('document-version-comment')).toHaveTextContent('Außerhalb des Auftrags.')
  })

  it('says what changed against the Fassung it replaced, by number, with Piloti’s caveat attached once', async () => {
    await renderOpen({
      file: fileFixture({
        fassung: facts({
          supersedes: [ref('doc_b', history[0].filename)],
          history,
          changeSummary: { text: '- Dachhöhe: 12 m → 14 m\n• Fenster: Typ A → Typ B\n\n2) Attika neu', basis: 'previous' },
        }),
      }),
    })

    const [change] = await screen.findAllByTestId('fassung-change')
    expect(change).toHaveTextContent('Geändert gegenüber Fassung 2:')
    expect(within(change).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Dachhöhe: 12 m → 14 m',
      'Fenster: Typ A → Typ B',
      'Attika neu',
    ])
    expect(screen.getAllByTestId('fassung-change-hint')).toHaveLength(1)
    expect(within(change).getByTestId('fassung-change-hint')).toHaveTextContent(copy.preview.fassung.changeHint)
  })

  it('names the basis by its file when it is not in the timeline', async () => {
    await renderOpen({
      file: fileFixture({ fassung: facts({ changeSummary: { text: '- Attika neu', basis: ref('doc_0', 'Grundriss_A.pdf') } }) }),
    })

    expect(await screen.findByTestId('fassung-change')).toHaveTextContent(
      fill(copy.preview.fassung.changedSince, { name: 'Grundriss_A.pdf' }),
    )
  })
})

describe('DocumentFassungen — one visible action per row, the rest behind ⋯', () => {
  it('shows Öffnen on an earlier upload and keeps Herunterladen behind its ⋯; the current one has no Öffnen', async () => {
    await renderOpen({
      file: fileFixture({ versionCount: 2 }),
      viewer: reviewer,
      client: clientOf([makeVersion(1, 'superseded'), makeVersion(2, 'published')]),
    })

    const rows = await screen.findAllByTestId('fassung-timeline-row')
    expect(within(rows[0]).queryByTestId('fassung-version-open')).toBeNull()
    expect(within(rows[1]).getByTestId('fassung-version-open')).toHaveAttribute('href', '/api/documents/doc_1/versions/ver_1/file')
    expect(screen.queryByTestId('fassung-version-download')).toBeNull()

    await openRowMenu(rows[1])
    expect(await screen.findByTestId('fassung-version-download')).toHaveAttribute(
      'href',
      '/api/documents/doc_1/versions/ver_1/file?download=1',
    )
  })

  it('offers neither Öffnen, Herunterladen nor a comparison of an earlier upload this reader may not receive (ADR-0086)', async () => {
    await renderOpen({
      file: fileFixture({ versionCount: 2 }),
      viewer: reviewer,
      client: clientOf([makeVersion(1, 'superseded', { bytesReadable: false }), makeVersion(2, 'published')]),
    })

    const rows = await screen.findAllByTestId('fassung-timeline-row')
    expect(rows).toHaveLength(2)
    expect(screen.queryByTestId('fassung-version-open')).toBeNull()
    for (const row of rows) {
      if (!within(row).queryByTestId('fassung-row-menu')) continue
      await openRowMenu(row)
      expect(screen.queryByTestId('fassung-version-download')).toBeNull()
      expect(screen.queryByTestId('document-version-compare')).toBeNull()
      await userEvent.keyboard('{Escape}')
    }
  })

  it('shows a member Öffnen on the screened earlier upload and not on the one no verdict passed (migration 0131)', async () => {
    await renderOpen({
      file: fileFixture({ versionCount: 3 }),
      viewer: viewOnly,
      client: clientOf([
        makeVersion(1, 'superseded', { bytesReadable: true }),
        makeVersion(2, 'superseded', { bytesReadable: false }),
        makeVersion(3, 'published', { bytesReadable: true }),
      ]),
    })

    const rows = await screen.findAllByTestId('fassung-timeline-row')
    expect(rows).toHaveLength(3)
    // Newest first: the current upload, the unread one, the screened first upload.
    expect(within(rows[1]).queryByTestId('fassung-version-open')).toBeNull()
    expect(within(rows[2]).getByTestId('fassung-version-open')).toHaveAttribute('href', '/api/documents/doc_1/versions/ver_1/file')
    await openRowMenu(rows[2])
    expect(await screen.findByTestId('fassung-version-download')).toHaveAttribute(
      'href',
      '/api/documents/doc_1/versions/ver_1/file?download=1',
    )
  })

  it('opens a version that was never published as text, and offers no download of it', async () => {
    await renderOpen({ viewer: reviewer, client: clientOf([makeVersion(1, 'published'), reviewed(2, 'draft')]) })

    const rows = await screen.findAllByTestId('fassung-timeline-row')
    expect(within(rows[0]).getByTestId('fassung-version-open')).toHaveAttribute('href', '/api/documents/doc_1/versions/ver_2/content')
    await openRowMenu(rows[0])
    expect(screen.queryByTestId('fassung-version-download')).toBeNull()
    expect(screen.getByTestId('document-version-compare')).toBeInTheDocument()
  })

  it('compares the text with the one before, from the ⋯, and numbers both as the timeline does', async () => {
    const diff = vi.fn().mockResolvedValue({
      from: { version: makeVersion(1, 'superseded'), content: 'alte Fassung' },
      to: { version: makeVersion(2, 'published'), content: 'neue Fassung' },
    })
    const history = [{ id: 'doc_a', filename: 'EG_Index_A.pdf', createdAt: '2026-06-01T09:00:00Z', changeSummary: null }]
    await renderOpen({
      file: fileFixture({ versionCount: 2, fassung: facts({ history }) }),
      viewer: reviewer,
      client: clientOf([makeVersion(1, 'superseded'), makeVersion(2, 'published')], { diff }),
    })

    const rows = await screen.findAllByTestId('fassung-timeline-row')
    await openRowMenu(rows[0])
    const compare = await screen.findByTestId('document-version-compare')
    // Fassung 2 in the timeline, because the linked Index A is Fassung 1.
    expect(compare).toHaveTextContent(fill(copy.preview.fassung.versions.compareText, { number: 2 }))
    await userEvent.click(compare)

    await waitFor(() => expect(diff).toHaveBeenCalledWith('doc_1', 'ver_1', 'ver_2'))
    const comparison = await within(rows[0]).findByTestId('document-version-comparison')
    expect(comparison).toHaveTextContent('Fassung 2 → Fassung 3')
    expect(comparison).toHaveTextContent('1 Zeile hinzugefügt')
    expect(
      within(comparison).getAllByTestId('document-version-diff-row').map((row) => row.getAttribute('data-kind')),
    ).toEqual(['removed', 'added'])
  })

  it('compares every upload with its TRUE predecessor, at any depth, and the oldest has none', async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      makeVersion(index + 1, index === 59 ? 'published' : 'superseded', {
        createdAt: new Date(Date.UTC(2025, 0, 1 + index)).toISOString(),
      }),
    )
    const diff = vi.fn().mockRejectedValue(new Error('nope'))
    await renderOpen({ file: fileFixture({ versionCount: 60 }), viewer: reviewer, client: clientOf(many, { diff }) })

    const rows = await screen.findAllByTestId('fassung-timeline-row')
    expect(rows).toHaveLength(60)
    expect(rows[0]).toHaveAttribute('data-version', '60')
    expect(rows[59]).toHaveAttribute('data-version', '1')
    await openRowMenu(rows[0])
    await userEvent.click(await screen.findByTestId('document-version-compare'))
    expect(diff).toHaveBeenCalledWith('doc_1', 'ver_59', 'ver_60')
    // A failed comparison is a line under its row; the timeline stays.
    expect(await within(rows[0]).findByTestId('document-version-compare-failed')).toBeInTheDocument()
    expect(screen.getAllByTestId('fassung-timeline-row')).toHaveLength(60)
    await openRowMenu(rows[59])
    expect(screen.queryByTestId('document-version-compare')).toBeNull()
  })

  it('opens a linked document from its row', async () => {
    const user = userEvent.setup()
    const onOpenDocument = vi.fn()
    const history = [{ id: 'doc_a', filename: 'EG_Index_A_2026-06-01.pdf', createdAt: '2026-06-01T09:00:00Z', changeSummary: null }]
    await renderOpen({
      file: fileFixture({ fassung: facts({ supersedes: [ref('doc_a', history[0].filename)], history }) }),
      onOpenDocument,
    })

    const rows = await screen.findAllByTestId('fassung-timeline-row')
    await user.click(within(rows[1]).getByRole('button', { name: 'Öffnen' }))
    expect(onOpenDocument).toHaveBeenCalledWith('doc_a')
  })

  it('opens the visual comparison with exactly that row’s document as the older Fassung and this one as the newer', async () => {
    const user = userEvent.setup()
    compareOpened.mockClear()
    const history = [
      { id: 'doc_b', filename: 'EG_Index_B_2026-07-02.pdf', createdAt: '2026-07-02T09:00:00Z', changeSummary: null },
      { id: 'doc_a', filename: 'EG_Index_A_2026-06-01.pdf', createdAt: '2026-06-01T09:00:00Z', changeSummary: null },
    ]
    await renderOpen({
      file: fileFixture({ filename: 'EG_Index_C_2026-08-14.pdf', fassung: facts({ supersedes: [ref('doc_b', history[0].filename)], history }) }),
      // Pages that never arrive: the sheet opens and says it is loading.
      compareSource: () => new Promise(() => undefined),
    })

    const rows = await screen.findAllByTestId('fassung-timeline-row')
    await openRowMenu(rows[2])
    await user.click(await screen.findByRole('menuitem', { name: 'Vergleichen' }))

    expect(compareOpened).toHaveBeenCalledTimes(1)
    expect(compareOpened).toHaveBeenCalledWith(
      { id: 'doc_a', filename: 'EG_Index_A_2026-06-01.pdf' },
      { id: 'doc_1', filename: 'EG_Index_C_2026-08-14.pdf' },
    )
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('turns two Fassungen that cannot be laid over each other into a text comparison under their row', async () => {
    const user = userEvent.setup()
    const texts: Record<string, string> = { doc_a: 'Fluchtweg 40 m', doc_1: 'Fluchtweg 35 m' }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const id = String(input).match(/documents\/([^/]+)\/text/)?.[1] ?? ''
      return new Response(JSON.stringify({ text: texts[id], truncated: false }), { status: 200 })
    })
    const history = [{ id: 'doc_a', filename: 'Brandschutz_Index_A.md', createdAt: '2026-06-01T09:00:00Z', changeSummary: null }]
    try {
      await renderOpen({
        file: fileFixture({ filename: 'Brandschutz_Index_B.md', fassung: facts({ supersedes: [ref('doc_a', history[0].filename)], history }) }),
        compareSource: async () => {
          throw new NotComparableError()
        },
      })

      const rows = await screen.findAllByTestId('fassung-timeline-row')
      await openRowMenu(rows[1])
      await user.click(await screen.findByRole('menuitem', { name: 'Vergleichen' }))
      const notice = await screen.findByTestId('compare-not-comparable', undefined, { timeout: 10_000 })
      await user.click(within(notice).getByRole('button', { name: copy.compare.openTextCompare }))

      expect(fetchSpy).toHaveBeenCalledWith('/api/documents/doc_a/text', undefined)
      expect(fetchSpy).toHaveBeenCalledWith('/api/documents/doc_1/text', undefined)
      const comparison = await within(rows[1]).findByTestId('document-version-comparison')
      expect(comparison).toHaveTextContent('Fassung 1 → Fassung 2')
      expect(screen.queryByRole('dialog')).toBeNull()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('offers no visual comparison on the current Fassung, which has nothing to compare with itself', async () => {
    const history = [{ id: 'doc_a', filename: 'EG_Index_A_2026-06-01.pdf', createdAt: '2026-06-01T09:00:00Z', changeSummary: null }]
    await renderOpen({ file: fileFixture({ fassung: facts({ supersedes: [ref('doc_a', history[0].filename)], history }) }) })

    const rows = await screen.findAllByTestId('fassung-timeline-row')
    expect(within(rows[0]).queryByTestId('fassung-row-menu')).toBeNull()
  })
})

describe('DocumentFassungen — the decisions on the newest Fassung', () => {
  it('shows Freigeben and Änderungen anfordern, and keeps Piloti überarbeiten lassen and Ablehnen behind ⋯', async () => {
    renderSection({ viewer: reviewer, client: clientOf([makeVersion(1, 'published'), reviewed(2, 'in_review')]) })

    expect(await screen.findByRole('button', { name: 'Freigeben' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Änderungen anfordern' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Ablehnen' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Piloti überarbeiten lassen' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Veröffentlichen' })).toBeNull()

    await userEvent.click(screen.getByTestId('document-review-more'))
    expect(await screen.findByRole('menuitem', { name: 'Piloti überarbeiten lassen' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Ablehnen' })).toHaveAttribute('data-variant', 'destructive')
  })

  it('says what approving means, where approving is offered', async () => {
    renderSection({ viewer: reviewer, client: clientOf([reviewed(1, 'in_review')]) })

    expect(await screen.findByTestId('fassung-approve-explain')).toHaveTextContent('Freigeben heißt: Das Büro steht für den Inhalt ein.')
  })

  it('will not send Änderungen anfordern until something is typed', async () => {
    const requestChanges = vi.fn().mockResolvedValue(makeVersion(1, 'changes_requested'))
    renderSection({ viewer: reviewer, client: clientOf([reviewed(1, 'in_review')], { requestChanges }) })

    await userEvent.click(await screen.findByRole('button', { name: 'Änderungen anfordern' }))
    const send = screen.getByTestId('document-review-comment-send')
    expect(send).toBeDisabled()
    expect(requestChanges).not.toHaveBeenCalled()

    await userEvent.type(screen.getByRole('textbox'), 'Die Fluchtweglänge fehlt.')
    await userEvent.click(send)

    await waitFor(() =>
      expect(requestChanges).toHaveBeenCalledWith('doc_1', 'ver_1', 'Die Fluchtweglänge fehlt.', undefined, 'sha256:abc'),
    )
  })

  it('delegates the revision to Piloti from the ⋯, on the same route, with the one extra field', async () => {
    const requestChanges = vi.fn().mockResolvedValue(makeVersion(1, 'changes_requested'))
    renderSection({ viewer: reviewer, client: clientOf([reviewed(1, 'in_review')], { requestChanges }) })

    await userEvent.click(await screen.findByTestId('document-review-more'))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Piloti überarbeiten lassen' }))
    expect(await screen.findByTestId('document-review-delegate-note')).toBeInTheDocument()
    expect(screen.getByTestId('document-review-comment-send')).toBeDisabled()
    await userEvent.type(screen.getByRole('textbox'), 'Bitte Tabelle 3 neu rechnen.')
    await userEvent.click(screen.getByTestId('document-review-comment-send'))

    await waitFor(() =>
      expect(requestChanges).toHaveBeenCalledWith('doc_1', 'ver_1', 'Bitte Tabelle 3 neu rechnen.', true, 'sha256:abc'),
    )
  })

  it('releases Freigeben only once the Fassung is signed, named by its number in the timeline', async () => {
    const approve = vi.fn().mockResolvedValue(makeVersion(1, 'approved'))
    renderSection({
      file: fileFixture({
        fassung: facts({ history: [{ id: 'doc_a', filename: 'EG_Index_A.pdf', createdAt: '2026-06-01T09:00:00Z', changeSummary: null }] }),
      }),
      viewer: reviewer,
      names: { user_reviewer: 'DI Huber' },
      client: clientOf([reviewed(1, 'in_review')], { approve }),
    })

    await userEvent.click(await screen.findByRole('button', { name: 'Freigeben' }))
    expect(approve).not.toHaveBeenCalled()
    // The linked Index A is Fassung 1, so this upload is Fassung 2, as the header says.
    expect(screen.getByTestId('document-review-approve-stand')).toHaveTextContent('Fassung 2')
    expect(screen.getByTestId('document-review-approve-acting')).toHaveTextContent('DI Huber')
    const send = screen.getByTestId('document-review-approve-send')
    expect(send).toBeDisabled()

    await userEvent.click(screen.getByRole('checkbox', { name: copy.lifecycle.approveConfirm.checkbox }))
    await userEvent.click(send)

    await waitFor(() => expect(approve).toHaveBeenCalledWith('doc_1', 'ver_1', undefined, 'sha256:abc'))
  })

  it('keeps Einreichen shut until the order is stated, and sends the order with the call', async () => {
    const submit = vi.fn().mockResolvedValue(makeVersion(1, 'in_review'))
    renderSection({ viewer: reviewer, client: clientOf([makeVersion(1, 'draft')], { submit }) })

    const send = await screen.findByTestId('document-lifecycle-submit')
    expect(send).toBeDisabled()
    await userEvent.type(screen.getByTestId('document-review-order'), 'Bitte prüfen.')
    expect(send).toBeEnabled()
    await userEvent.click(send)

    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith('doc_1', 'ver_1', undefined, { orderMessage: 'Bitte prüfen.', dueAt: undefined }),
    )
  })

  it('publishes from its own control, with the next step in the header rather than a second blurb', async () => {
    const publish = vi.fn().mockResolvedValue(makeVersion(1, 'published'))
    renderSection({
      viewer: { permissions: ['project:view', 'project:documents:write'], userId: 'user_x' },
      client: clientOf([reviewed(1, 'approved')], { publish }),
    })

    expect(await screen.findByTestId('fassung-next-step')).toHaveTextContent('Nächster Schritt: Ihre Veröffentlichung')
    expect(screen.getByTestId('document-review-publish')).not.toHaveTextContent(copy.lifecycle.publishSection.heading)
    await userEvent.click(screen.getByTestId('document-lifecycle-publish'))
    await waitFor(() => expect(publish).toHaveBeenCalledWith('doc_1', 'ver_1'))
  })

  it('moves the row at once, tells the listing, and re-reads rather than patching', async () => {
    const approve = vi.fn().mockResolvedValue(makeVersion(1, 'approved'))
    const listVersions = vi
      .fn()
      .mockResolvedValueOnce(listing([reviewed(1, 'in_review')]))
      .mockResolvedValue(listing([reviewed(1, 'approved', { approvedBy: 'user_reviewer' })]))
    const onLifecycleChanged = vi.fn()
    renderSection({ viewer: reviewer, client: fakeClient({ listVersions, approve }), onLifecycleChanged })

    await userEvent.click(await screen.findByRole('button', { name: 'Freigeben' }))
    await userEvent.click(screen.getByRole('checkbox', { name: copy.lifecycle.approveConfirm.checkbox }))
    await userEvent.click(screen.getByTestId('document-review-approve-send'))

    await waitFor(() => expect(listVersions).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(onLifecycleChanged).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: 'doc_1', state: 'approved', versionCount: 1 }),
      ),
    )
    expect(screen.getByTestId('document-lifecycle-state')).toHaveTextContent('Freigegeben')
  })

  it('says the decision has moved when the compare-and-swap is lost, and re-reads it', async () => {
    const approve = vi.fn().mockRejectedValue(new DocumentLifecycleError(409, 'CONFLICT', 'state changed'))
    const listVersions = vi
      .fn()
      .mockResolvedValueOnce(listing([reviewed(1, 'in_review')]))
      .mockResolvedValue(listing([reviewed(1, 'approved', { approvedBy: 'user_other' })]))
    renderSection({ viewer: reviewer, client: fakeClient({ listVersions, approve }) })

    await userEvent.click(await screen.findByRole('button', { name: 'Freigeben' }))
    await userEvent.click(screen.getByRole('checkbox', { name: copy.lifecycle.approveConfirm.checkbox }))
    await userEvent.click(screen.getByTestId('document-review-approve-send'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(copy.lifecycle.errors.conflict))
    await waitFor(() => expect(listVersions).toHaveBeenCalledTimes(2))
    expect(await screen.findByTestId('document-lifecycle-state')).toHaveTextContent('Freigegeben')
  })

  it('says why Piloti may not revise a draft in a restricted folder', async () => {
    const reason = 'Dieses Dokument liegt in einem Ordner mit eingeschränktem Zugriff.'
    const requestChanges = vi
      .fn()
      .mockRejectedValue(new DocumentLifecycleError(403, 'CONVERSATION_CONFINED', reason, { action: 'revision' }))
    renderSection({ viewer: reviewer, client: clientOf([reviewed(1, 'in_review')], { requestChanges }) })

    await userEvent.click(await screen.findByTestId('document-review-more'))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Piloti überarbeiten lassen' }))
    await userEvent.type(await screen.findByRole('textbox'), 'Bitte Tabelle 3 neu rechnen.')
    await userEvent.click(screen.getByTestId('document-review-comment-send'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(reason))
    expect(await screen.findByTestId('document-lifecycle-state')).toHaveTextContent('In Prüfung')
  })

  it('puts the row back when the request fails for any other reason', async () => {
    renderSection({
      viewer: reviewer,
      client: clientOf([reviewed(1, 'in_review')], {
        approve: () => Promise.reject(new DocumentLifecycleError(500, 'INTERNAL', 'boom')),
      }),
    })

    await userEvent.click(await screen.findByRole('button', { name: 'Freigeben' }))
    await userEvent.click(screen.getByRole('checkbox', { name: copy.lifecycle.approveConfirm.checkbox }))
    await userEvent.click(screen.getByTestId('document-review-approve-send'))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(await screen.findByTestId('document-lifecycle-state')).toHaveTextContent('In Prüfung')
  })

  it('says a held file is still being checked, rather than that the decision moved', async () => {
    const submit = vi
      .fn()
      .mockRejectedValue(new DocumentLifecycleError(409, 'CONFLICT', 'held', { op: 'submit', reason: 'held' }))
    renderSection({ viewer: reviewer, client: clientOf([makeVersion(1, 'draft')], { submit }) })

    await userEvent.type(await screen.findByTestId('document-review-order'), 'Bitte prüfen.')
    await userEvent.click(screen.getByTestId('document-lifecycle-submit'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(copy.lifecycle.errors.held))
    expect(await screen.findByTestId('document-lifecycle-state')).toHaveTextContent('Entwurf')
  })

  it('retires the item from one quiet line, through its own confirm, and tells the listing', async () => {
    const archive = vi.fn().mockResolvedValue({ documentId: 'doc_1', lifecycle: 'archived' })
    const listVersions = vi
      .fn()
      .mockResolvedValueOnce(listing([makeVersion(1, 'published')]))
      .mockResolvedValue(listing([makeVersion(1, 'published')], { lifecycle: 'archived' }))
    const onLifecycleChanged = vi.fn()
    renderSection({
      viewer: { permissions: ['project:view', 'project:documents:write'], userId: 'user_x' },
      client: fakeClient({ listVersions, archive }),
      onLifecycleChanged,
    })

    await userEvent.click(await toggle())
    const line = await screen.findByTestId('document-lifecycle-archive')
    expect(line).toHaveTextContent('Datei stilllegen')
    expect(screen.getByTestId('document-archive-action')).not.toHaveTextContent(copy.lifecycle.archiveSection.blurb)
    await userEvent.click(line)
    await userEvent.click(await screen.findByTestId('document-archive-confirm'))

    await waitFor(() => expect(archive).toHaveBeenCalledWith('doc_1'))
    await waitFor(() =>
      expect(onLifecycleChanged).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'doc_1', lifecycle: 'archived' })),
    )
  })

  it('degrades to the linked history with one quiet line when the versions cannot be read', async () => {
    renderSection({
      viewer: reviewer,
      client: fakeClient({ listVersions: () => Promise.reject(new Error('down')) }),
      file: fileFixture({ fassung: facts({ supersededBy: ref('doc_2', 'Grundriss_D.pdf') }) }),
    })

    expect(await screen.findByTestId('document-lifecycle-failed')).toHaveTextContent(copy.lifecycle.errors.loadFailed)
    expect(screen.getAllByTestId('fassung-timeline-row')[0]).toHaveTextContent('Grundriss_D.pdf')
  })
})

describe('DocumentFassungen — links between documents', () => {
  const twoOlder = facts({
    supersedes: [ref('doc_0', 'Grundriss_A.pdf'), ref('doc_0b', 'Grundriss_B.pdf')],
  })

  it('lists the older Fassungen it replaces, this document first', async () => {
    await renderOpen({ file: fileFixture({ fassung: twoOlder }) })

    const rows = await screen.findAllByTestId('fassung-timeline-row')
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('aktuell'),
      expect.stringContaining('Grundriss_A.pdf'),
      expect.stringContaining('Grundriss_B.pdf'),
    ])
  })

  it('does not offer to unlink the newer file, which is the other document’s decision', async () => {
    renderSection({ file: fileFixture({ fassung: facts({ supersededBy: ref('doc_2', 'Grundriss_D.pdf') }) }), canManage: true })

    const rows = await screen.findAllByTestId('fassung-timeline-row')
    await openRowMenu(rows[0])
    expect(screen.queryByTestId('fassung-unlink')).toBeNull()
  })

  it('unlinks each older Fassung on its own, not only the first, and only where it is a direct predecessor', async () => {
    const user = userEvent.setup()
    const history = [
      { id: 'doc_b', filename: 'EG_Index_B_2026-07-02.pdf', createdAt: '2026-07-02T09:00:00Z', changeSummary: null },
      { id: 'doc_a', filename: 'EG_Index_A_2026-06-01.pdf', createdAt: '2026-06-01T09:00:00Z', changeSummary: null },
    ]
    vi.mocked(requestFassungLink).mockResolvedValueOnce(answer(facts({ supersedes: [ref('doc_b', history[0].filename)] })))
    await renderOpen({
      file: fileFixture({ fassung: facts({ supersedes: [ref('doc_b', history[0].filename)], history }) }),
      canManage: true,
    })

    const rows = await screen.findAllByTestId('fassung-timeline-row')
    await openRowMenu(rows[2])
    expect(screen.queryByTestId('fassung-unlink')).toBeNull()
    await user.keyboard('{Escape}')

    await openRowMenu(rows[1])
    await user.click(await screen.findByTestId('fassung-unlink'))
    expect(requestFassungLink).toHaveBeenCalledWith('doc_1', 'doc_b', false)
  })

  it('hides the unlink from a reader who may not manage the folder', async () => {
    await renderOpen({ file: fileFixture({ fassung: twoOlder }), canManage: false })

    const rows = await screen.findAllByTestId('fassung-timeline-row')
    await openRowMenu(rows[1])
    expect(screen.queryByTestId('fassung-unlink')).toBeNull()
  })

  it('reports the facts of BOTH documents after an unlink, and goes quiet when nothing is left', async () => {
    const user = userEvent.setup()
    const onFassungChanged = vi.fn()
    const olderFacts = facts({ supersededBy: null })
    vi.mocked(requestFassungLink).mockResolvedValueOnce(answer(EMPTY_FASSUNG, olderFacts))
    const { container } = await renderOpen({
      file: fileFixture({ fassung: facts({ supersedes: [ref('doc_0', 'Grundriss_A.pdf')] }) }),
      canManage: true,
      onFassungChanged,
    })

    await openRowMenu((await screen.findAllByTestId('fassung-timeline-row'))[1])
    await user.click(await screen.findByTestId('fassung-unlink'))

    await waitFor(() => expect(onFassungChanged).toHaveBeenCalledWith('doc_1', EMPTY_FASSUNG))
    expect(onFassungChanged).toHaveBeenCalledWith('doc_0', olderFacts)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('drops a decision that answers after the rail moved to another file', async () => {
    const user = userEvent.setup()
    let resolve: (value: ReturnType<typeof answer>) => void = () => undefined
    vi.mocked(requestFassungLink).mockReturnValueOnce(new Promise((res) => (resolve = res)))
    const { rerender } = await renderOpen({
      file: fileFixture({ fassung: facts({ supersedes: [ref('doc_0', 'Grundriss_A.pdf')] }) }),
      canManage: true,
    })

    await openRowMenu((await screen.findAllByTestId('fassung-timeline-row'))[1])
    await user.click(await screen.findByTestId('fassung-unlink'))
    rerender(
      section({
        file: fileFixture({ id: 'doc_9', fassung: facts({ supersededBy: ref('doc_8', 'Neu.pdf') }) }),
        canManage: true,
      }),
    )
    await act(async () => resolve(answer(facts({ supersedes: [ref('doc_x', 'Fremd.pdf')] }))))

    expect((await screen.findAllByTestId('fassung-timeline-row'))[0]).toHaveTextContent('Neu.pdf')
    expect(screen.queryByText(/Fremd\.pdf/)).toBeNull()
  })

  it('shows the new file’s facts, not the decision made on the previous one', async () => {
    const { rerender } = await renderOpen({
      file: fileFixture({ fassung: facts({ supersedes: [ref('doc_0', 'Grundriss_A.pdf')] }) }),
    })
    expect(await screen.findByTestId('fassung-timeline')).toHaveTextContent('Grundriss_A.pdf')

    rerender(section({ file: fileFixture({ id: 'doc_9', fassung: facts({ supersededBy: ref('doc_8', 'Schnitt_AB.pdf') }) }) }))

    const timeline = await screen.findByTestId('fassung-timeline')
    expect(timeline).toHaveTextContent('Schnitt_AB.pdf')
    expect(timeline).not.toHaveTextContent('Grundriss_A.pdf')
  })
})

describe('DocumentFassungen — Piloti’s suggestion', () => {
  const suggested = (basis: 'name' | 'content' | 'title_block', reason = '') =>
    fileFixture({
      fassung: facts({ suggestion: { of: ref('doc_0', 'Grundriss_B.pdf'), confidence: 0.9, reason, basis } }),
    })
  const confirmLabel = copy.preview.fassung.confirm
  const dismissLabel = copy.preview.fassung.dismiss

  it('names the older document and says what the suggestion rests on', async () => {
    const { unmount } = renderSection({ file: suggested('name') })
    const card = await screen.findByTestId('fassung-suggestion')
    expect(card).toHaveTextContent(fill(copy.preview.fassung.suggestion, { name: 'Grundriss_B.pdf' }))
    expect(card).toHaveTextContent(copy.preview.fassung.basisName)
    unmount()

    renderSection({ file: suggested('title_block') })
    expect(await screen.findByTestId('fassung-suggestion')).toHaveTextContent(copy.preview.fassung.basisTitleBlock)
  })

  it('says Piloti read both documents when the basis is the content, and adds its reason', async () => {
    renderSection({ file: suggested('content', 'Gleicher Grundriss, neue Maße.') })

    const card = await screen.findByTestId('fassung-suggestion')
    expect(card).toHaveTextContent(`${copy.preview.fassung.basisContent} Gleicher Grundriss, neue Maße.`)
    expect(card).not.toHaveTextContent(copy.preview.fassung.basisName)
  })

  it('confirms through requestFassungLink with linked=true, shows the facts it returns, and reports both sides', async () => {
    const user = userEvent.setup()
    const returned = facts({ supersedes: [ref('doc_0', 'Grundriss_B.pdf')] })
    const olderFacts = facts({ supersededBy: ref('doc_1', 'Grundriss_C.pdf') })
    vi.mocked(requestFassungLink).mockResolvedValueOnce(answer(returned, olderFacts))
    const onFassungChanged = vi.fn()
    renderSection({ file: suggested('name'), canManage: true, onFassungChanged })

    await user.click(await screen.findByRole('button', { name: confirmLabel }))

    expect(requestFassungLink).toHaveBeenCalledWith('doc_1', 'doc_0', true)
    await waitFor(() => expect(screen.getByTestId('fassung-timeline')).toHaveTextContent('Grundriss_B.pdf'))
    expect(screen.queryByTestId('fassung-suggestion')).toBeNull()
    expect(onFassungChanged).toHaveBeenCalledWith('doc_1', returned)
    expect(onFassungChanged).toHaveBeenCalledWith('doc_0', olderFacts)
  })

  it('dismisses with linked=false and takes the section away when nothing else is left', async () => {
    const user = userEvent.setup()
    vi.mocked(requestFassungLink).mockResolvedValueOnce(answer(EMPTY_FASSUNG))
    const { container } = renderSection({ file: suggested('name'), canManage: true })

    await user.click(await screen.findByRole('button', { name: dismissLabel }))

    expect(requestFassungLink).toHaveBeenCalledWith('doc_1', 'doc_0', false)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('disables both answers while the request is in flight', async () => {
    const user = userEvent.setup()
    const pending = deferred<ReturnType<typeof answer>>()
    vi.mocked(requestFassungLink).mockReturnValueOnce(pending.promise)
    renderSection({ file: suggested('name'), canManage: true })

    await user.click(await screen.findByRole('button', { name: confirmLabel }))

    expect(screen.getByRole('button', { name: confirmLabel })).toBeDisabled()
    expect(screen.getByRole('button', { name: dismissLabel })).toBeDisabled()
    await act(async () => pending.resolve(answer(EMPTY_FASSUNG)))
  })

  it('reports a refused request with a toast and keeps the suggestion for another try', async () => {
    const user = userEvent.setup()
    vi.mocked(requestFassungLink).mockRejectedValueOnce(new Error('409 conflict'))
    renderSection({ file: suggested('name'), canManage: true })

    await user.click(await screen.findByRole('button', { name: confirmLabel }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(copy.preview.fassung.saveError))
    expect(screen.getByTestId('fassung-suggestion')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: confirmLabel })).toBeEnabled()
  })

  it('shows neither answer, but says who may answer, to a reader who may not manage the folder', async () => {
    renderSection({ file: suggested('name'), canManage: false })

    await screen.findByTestId('fassung-suggestion')
    expect(screen.queryByRole('button', { name: confirmLabel })).toBeNull()
    expect(screen.queryByRole('button', { name: dismissLabel })).toBeNull()
    expect(screen.getByText(copy.preview.fassung.askEditor)).toBeInTheDocument()
  })
})
