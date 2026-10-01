'use client'

/**
 * Dev preview for folder access in the project Files view (ADR-0078).
 *
 * The REAL `FileBrowserPane`, in the card grid and in the detail list, with a
 * folder tree where two folders are restricted: the lock on their tile, and
 * its tooltip naming the roles. Every folder's ⋯ menu carries „Zugriff…", as it
 * does for a reader holding `project:manage`, and opens the real
 * `FolderAccessDialog`.
 *
 * A module-scope fetch shim (browser + dev only) serves the organization's
 * roles and answers the access PUT with three documents moved, and applies the
 * change to the fixture so the lock appears or goes.
 *
 * `?dialog=restricted` opens the dialog on „Verträge" (restricted), and
 * `?dialog=open` on „Pläne" (open), for captures. Not linked from anywhere and
 * 404s outside development.
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { notFound, useSearchParams } from 'next/navigation'

import type { OrganizationRoles } from '@/adapters/api/organization-roles-client'
import { FileBrowserPane, type FolderNavigation } from '@/features/documents/components/file-browser-pane'
import { FolderAccessDialog } from '@/features/documents/components/folder-access-dialog'
import type { FileItem, FolderItem } from '@/features/documents/components/project-file-workspace'
import { useFileSearch } from '@/features/documents/hooks/use-file-search'
import { roleNamesFor, useOrganizationRoles } from '@/features/organization/hooks/use-organization-roles'

const ROLES: OrganizationRoles = {
  roles: [
    { slug: 'admin', name: 'Admin', description: null, custom: false },
    { slug: 'member', name: 'Member', description: null, custom: false },
    { slug: 'org-geschaeftsfuehrung', name: 'Geschäftsführung', description: null, custom: true },
    { slug: 'org-projektleitung', name: 'Projektleitung', description: null, custom: true },
    { slug: 'org-buchhaltung', name: 'Buchhaltung', description: null, custom: true },
  ],
  assignable: null,
}

const INITIAL_FOLDERS: FolderItem[] = [
  { id: 'f-plaene', parentId: null, name: 'Pläne', path: '/Pläne', restrictedRoles: null },
  {
    id: 'f-vertraege',
    parentId: null,
    name: 'Verträge',
    path: '/Verträge',
    restrictedRoles: ['org-geschaeftsfuehrung', 'org-projektleitung'],
  },
  {
    id: 'f-honorare',
    parentId: null,
    name: 'Honorare',
    path: '/Honorare',
    restrictedRoles: ['org-geschaeftsfuehrung'],
  },
  { id: 'f-statik', parentId: null, name: 'Statik', path: '/Statik', restrictedRoles: null },
]

const file = (id: string, filename: string, folderId: string | null, summary: string): FileItem => ({
  id,
  filename,
  displayName: null,
  fileSize: 1_800_000,
  contentType: 'application/pdf',
  status: 'ready',
  folderId,
  createdAt: '2026-09-28T09:00:00Z',
  errorMessage: null,
  summary,
  pageCount: 12,
  chunkCount: 30,
  contentTypes: ['text'],
  tags: null,
})

const FILES: FileItem[] = [
  file('d1', 'Werkvertrag_Zimmerei.pdf', 'f-vertraege', 'Werkvertrag mit der Zimmerei Huber.'),
  file('d2', 'Honorarvereinbarung_2026.pdf', 'f-honorare', 'Honorarvereinbarung mit dem Bauherrn.'),
  file('d3', 'Grundriss_EG.pdf', 'f-plaene', 'Grundriss Erdgeschoss.'),
  file('d4', 'Baubeschreibung.pdf', null, 'Baubeschreibung des Wohnbaus Nord.'),
]

const state = { folders: INITIAL_FOLDERS.map((folder) => ({ ...folder })) }

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __folderAccessShim?: boolean }
  if (!w.__folderAccessShim) {
    w.__folderAccessShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/organization/roles')) return Response.json(ROLES)
      const access = /\/api\/projects\/[^/]+\/folders\/([^/]+)\/access$/.exec(url)
      if (access && init?.method === 'PUT') {
        const folderId = decodeURIComponent(access[1])
        const { roles } = JSON.parse(String(init.body)) as { roles: string[] | null }
        state.folders = state.folders.map((folder) =>
          folder.id === folderId ? { ...folder, restrictedRoles: roles } : folder
        )
        await new Promise((resolve) => window.setTimeout(resolve, 400))
        return Response.json({ folderId, roles, moved: 3, failed: [] })
      }
      if (url.includes('/thumbnail')) return new Response(null, { status: 404 })
      return real(input, init)
    }
  }
}

export default function FolderAccessDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  return <FolderAccessPreview />
}

function FolderAccessPreview(): JSX.Element {
  const dialog = useSearchParams()?.get('dialog')
  const [folders, setFolders] = useState<FolderItem[]>(state.folders)
  const [accessFolderId, setAccessFolderId] = useState<string | null>(null)
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)
  const roles = useOrganizationRoles()
  const search = useFileSearch({ projectId: 'proj-demo' })

  useEffect(() => {
    if (dialog === 'restricted') setAccessFolderId('f-vertraege')
    if (dialog === 'open') setAccessFolderId('f-plaene')
  }, [dialog])

  const roleNames = useCallback((slugs: readonly string[]) => roleNamesFor(slugs, roles.data), [roles.data])

  const folderNav: FolderNavigation = {
    folders,
    currentFolderId,
    onNavigate: setCurrentFolderId,
    onCreateFolder: async () => false,
    onRenameFolder: async () => true,
    onDeleteFolder: async () => true,
    onEditFolderAccess: setAccessFolderId,
    roleNames,
  }
  const levelFiles = FILES.filter((item) => (item.folderId ?? null) === currentFolderId)

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 p-4 sm:p-6" data-testid="folder-access-preview">
      <div>
        <h1 className="text-lg font-semibold">Dateien — Ordnerzugriff</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          ADR-0078: „Verträge“ and „Honorare“ are restricted to roles. Hover a lock for the roles; ⋯ → „Zugriff…“
          changes them.
        </p>
      </div>
      {(['cards', 'list'] as const).map((view) => (
        <section key={view} className="flex flex-col gap-2">
          <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">{view}</h2>
          <div className="flex flex-col overflow-hidden rounded-xl border" data-testid={`folder-access-${view}`}>
            <FileBrowserPane
              files={levelFiles}
              searchFiles={FILES}
              selectedFileId={null}
              onSelectFile={() => {}}
              isLoading={false}
              search={search}
              view={view}
              folderNav={folderNav}
            />
          </div>
        </section>
      ))}
      <FolderAccessDialog
        open={accessFolderId !== null}
        onOpenChange={(next) => !next && setAccessFolderId(null)}
        projectId="proj-demo"
        folder={folders.find((folder) => folder.id === accessFolderId) ?? null}
        roles={roles.data}
        rolesFailed={roles.failed}
        onRetryRoles={() => void roles.reload()}
        onSaved={() => setFolders(state.folders)}
      />
    </main>
  )
}
