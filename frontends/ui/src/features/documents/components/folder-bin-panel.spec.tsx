import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { toast } from 'sonner'
import type { FolderBinEntry, FolderBinListing } from '@/adapters/api/folder-bin-client'
import { FolderBinPanel } from './folder-bin-panel'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const entry = (overrides: Partial<FolderBinEntry> = {}): FolderBinEntry => ({
  folderId: 'f-vertraege',
  name: 'Verträge',
  path: 'Verwaltung/Verträge',
  deletedAt: '2026-10-04T09:12:00Z',
  deletedBy: { userId: 'user_gf', name: 'Gerda Fischer' },
  purgeAfter: '2026-10-18T09:12:00Z',
  status: 'pending',
  documents: 14,
  folders: 2,
  canRestore: true,
  ...overrides,
})

const listing = (entries: FolderBinEntry[], rights: Partial<FolderBinListing> = {}): FolderBinListing => ({
  entries,
  canPurge: false,
  ...rights,
})

const answer = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

describe('FolderBinPanel (the Papierkorb)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(toast.success).mockClear()
    vi.mocked(toast.error).mockClear()
  })

  test('lists who deleted what, when, what it holds and when it goes for good', () => {
    render(<FolderBinPanel projectId="p1" initial={listing([entry()])} />)
    expect(screen.getByText('Verträge')).toBeDefined()
    expect(screen.getByText(/Deleted by Gerda Fischer on/)).toBeDefined()
    expect(screen.getByText(/14 documents · 2 folders/)).toBeDefined()
    expect(screen.getByText(/Permanently deleted on/)).toBeDefined()
  })

  test('says the bin is empty', () => {
    render(<FolderBinPanel projectId="p1" initial={listing([])} />)
    expect(screen.getByText('The bin is empty.')).toBeDefined()
  })

  test('offers restore only where the reader may restore, and purge only to a project admin', () => {
    render(
      <FolderBinPanel projectId="p1" initial={listing([entry(), entry({ folderId: 'f-ro', name: 'Honorare', canRestore: false })])} />
    )
    expect(screen.getByTestId('bin-restore-f-vertraege')).toBeDefined()
    expect(screen.queryByTestId('bin-restore-f-ro')).toBeNull()
    expect(screen.queryByTestId('bin-purge-f-vertraege')).toBeNull()
  })

  test('restoring a folder whose parent is gone says it came back at the top of the project', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(answer(200, { restoredTo: 'root', folders: 1, documents: 3 }))
      .mockResolvedValueOnce(answer(200, listing([])))
    vi.stubGlobal('fetch', fetchSpy)
    render(<FolderBinPanel projectId="p1" initial={listing([entry()])} />)

    await userEvent.click(screen.getByTestId('bin-restore-f-vertraege'))

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        '“Verträge” is restored at the top of the project, because its parent folder is deleted.'
      )
    )
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/projects/p1/bin/f-vertraege/restore')
    expect(await screen.findByText('The bin is empty.')).toBeDefined()
  })

  test('a name clash on restore asks for a rename', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(answer(409, { error: 'taken', details: { reason: 'folder-name-taken' } }))
    )
    render(<FolderBinPanel projectId="p1" initial={listing([entry()])} />)
    await userEvent.click(screen.getByTestId('bin-restore-f-vertraege'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('A folder named “Verträge” already exists there. Rename it, then restore again.')
    )
  })

  test('a legal hold on „Endgültig löschen" is said without naming the hold, and the entry stays', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(answer(409, { error: 'held', details: { reason: 'legal_hold' } }))
    )
    render(<FolderBinPanel projectId="p1" initial={listing([entry()], { canPurge: true })} />)
    await userEvent.click(screen.getByTestId('bin-purge-f-vertraege'))
    await userEvent.click(await screen.findByTestId('bin-purge-confirm'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('This folder is under a retention obligation and cannot be deleted right now.')
    )
    expect(screen.getByText('Verträge')).toBeDefined()
  })
})
