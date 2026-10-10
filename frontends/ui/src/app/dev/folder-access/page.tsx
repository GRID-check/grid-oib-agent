'use client'

/**
 * Dev preview for read/write folder access in the project Files view
 * (ADR-0088, ADR-0097).
 *
 * The REAL `FileBrowserPane`, three times, as three people see one project:
 * a writer (Jana Weber, Projektleitung), a person who may only read two of the
 * folders (Tom Berger, Buchhaltung) and an organization admin. The lock on a
 * folder with its own list, saying in its tooltip whether every project member
 * reads it; „Nur lesen" on a folder the person may open but not change, whose
 * menu offers no write entries and which takes no drop; „Honorare" absent for
 * the two who may not read it. The admin's ⋯ menu carries „Zugriff…" and opens
 * the real `FolderAccessDialog`.
 *
 * A module-scope fetch shim (browser + dev only) serves the project's members
 * and each folder's list (`GET …/access`), answers the access PUT with three
 * documents moved, and applies the change to the fixture so the lock appears
 * or goes.
 *
 * `?dialog=custom` opens the dialog on „Verträge" (own list), and
 * `?dialog=inherit` on „Pläne" (inherits), for captures. Not linked from
 * anywhere and 404s outside development.
 */

import { projectSearchScope } from '@/features/documents/lib/file-shelf'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { notFound, useSearchParams } from 'next/navigation'

import type { FolderAccessSetting } from '@/adapters/api/folder-access-client'
import { FileBrowserPane, type FolderNavigation } from '@/features/documents/components/file-browser-pane'
import { FolderAccessDialog } from '@/features/documents/components/folder-access-dialog'
import type { FileItem, FolderItem } from '@/features/documents/components/project-file-workspace'
import { useFileSearch } from '@/features/documents/hooks/use-file-search'

/** `GET /api/projects/[id]/members`: the organization, each with their project role (null = none). */
const MEMBERS = [
  { userId: 'u-claudia', name: 'Claudia Hofer', email: 'c.hofer@buero.example', role: 'project-admin' },
  { userId: 'u-jana', name: 'Jana Weber', email: 'j.weber@buero.example', role: 'project-editor' },
  { userId: 'u-tom', name: 'Tom Berger', email: 't.berger@buero.example', role: 'project-editor' },
  { userId: 'u-lea', name: 'Lea Novak', email: 'l.novak@buero.example', role: 'project-viewer' },
  { userId: 'u-max', name: 'Max Aigner', email: 'm.aigner@buero.example', role: null },
].map((member) => ({ ...member, organizationMembershipId: `om-${member.userId}`, profilePictureUrl: null }))

/**
 * Each folder's own list (ADR-0097), as `GET …/access` answers it:
 *
 *   Pläne      — inherits the project
 *   Verträge   — Claudia Hofer: Bearbeiten, Jana Weber: Bearbeiten, Tom Berger: Lesen
 *   Honorare   — Claudia Hofer: Bearbeiten
 *   Statik     — alle Projektmitglieder lesen, Jana Weber: Bearbeiten
 */
const INITIAL_ACCESS: Record<string, FolderAccessSetting> = {
  'f-plaene': { mode: 'inherit' },
  'f-vertraege': {
    mode: 'custom',
    everyoneReads: false,
    people: [
      { userId: 'u-claudia', level: 'write' },
      { userId: 'u-jana', level: 'write' },
      { userId: 'u-tom', level: 'read' },
    ],
  },
  'f-honorare': { mode: 'custom', everyoneReads: false, people: [{ userId: 'u-claudia', level: 'write' }] },
  'f-statik': { mode: 'custom', everyoneReads: true, people: [{ userId: 'u-jana', level: 'write' }] },
}

/** The listing's view of a list: only whether everyone reads it. */
const ownAccessOf = (access: FolderAccessSetting | undefined): FolderItem['ownAccess'] =>
  access?.mode === 'custom' ? { everyoneReads: access.everyoneReads } : null

const folderRow = (id: string, name: string): FolderItem => ({
  id,
  parentId: null,
  name,
  path: `/${name}`,
  ownAccess: ownAccessOf(INITIAL_ACCESS[id]),
})

const INITIAL_FOLDERS: FolderItem[] = [
  folderRow('f-plaene', 'Pläne'),
  folderRow('f-vertraege', 'Verträge'),
  folderRow('f-honorare', 'Honorare'),
  folderRow('f-statik', 'Statik'),
]

/**
 * What three people see, as the server's listing would answer them: the
 * folders they may read, each with what they may do there. Fixed here rather
 * than computed, because the decision is the server's (`effectiveFolderLevel`)
 * and a preview that re-derived it would be a second copy of the rule.
 */
