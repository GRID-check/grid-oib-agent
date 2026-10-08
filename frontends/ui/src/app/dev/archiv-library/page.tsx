'use client'

/**
 * Dev preview for the org Archiv — the real {@link ArchivWorkspace}, with folders,
 * over fixtures, in the raised frame the real sheet renders.
 *
 * Nothing leaves the browser: a module-scope fetch shim answers the Archiv's
 * listing and folder routes from the arrays below (and keeps creates, renames,
 * moves and deletes in memory so the whole gesture set can be exercised), 404s
 * thumbnails so the SVG sketch fallback renders, and acknowledges uploads.
 *
 * States, by query string:
 *   (none)            a manager's Archiv, three folders deep, tagged documents
 *   ?folder=<id>      inside a folder (`f-plan`, `f-plan-eg`, `f-recht`)
 *   ?state=readonly   a member without `org:archiv:manage`: folders, search,
 *                     filters and preview, and nothing that mutates
 *   ?state=loading    the skeleton, held there
 *   ?state=empty      a first-run Archiv
 *
 * The return trail is seeded with a project visit, so the back control shows
 * what it shows in the app — the NAME of the project the reader came out of.
 * 404s outside development.
 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
// Imported from the module, not the shell barrel: the barrel also exports the
// server-only OrgTopbar, which would drag `@/i18n/server` into this client page.
import { BackLink } from '@/components/shell/back-link'
import { writeTrail } from '@/lib/navigation/return-trail'
import { ArchivWorkspace } from '@/features/documents/components/archiv-workspace'
import type { FileItem, FolderItem } from '@/features/documents/file-types'

function makeFile(
  id: string,
  filename: string,
  summary: string,
  tags: string[],
  folderId: string | null,
  extra: Partial<FileItem> = {}
): FileItem {
  return {
    id,
    filename,
    displayName: null,
    fileSize: 2_400_000,
    contentType: 'application/pdf',
    status: 'ready',
    folderId,
    createdAt: '2026-06-14T09:00:00Z',
    errorMessage: null,
    summary,
    pageCount: 24,
    chunkCount: 48,
    contentTypes: ['text', 'table'],
    tags,
    ...extra,
  }
}

const folder = (id: string, name: string, path: string, parentId: string | null): FolderItem => ({
  id,
  parentId,
  name,
  path,
  createdAt: '2026-06-01T09:00:00Z',
  updatedAt: '2026-06-10T09:00:00Z',
})

const FOLDERS: FolderItem[] = [
  folder('f-plan', 'Planung', 'Planung', null),
  folder('f-plan-eg', 'Erdgeschoss', 'Planung/Erdgeschoss', 'f-plan'),
  folder('f-recht', 'Baurecht', 'Baurecht', null),
]

const FILES: FileItem[] = [
  makeFile('a1', 'Referenzprojekt_Stadthaus-Wien.pdf', 'Vergleichbares Wohngebäude der GK 4.', ['Wohnbau', 'Referenz'], null),
  makeFile('a2', 'Detailkatalog_Treppen.pdf', 'Regeldetails für Treppenläufe und Geländer.', ['Detail', 'Treppen'], 'f-plan'),
  makeFile('a3', 'Brandschutz-Musterkonzept.pdf', 'Musterkonzept Brandschutz für GK 4–5.', ['Brandschutz', 'Muster'], 'f-recht'),
  makeFile('a4', 'Fassadendetails_Nord.png', 'Fassadendetails Nordansicht.', ['Detail', 'Fassade'], 'f-plan-eg', {
    contentType: 'image/png',
  }),
  makeFile('a5', 'Statik_Standardpositionen.pdf', 'Standard-Statikpositionen und Lastannahmen.', ['Statik'], null),
  makeFile('a6', 'Ausschreibung_Vorlage.docx', 'Ausschreibungsvorlage Rohbau.', ['Ausschreibung', 'Vorlage'], 'f-plan', {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }),
]

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** The fixture routes, answered from memory. `null` hands the request on. */
function answer(url: string, method: string, state: { files: FileItem[]; folders: FolderItem[] }): Response | null {
  const path = new URL(url, window.location.origin).pathname
  if (/\/api\/documents\/.+\/thumbnail$/.test(path)) return new Response(null, { status: 404 })
  if (path === '/api/archiv/documents' && method === 'GET') {
    return json({ documents: state.files, collectionName: 'archiv_dev', canManage: true })
  }
  if (path === '/api/archiv/folders' && method === 'GET') return json({ folders: state.folders })
  if (path === '/api/archiv/folders' && method === 'POST') {
    const created = folder(`f-${state.folders.length + 1}`, 'Neuer Ordner', 'Neuer Ordner', null)
    state.folders = [...state.folders, created]
    return json({ folder: created }, 201)
  }
  if (path.startsWith('/api/archiv/folders/') || path.endsWith('/folder')) return json({ ok: true, documentsMoved: 0, foldersMoved: 0 })
  return null
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  // Seed the tab's return trail at module scope — before the first render, so
  // the back control reads it on its own first effect.
  writeTrail([
    { path: '/app/projects/p1/files', label: 'Stadthaus Wien' },
    { path: window.location.pathname },
  ])

  const w = window as unknown as { __archivShim?: boolean }
  if (!w.__archivShim) {
    w.__archivShim = true
    const real = window.fetch.bind(window)
    const params = new URLSearchParams(window.location.search)
    const memory = {
      files: params.get('state') === 'empty' ? [] : FILES,
      folders: params.get('state') === 'empty' ? [] : FOLDERS,
    }
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      // `?state=loading` holds the listing in flight for good: the skeleton is the evidence.
      if (params.get('state') === 'loading' && url.includes('/api/archiv/')) return new Promise<Response>(() => {})
      return answer(url, init?.method ?? 'GET', memory) ?? real(input, init)
    }
  }
}

export default function ArchivLibraryDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  // Read after mount (not during render) so the fixture is identical on server
  // and client — the same rule the other /dev previews follow.
  const [readOnly, setReadOnly] = useState(false)
  useEffect(() => {
    setReadOnly(new URLSearchParams(window.location.search).get('state') === 'readonly')
  }, [])

  return (
    <main className="mx-auto flex max-w-6xl flex-col p-6">
      <BackLink fallbackHref="/app/projects" fallbackLabel="Back to projects" />
      <div className="shadow-xs mt-3 flex h-[820px] flex-col overflow-hidden rounded-xl border">
        <ArchivWorkspace canManage={!readOnly} />
      </div>
    </main>
  )
}
