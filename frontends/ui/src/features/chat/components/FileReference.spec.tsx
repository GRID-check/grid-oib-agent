import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test-utils'
import { I18nProvider } from '@/i18n'
import { useChatStore } from '../store'
import { useFilePreviewStore } from '@/features/documents/stores/file-preview-store'
import { resetFilePeekBinding } from '@/features/documents/lib/open-file-peek'
import type { FileItem } from '@/features/documents/components/project-file-workspace'
import type { StoredFile } from '@/features/documents/hooks/use-surfaced-documents'
import { fileReferenceHref } from '../lib/file-references'
import { FileReferenceLink, FileReferenceProvider } from './FileReference'

const viewport = { isMobile: false }
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => viewport.isMobile }))

const file = (overrides: Partial<FileItem> = {}): FileItem => ({
  id: 'doc-1',
  filename: 'pd8280-2.pdf',
  displayName: null,
  fileSize: 2_400_000,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-09-01T00:00:00Z',
  errorMessage: null,
  summary: 'Flächenwidmungs- und Bebauungsplan.',
  pageCount: 4,
  chunkCount: 12,
  contentTypes: null,
  tags: null,
  ...overrides,
})

const stored = (overrides: Partial<StoredFile> = {}): StoredFile => ({
  file: file(),
  corpus: 'projekt',
  ...overrides,
})

const renderReference = (options: {
  href: string
  label?: string
  resolve?: (name: string) => StoredFile | null
}) =>
  render(
    <I18nProvider initialLocale="de" fixedLocale>
      <FileReferenceProvider resolve={options.resolve ?? (() => stored())}>
        <FileReferenceLink href={options.href} fallback={<a href={options.href}>fallback</a>}>
          {options.label ?? 'pd8280-2.pdf'}
        </FileReferenceLink>
      </FileReferenceProvider>
    </I18nProvider>
  )