const PERSONAS = {
  writer: {
    title: 'Jana Weber (Projekt-Editor)',
    access: { 'f-plaene': 'write', 'f-vertraege': 'write', 'f-statik': 'write' },
  },
  reader: {
    title: 'Tom Berger (Projekt-Editor) — liest „Verträge“ und „Statik“ nur',
    access: { 'f-plaene': 'write', 'f-vertraege': 'read', 'f-statik': 'read' },
  },
  admin: {
    title: 'Organisations-Admin — darf überall alles',
    access: { 'f-plaene': 'write', 'f-vertraege': 'write', 'f-honorare': 'write', 'f-statik': 'write' },
  },
} as const satisfies Record<string, { title: string; access: Partial<Record<string, 'read' | 'write'>> }>

type Persona = keyof typeof PERSONAS

function foldersFor(persona: Persona, folders: readonly FolderItem[]): FolderItem[] {
  const access: Partial<Record<string, 'read' | 'write'>> = PERSONAS[persona].access
  return folders.flatMap((folder) => {
    const level = access[folder.id]
    return level ? [{ ...folder, access: level }] : []
  })
}

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

const state = { folders: INITIAL_FOLDERS.map((folder) => ({ ...folder })), access: { ...INITIAL_ACCESS } }

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __folderAccessShim?: boolean }
  if (!w.__folderAccessShim) {
    w.__folderAccessShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (/\/api\/projects\/[^/]+\/members$/.test(url)) return Response.json({ members: MEMBERS })
      const access = /\/api\/projects\/[^/]+\/folders\/([^/]+)\/access$/.exec(url)
      if (access) {
        const folderId = decodeURIComponent(access[1])
        await new Promise((resolve) => window.setTimeout(resolve, 400))
        if (init?.method !== 'PUT') return Response.json(state.access[folderId] ?? { mode: 'inherit' })
        const setting = JSON.parse(String(init.body)) as FolderAccessSetting
        state.access = { ...state.access, [folderId]: setting }
        state.folders = state.folders.map((folder) =>
          folder.id === folderId ? { ...folder, ownAccess: ownAccessOf(setting) } : folder
        )
        return Response.json({ folderId, access: setting, moved: 3, failed: [] })
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

  useEffect(() => {
    if (dialog === 'custom') setAccessFolderId('f-vertraege')
    if (dialog === 'inherit') setAccessFolderId('f-plaene')
  }, [dialog])

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 p-4 sm:p-6" data-testid="folder-access-preview">
      <div>
        <h1 className="text-lg font-semibold">Dateien — Lesen und Bearbeiten pro Ordner</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          ADR-0088: „Verträge“, „Honorare“ und „Statik“ haben eigene Zugriffsrechte. Hover a lock for what the list means;
          „Nur lesen“ marks a folder the person may open but not change. ⋯ → „Zugriff…“ edits the list.
        </p>
      </div>
      {(Object.keys(PERSONAS) as Persona[]).map((persona) => (
        <PersonaSection
          key={persona}
          persona={persona}
          folders={foldersFor(persona, folders)}
          onEditFolderAccess={persona === 'admin' ? setAccessFolderId : undefined}
        />
      ))}
      <FolderAccessDialog
        open={accessFolderId !== null}
        onOpenChange={(next) => !next && setAccessFolderId(null)}
        projectId="proj-demo"
        folder={folders.find((folder) => folder.id === accessFolderId) ?? null}
        onSaved={() => setFolders(state.folders)}
      />
    </main>
  )
}

function PersonaSection({
  persona,
  folders,
  onEditFolderAccess,
}: {
  persona: Persona
  folders: FolderItem[]
  onEditFolderAccess?: (folderId: string) => void
}): JSX.Element {
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)
  const search = useFileSearch(projectSearchScope('proj-demo'))
  const visible = new Set(folders.map((folder) => folder.id))
  const corpus = FILES.filter((item) => item.folderId === null || visible.has(item.folderId))
  const folderNav: FolderNavigation = {
    folders,
    currentFolderId,
    onNavigate: setCurrentFolderId,
    onCreateFolder: async () => false,
    onRenameFolder: async () => true,
    onDeleteFolder: async () => true,
    onEditFolderAccess,
    rootAccess: 'write',
  }
  return (
    <section className="flex flex-col gap-2" data-testid={`folder-access-${persona}`}>
      <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
        {PERSONAS[persona].title}
      </h2>
      <div className="flex flex-col overflow-hidden rounded-xl border">
        <FileBrowserPane
          files={corpus.filter((item) => (item.folderId ?? null) === currentFolderId)}
          searchFiles={corpus}
          selectedFileId={null}
          onSelectFile={() => {}}
          isLoading={false}
          search={search}
          view="cards"
          folderNav={folderNav}
          onDropDocumentInFolder={() => {}}
          onDropFolderInFolder={() => {}}
          onPickFiles={() => {}}
          uploadCard={<div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">Hochladen</div>}
        />
      </div>
    </section>
  )
}
