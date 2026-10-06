'use client'

/**
 * Dev preview for the Papierkorb and everything around a deleted folder
 * (ADR-0081).
 *
 * The REAL `FolderBinPanel` over a fixture listing: one folder restorable,
 * one whose parent is gone (restores to the project root), one the reader may
 * only read (no restore), one being purged. Restore and „Endgültig löschen"
 * go through a module-scope fetch shim that answers as the server would, including the legal-hold refusal on
 * „Honorare". Below it: the organization setting „Inhalte aus gelöschten
 * Ordnern", and the „Quelle gelöscht am …" note as an answer, a memory note
 * and a filed report show it.
 *
 * Not linked from anywhere and 404s outside development.
 */

import type { JSX } from 'react'
import { notFound } from 'next/navigation'
import type { FolderBinListing } from '@/adapters/api/folder-bin-client'
import { SourceDeletedNote } from '@/components/projects/source-deleted-note'
import { FolderBinPanel } from '@/features/documents/components/folder-bin-panel'
import { DeletedFolderContentCard } from '@/features/organization/components/deleted-folder-content-card'

const PROJECT = 'dev-project'

const LISTING: FolderBinListing = {
  canPurge: true,
  entries: [
    {
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
    },
    {
      folderId: 'f-alt',
      name: 'Alt',
      path: 'Pläne/Alt',
      deletedAt: '2026-10-05T15:40:00Z',
      deletedBy: { userId: 'user_pl', name: 'Paul Lechner' },
      purgeAfter: '2026-10-19T15:40:00Z',
      status: 'pending',
      documents: 3,
      folders: 1,
      canRestore: true,
    },
    {
      folderId: 'f-honorare',
      name: 'Honorare',
      path: 'Honorare',
      deletedAt: '2026-09-30T08:00:00Z',
      deletedBy: { userId: null, name: null },
      purgeAfter: '2026-10-14T08:00:00Z',
      status: 'pending',
      documents: 6,
      folders: 0,
      canRestore: false,
    },
    {
      folderId: 'f-statik',
      name: 'Statik-Vorabzug',
      path: 'Statik/Statik-Vorabzug',
      deletedAt: '2026-09-22T11:30:00Z',
      deletedBy: { userId: 'user_st', name: 'Sabine Thaler' },
      purgeAfter: '2026-10-06T11:30:00Z',
      status: 'purging',
      documents: 21,
      folders: 4,
      canRestore: false,
    },
  ],
}

const COUNTS = { documents: 14, folders: 3, memoryNotes: 0, answers: 0, conversations: 2, reports: 0, tracesErased: 0 }

const state = { entries: LISTING.entries.map((entry) => ({ ...entry })), policy: 'unchanged' }

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __folderBinShim?: boolean }
  if (!w.__folderBinShim) {
    w.__folderBinShim = true
    const real = window.fetch.bind(window)
    const pause = () => new Promise((resolve) => window.setTimeout(resolve, 350))
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === `/api/projects/${PROJECT}/bin`) return Response.json({ ...LISTING, entries: state.entries })
      const restore = /\/bin\/([^/]+)\/restore$/.exec(url)
      if (restore) {
        await pause()
        const folderId = decodeURIComponent(restore[1])
        state.entries = state.entries.filter((entry) => entry.folderId !== folderId)
        const restoredTo = folderId === 'f-alt' ? 'root' : 'original'
        return Response.json({ restoredTo, folders: 1, documents: 3 })
      }
      const held = Response.json(
        { error: 'This item is under a legal hold and cannot be deleted.', code: 'CONFLICT', details: { reason: 'legal_hold' } },
        { status: 409 }
      )
      const purge = /\/bin\/([^/]+)$/.exec(url)
      if (purge && init?.method === 'DELETE') {
        await pause()
        if (purge[1] === 'f-honorare') return held
        state.entries = state.entries.filter((entry) => entry.folderId !== decodeURIComponent(purge[1]))
        return Response.json({ status: 'purged', counts: COUNTS })
      }
      if (url === '/api/organization/deleted-folder-content') {
        if (init?.method === 'PUT') {
          await pause()
          state.policy = (JSON.parse(String(init.body)) as { policy: string }).policy
        }
        return Response.json({ policy: state.policy })
      }
      return real(input, init)
    }
  }
}

export default function PapierkorbDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-10 pb-12" data-testid="papierkorb-preview">
      <FolderBinPanel projectId={PROJECT} initial={{ ...LISTING, entries: state.entries }} />
      <section className="flex flex-col gap-3 px-4 sm:px-6">
        <h2 className="text-sm font-semibold">Organisation → Sensible Daten → „Inhalte aus gelöschten Ordnern“</h2>
        <DeletedFolderContentCard canEdit />
      </section>
      <section className="flex flex-col gap-2 px-4 sm:px-6">
        <h2 className="text-sm font-semibold">„Quelle gelöscht am …“ unter abgeleiteten Inhalten</h2>
        <p className="text-sm">Laut Werkvertrag ist die Abnahme bis 30. November vorgesehen. [1]</p>
        <SourceDeletedNote at="2026-10-18T09:12:00Z" />
        <p className="mt-3 text-sm">Notiz: Honorarzone III vereinbart.</p>
        <SourceDeletedNote at="2026-10-18T09:12:00Z" />
      </section>
    </main>
  )
}