describe('FileReferenceLink', () => {
  beforeEach(() => {
    viewport.isMobile = false
    useFilePreviewStore.setState({ file: null, mode: 'modal', hidden: false, context: {} })
    useChatStore.setState({ projectId: 'proj-1', composerSubject: null })
  })

  afterEach(() => {
    resetFilePeekBinding()
    vi.restoreAllMocks()
  })

  it('renders a resolved filename as a chip carrying the answer’s own spelling', () => {
    renderReference({ href: fileReferenceHref('PD8280-2.PDF'), label: 'PD8280-2.PDF' })
    const chip = screen.getByTestId('file-reference')
    expect(chip).toHaveTextContent('PD8280-2.PDF')
    expect(chip).toHaveAttribute('data-file-reference', 'pd8280-2.pdf')
  })

  // The rule the citation marker already holds to: a control that opens
  // nothing is worse than plain text.
  it('falls back to plain text when the name resolves to nothing', () => {
    renderReference({ href: fileReferenceHref('Konzept.pdf'), resolve: () => null })
    expect(screen.queryByTestId('file-reference')).toBeNull()
    expect(screen.getByText('fallback')).toBeInTheDocument()
  })

  it('leaves an anchor that is not a file reference to the fallback', () => {
    renderReference({ href: '#answer-source-msg-1-3' })
    expect(screen.queryByTestId('file-reference')).toBeNull()
  })

  it('opens the document in the peek pane beside the answer', async () => {
    const user = userEvent.setup()
    renderReference({ href: fileReferenceHref('pd8280-2.pdf') })
    await user.click(screen.getByTestId('file-reference'))

    const preview = useFilePreviewStore.getState()
    expect(preview.file?.id).toBe('doc-1')
    expect(preview.mode).toBe('peek')
    expect(preview.context.projectId).toBe('proj-1')
  })

  // Naming a file and asking about it are one act — the same commitment a
  // citation's peek and a document card already make.
  it('makes the file it opened what the composer is asking about', async () => {
    const user = userEvent.setup()
    renderReference({ href: fileReferenceHref('pd8280-2.pdf') })
    await user.click(screen.getByTestId('file-reference'))

    expect(useChatStore.getState().composerSubject).toEqual({
      resourceType: 'document',
      resourceId: 'doc-1',
      title: 'pd8280-2.pdf',
      filename: 'pd8280-2.pdf',
      shelf: 'project',
    })
  })

  // The shelf rides along as `focus_shelf`: a Büroarchiv file must not be asked
  // about as though it were project knowledge.
  it('carries the shelf the file came from into the subject', async () => {
    const user = userEvent.setup()
    renderReference({
      href: fileReferenceHref('pd8280-2.pdf'),
      resolve: () => stored({ corpus: 'buero' }),
    })
    await user.click(screen.getByTestId('file-reference'))
    expect(useChatStore.getState().composerSubject?.shelf).toBe('archiv')
  })

  // `stored` is the agent's own report: readable, deliberately never indexed.
  // Binding it would promise a retrieval that cannot happen, so the document
  // opens and the composer keeps saying whatever it already said.
  it('opens a never-indexed file without committing the composer to it', async () => {
    const user = userEvent.setup()
    renderReference({
      href: fileReferenceHref('pd8280-2.pdf'),
      resolve: () => stored({ file: file({ status: 'stored' }) }),
    })
    await user.click(screen.getByTestId('file-reference'))

    expect(useFilePreviewStore.getState().file?.id).toBe('doc-1')
    expect(useChatStore.getState().composerSubject).toBeNull()
  })

  it('names the whole act on the chip, and only opening when that is all it does', () => {
    renderReference({ href: fileReferenceHref('pd8280-2.pdf') })
    expect(screen.getByTestId('file-reference')).toHaveAccessibleName(
      'pd8280-2.pdf öffnen und dazu fragen'
    )
  })

  it('says only „öffnen" for a file the agent cannot read', () => {
    renderReference({
      href: fileReferenceHref('pd8280-2.pdf'),
      resolve: () => stored({ file: file({ status: 'stored' }) }),
    })
    expect(screen.getByTestId('file-reference')).toHaveAccessibleName('Datei öffnen: pd8280-2.pdf')
  })

  // There is no beside on a narrow screen: FilePreviewHost refuses to peek, so
  // a peek there would be a control that silently did nothing.
  it('opens as an overlay where there is no room for two panes', async () => {
    viewport.isMobile = true
    const user = userEvent.setup()
    renderReference({ href: fileReferenceHref('pd8280-2.pdf') })
    await user.click(screen.getByTestId('file-reference'))
    expect(useFilePreviewStore.getState().mode).toBe('modal')
  })

  it('resolves a Büroarchiv file into the archive scope', async () => {
    const user = userEvent.setup()
    renderReference({
      href: fileReferenceHref('pd8280-2.pdf'),
      resolve: () => stored({ corpus: 'buero' }),
    })
    await user.click(screen.getByTestId('file-reference'))
    expect(useFilePreviewStore.getState().context.scope).toBe('archiv')
  })

  it('previews the file’s facts on focus without opening anything', async () => {
    const user = userEvent.setup()
    renderReference({ href: fileReferenceHref('pd8280-2.pdf') })
    await user.tab()
    expect(await screen.findByTestId('file-reference-peek')).toBeInTheDocument()
    expect(screen.getByText('Projektdateien')).toBeInTheDocument()
    expect(screen.getByText(/4 Seiten/)).toBeInTheDocument()
    expect(useFilePreviewStore.getState().file).toBeNull()
  })

  // The panel's action and the chip it hangs off do the same thing, so they
  // have to promise the same thing — including the half that is about the
  // composer rather than the viewer.
  it('names the same act on the peek’s own action', async () => {
    const user = userEvent.setup()
    renderReference({ href: fileReferenceHref('pd8280-2.pdf') })
    await user.tab()
    expect(await screen.findByRole('button', { name: /Öffnen und dazu fragen/ })).toBeInTheDocument()
  })

  it('offers a never-indexed file as opening only, and says why', async () => {
    const user = userEvent.setup()
    renderReference({
      href: fileReferenceHref('pd8280-2.pdf'),
      resolve: () => stored({ file: file({ status: 'stored' }) }),
    })
    await user.tab()
    expect(await screen.findByTestId('file-reference-peek')).toBeInTheDocument()
    expect(screen.getByText(/nicht zitierfähig/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Neben der Antwort öffnen/ })).toBeInTheDocument()
  })
})
