/**
 * The folder brief's revision section, as a reader meets it: which name series
 * exist, which Fassungen a person has confirmed, and the one button that
 * confirms a series.
 *
 * The series grammar and `isSeriesConfirmed` are specced in
 * `../lib/revision-series.spec.ts` and `../lib/folder-knowledge.spec.ts`. Here
 * only what the section renders for each state, and what it sends.
 *
 * The copy is German, as in the planning office (`I18nProvider` with
 * `fixedLocale`, as the sibling specs do).
 */

import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { I18nProvider } from '@/i18n'
import type { FassungFacts } from '@/lib/documents/fassung'
import type { FileItem } from '../file-types'
import { buildFolderBrief, type FolderBrief } from '../lib/folder-knowledge'
import { FolderBrief as FolderBriefView } from './folder-brief'

const file = (overrides: Partial<FileItem> & { id: string }): FileItem => ({
  filename: 'doc.pdf',
  displayName: null,
  fileSize: 1,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
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

/** Two name series: EG Grundriss (A, B, C) and Schnitt AA (A, B). */
const grundriss = (overrides: { a?: FassungFacts; b?: FassungFacts } = {}): FileItem[] => [
  file({ id: 'ga', filename: 'EG_Grundriss_Index_A_2026-01-10.pdf', fassung: overrides.a ?? null }),
  file({ id: 'gb', filename: 'EG_Grundriss_Index_B_2026-02-10.pdf', fassung: overrides.b ?? null }),
  file({ id: 'gc', filename: 'EG_Grundriss_Index_C_2026-08-14.pdf' }),
]
const schnitt = (): FileItem[] => [
  file({ id: 'sa', filename: 'Schnitt_AA_idx-A.pdf' }),
  file({ id: 'sb', filename: 'Schnitt_AA_idx-B.pdf' }),
]
const replacedBy = (newer: FileItem): FassungFacts => ({
  supersededBy: { id: newer.id, filename: newer.filename },
  supersedes: [],
  suggestion: null,
  changeSummary: null,
})

const briefOf = (files: FileItem[]): FolderBrief => buildFolderBrief(files, [], null)

const view = (brief: FolderBrief, extra: Partial<ComponentProps<typeof FolderBriefView>> = {}) => (
  <I18nProvider initialLocale="de" fixedLocale>
    <FolderBriefView
      brief={brief}
      folderName={null}
      shelfKind="project"
      onSelect={vi.fn()}
      onOpenFolder={vi.fn()}
      collapsed={false}
      onCollapsedChange={vi.fn()}
      {...extra}
    />
  </I18nProvider>
)

/** The series row whose current document is named `filename`. */
const rowFor = (filename: string): HTMLElement => {
  const row = screen.getAllByTestId('folder-brief-series').find((li) => within(li).queryByText(filename))
  if (!row) throw new Error(`no series row for ${filename}`)
  return row
}

const confirmButtons = () => screen.queryAllByRole('button', { name: 'Bestätigen' })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('FolderBrief revision section', () => {
  it('offers one „Bestätigen" per unconfirmed series when onConfirmSeries is passed', () => {
    render(view(briefOf([...grundriss(), ...schnitt()]), { onConfirmSeries: vi.fn().mockResolvedValue(undefined) }))

    expect(screen.getAllByTestId('folder-brief-series')).toHaveLength(2)
    expect(confirmButtons()).toHaveLength(2)
  })

  it('offers no confirm button, but still lists the series, when onConfirmSeries is absent', () => {
    render(view(briefOf([...grundriss(), ...schnitt()])))

    expect(screen.getAllByTestId('folder-brief-series')).toHaveLength(2)
    expect(confirmButtons()).toHaveLength(0)
  })

  it('calls onConfirmSeries with the series of the row whose button was clicked', async () => {
    const user = userEvent.setup()
    const onConfirmSeries = vi.fn().mockResolvedValue(undefined)
    const brief = briefOf([...grundriss(), ...schnitt()])
    render(view(brief, { onConfirmSeries }))

    await user.click(within(rowFor('Schnitt_AA_idx-B.pdf')).getByRole('button', { name: 'Bestätigen' }))

    expect(onConfirmSeries).toHaveBeenCalledTimes(1)
    const schnittSeries = brief.revisionSeries.find((series) => series.key === 'schnitt aa.pdf')
    expect(onConfirmSeries).toHaveBeenCalledWith(schnittSeries)
  })

  it('disables every confirm button while one confirmation is pending, and enables them when it settles', async () => {
    const user = userEvent.setup()
    const pending = deferred<void>()
    const onConfirmSeries = vi.fn(() => pending.promise)
    render(view(briefOf([...grundriss(), ...schnitt()]), { onConfirmSeries }))

    await user.click(confirmButtons()[0])

    expect(confirmButtons()).toHaveLength(2)
    for (const button of confirmButtons()) expect(button).toBeDisabled()

    await act(async () => pending.resolve())

    for (const button of confirmButtons()) expect(button).toBeEnabled()
  })

  it('shows „bestätigt" and no button for a series whose older Fassungen are all confirmed', () => {
    const [a, b, c] = grundriss()
    const confirmed = [{ ...a, fassung: replacedBy(c) }, { ...b, fassung: replacedBy(c) }, c]
    render(view(briefOf([...confirmed, ...schnitt()]), { onConfirmSeries: vi.fn().mockResolvedValue(undefined) }))

    const row = rowFor('EG_Grundriss_Index_C_2026-08-14.pdf')
    expect(within(row).getByTestId('folder-brief-series-confirmed')).toHaveTextContent('bestätigt')
    expect(within(row).queryByRole('button', { name: 'Bestätigen' })).toBeNull()
    // The unconfirmed series beside it still has its button, and only that one.
    expect(confirmButtons()).toHaveLength(1)
    expect(within(rowFor('Schnitt_AA_idx-B.pdf')).getByRole('button', { name: 'Bestätigen' })).toBeInTheDocument()
  })

  it('keeps the button while only some of the older Fassungen are confirmed', () => {
    const [a, b, c] = grundriss()
    const partly = [{ ...a, fassung: replacedBy(c) }, b, c]
    render(view(briefOf(partly), { onConfirmSeries: vi.fn().mockResolvedValue(undefined) }))

    const row = rowFor('EG_Grundriss_Index_C_2026-08-14.pdf')
    expect(within(row).queryByTestId('folder-brief-series-confirmed')).toBeNull()
    expect(within(row).getByRole('button', { name: 'Bestätigen' })).toBeInTheDocument()
  })

  it('renders the confirmed-only line when there is no series but a confirmed link exists elsewhere', () => {
    const newer = file({ id: 'new', filename: 'Plan_Neu.pdf' })
    const older = file({ id: 'old', filename: 'Plan_Alt.pdf', fassung: replacedBy(newer) })
    render(view(briefOf([older, newer]), { onConfirmSeries: vi.fn().mockResolvedValue(undefined) }))

    const section = screen.getByTestId('folder-brief-revisions')
    expect(section).toHaveTextContent('Eine ältere Fassung ist bestätigt ersetzt.')
    expect(within(section).queryAllByTestId('folder-brief-series')).toHaveLength(0)
    expect(confirmButtons()).toHaveLength(0)
  })

  it('renders no revision section when there are neither series nor confirmed links', () => {
    render(view(briefOf([file({ id: 'only', filename: 'Plan_Einzeln.pdf', tags: ['Grundriss'] })])))

    expect(screen.queryByTestId('folder-brief-revisions')).toBeNull()
  })
})
