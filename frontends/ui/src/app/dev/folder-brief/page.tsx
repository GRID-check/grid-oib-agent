'use client'

import type { MissingDocument } from '@/lib/document-roles/prompt-loader'

/**
 * Dev preview for the folder brief („Was Piloti hier weiß") and the read state
 * on folder tiles — the real `FolderBrief` and `FolderCard`, over the
 * „Wohnbau Seestadt Nord" corpus in `fixtures.ts`.
 *
 * Seven sections, one per state the brief has to show: the project root, a
 * nested folder with failures, the collapsed header, a folder where everything
 * is read (no „Needs you"), the office shelf's root, the folder tiles with
 * their subtree read state, and Fassungen — the brief's series with a working
 * „Bestätigen" beside the preview's Fassungen panel in its three states.
 * `?section=a|b|c|d|e|f|g` shows just one of them, for captures; the default
 * shows all seven.
 *
 * "Alle erneut lesen" is faked here: it steps a progress object to completion
 * on a timer and changes no document, so the button's busy state can be seen
 * without a backend. „Bestätigen" is faked the same way: it links the series in
 * local state only. The panel's own buttons call the real route and fail here.
 *
 * Not linked from anywhere and 404s outside development.
 */

import type { JSX, ReactNode } from 'react'
import { Suspense, useEffect, useRef, useState } from 'react'
import { notFound, useSearchParams } from 'next/navigation'
import { FolderBrief } from '@/features/documents/components/folder-brief'
import { FolderCard } from '@/features/documents/components/folder-navigation'
import { FassungPanel } from '@/features/documents/components/fassung-panel'
import { buildFolderBrief, subtreeTallies } from '@/features/documents/lib/folder-knowledge'
import type { FileItem } from '@/features/documents/file-types'
import type { RevisionSeries } from '@/features/documents/lib/revision-series'
import { EMPTY_FASSUNG } from '@/lib/documents/fassung'
import type { BulkReingestProgress } from '@/features/documents/hooks/use-bulk-reingest'
import { FILES, FOLDERS, PROJECT_NAME } from './fixtures'

const SECTIONS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const
type SectionId = (typeof SECTIONS)[number]

const ROOT_BRIEF = buildFolderBrief(FILES, FOLDERS, null)
const EINREICHUNG_BRIEF = buildFolderBrief(FILES, FOLDERS, 'f-03')
const GRUNDLAGEN_BRIEF = buildFolderBrief(FILES, FOLDERS, 'f-01')
const TALLIES = subtreeTallies(FILES, FOLDERS)
const ROOT_FOLDERS = FOLDERS.filter((folder) => folder.parentId === null)

const noop = (): void => {}
const resolveFalse = (): Promise<boolean> => Promise.resolve(false)

/** How many re-reads the fake batch runs, and how often one answers. */
const READ_AGAIN_TICK_MS = 450

/**
 * The root brief with REAL local state for the collapse toggle, and a fake
 * re-read that walks `progress` from 0 to the failed count and then clears it.
 * Every fourth answer is a refusal, so the progress object carries both numbers.
 */
function LiveRootBrief(): JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const [progress, setProgress] = useState<BulkReingestProgress | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) clearInterval(timer.current)
    },
    []
  )

  const onReadAgain = (): void => {
    if (timer.current !== null) return
    const total = ROOT_BRIEF.attention.failed.length
    let done = 0
    let failed = 0
    setProgress({ total, done, failed })
    timer.current = setInterval(() => {
      done += 1
      if (done % 4 === 0) failed += 1
      if (done < total) {
        setProgress({ total, done, failed })
        return
      }
      if (timer.current !== null) clearInterval(timer.current)
      timer.current = null
      setProgress(null)
    }, READ_AGAIN_TICK_MS)
  }

  return (
    <FolderBrief
      brief={ROOT_BRIEF}
      folderName={null}
      shelfKind="project"
      onSelect={noop}
      onOpenFolder={noop}
      onReadAgain={onReadAgain}
      readAgainProgress={progress}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
      missing={MISSING}
    />
  )
}

/** What the intake answers would expect of this project — `loadMissingDocuments`' shape. */
const MISSING: readonly MissingDocument[] = [
  { role: 'grundbuchauszug', label: 'Grundbuchauszug', bauwerkName: null },
  { role: 'gutachten_baugrund', label: 'Baugrundgutachten', bauwerkName: null },
  { role: 'bestandsplan', label: 'Bestandspläne', bauwerkName: 'Hoftrakt' },
]

function Section({ id, title, children }: { id: SectionId; title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-3" data-testid={`section-${id}`} aria-labelledby={`section-${id}-title`}>
      <h2 id={`section-${id}-title`} className="text-muted-foreground text-xs font-medium uppercase tracking-[0.05em]">
        {title}
      </h2>
      {children}
    </section>
  )
}

/** The direct documents and subfolders a folder's count line names. */
function itemCountOf(folderId: string): number {
  const documents = FILES.filter((file) => file.folderId === folderId).length
  const subfolders = FOLDERS.filter((folder) => folder.parentId === folderId).length
  return documents + subfolders
}

function FolderTiles(): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {ROOT_FOLDERS.map((folder) => (
        <FolderCard
          key={folder.id}
          folder={folder}
          itemCount={itemCountOf(folder.id)}
          lastModified={TALLIES.get(folder.id)?.latest ?? null}
          knowledge={TALLIES.get(folder.id)}
          onOpen={noop}
          onRenameFolder={resolveFalse}
          onDeleteFolder={resolveFalse}
        />
      ))}
    </div>
  )
}

const byId = (id: string): FileItem => FILES.find((file) => file.id === id)!

/** A differently named upload Piloti read and took for a newer Fassung of Index C. */
const SUGGESTED: FileItem = {
  ...byId('d-03-02'),
  id: 'd-03-new',
  filename: 'Erdgeschoss_Einreichung_final.pdf',
  createdAt: '2026-09-30T10:00:00Z',
  summary: 'Grundriss Erdgeschoß zur Einreichung mit Fluchtwegen, Brandabschnitten, Stellplatzzufahrt und geändertem Müllraum.',
  fassung: {
    ...EMPTY_FASSUNG,
    suggestion: {
      of: { id: 'd-03-02', filename: 'EG_Grundriss_Index_C_2026-08-14.pdf' },
      confidence: 0.86,
      reason: 'Gleiches Geschoß und gleicher Inhalt; zusätzlich ein geänderter Müllraum.',
      basis: 'content',
    },
  },
}

/** Index C after a person confirmed it replaces Index B. */
const CONFIRMED: FileItem = {
  ...byId('d-03-02'),
  fassung: {
    ...EMPTY_FASSUNG,
    supersedes: [{ id: 'd-03-alt-1', filename: 'EG_Grundriss_Index_B_2026-07-02.pdf' }],
    changeSummary: {
      text: '- Stellplatzzufahrt neu an der Nordseite\n- Brandabschnitt zwischen Stiege A und Tiefgarage verschoben\n- Index und Datum aktualisiert',
      basis: { id: 'd-03-alt-1', filename: 'EG_Grundriss_Index_B_2026-07-02.pdf' },
    },
  },
}

/** Index B, replaced. */
const SUPERSEDED: FileItem = {
  ...byId('d-03-alt-1'),
  fassung: { ...EMPTY_FASSUNG, supersededBy: { id: 'd-03-02', filename: 'EG_Grundriss_Index_C_2026-08-14.pdf' } },
}

/** The 03_Einreichung brief with a „Bestätigen" that links a series in local state. */
function LiveFassungBrief(): JSX.Element {
  const [files, setFiles] = useState<FileItem[]>(FILES)
  const brief = buildFolderBrief(files, FOLDERS, 'f-03')
  const confirm = async (series: RevisionSeries<FileItem>): Promise<void> => {
    const head = series.current.item
    const older = new Set(series.older.map((member) => member.item.id))
    await new Promise((resolve) => setTimeout(resolve, 400))
    setFiles((current) =>
      current.map((file) =>
        older.has(file.id)
          ? { ...file, fassung: { ...EMPTY_FASSUNG, supersededBy: { id: head.id, filename: head.filename } } }
          : file
      )
    )
  }
  return (
    <FolderBrief
      brief={brief}
      folderName="03_Einreichung"
      shelfKind="project"
      onSelect={noop}
      onOpenFolder={noop}
      collapsed={false}
      onCollapsedChange={noop}
      onConfirmSeries={confirm}
    />
  )
}

function FassungPanels(): JSX.Element {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {[
        { label: 'Vorschlag (anderer Name)', file: SUGGESTED },
        { label: 'Bestätigt, mit Änderungen', file: CONFIRMED },
        { label: 'Ersetzt', file: SUPERSEDED },
      ].map(({ label, file }) => (
        <div key={file.id} className="bg-card flex flex-col gap-2 rounded-lg border p-4">
          <p className="text-muted-foreground text-xs">
            {label} · {file.filename}
          </p>
          <FassungPanel file={file} canManage />
        </div>
      ))}
    </div>
  )
}

function FolderBriefPreview(): JSX.Element {
  const requested = useSearchParams()?.get('section')
  const only = SECTIONS.find((id) => id === requested) ?? null
  const shows = (id: SectionId): boolean => only === null || only === id

  return (
    <main className="min-h-dvh bg-background">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-4 py-8 sm:px-6">
        {only === null && (
          <header className="flex flex-col gap-1">
            <p className="text-muted-foreground text-xs">Dev-Vorschau · {PROJECT_NAME}</p>
            <h1 className="text-foreground text-xl font-semibold tracking-[-0.01em]">Ordner-Überblick</h1>
          </header>
        )}

        {shows('a') && (
          <Section id="a" title="Root (project)">
            <LiveRootBrief />
          </Section>
        )}

        {shows('b') && (
          <Section id="b" title="Folder 03_Einreichung">
            <FolderBrief
              brief={EINREICHUNG_BRIEF}
              folderName="03_Einreichung"
              shelfKind="project"
              onSelect={noop}
              onOpenFolder={noop}
              onReadAgain={noop}
              collapsed={false}
              onCollapsedChange={noop}
            />
          </Section>
        )}

        {shows('c') && (
          <Section id="c" title="Collapsed">
            <FolderBrief
              brief={ROOT_BRIEF}
              folderName={null}
              shelfKind="project"
              onSelect={noop}
              onOpenFolder={noop}
              onReadAgain={noop}
              collapsed
              onCollapsedChange={noop}
            />
          </Section>
        )}

        {shows('d') && (
          <Section id="d" title="Everything read">
            <FolderBrief
              brief={GRUNDLAGEN_BRIEF}
              folderName="01_Grundlagen"
              shelfKind="project"
              onSelect={noop}
              onOpenFolder={noop}
              collapsed={false}
              onCollapsedChange={noop}
            />
          </Section>
        )}

        {shows('e') && (
          <Section id="e" title="Office shelf root">
            {/* No re-read here: the office shelf is shown to readers who may not write to it. */}
            <FolderBrief
              brief={ROOT_BRIEF}
              folderName={null}
              shelfKind="office"
              onSelect={noop}
              onOpenFolder={noop}
              collapsed={false}
              onCollapsedChange={noop}
            />
          </Section>
        )}

        {shows('f') && (
          <Section id="f" title="Folder tiles">
            <FolderTiles />
          </Section>
        )}

        {shows('g') && (
          <Section id="g" title="Fassungen">
            <LiveFassungBrief />
            <FassungPanels />
          </Section>
        )}
      </div>
    </main>
  )
}

export default function FolderBriefDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  // `useSearchParams` needs a Suspense boundary in the app router.
  return (
    <Suspense fallback={<div />}>
      <FolderBriefPreview />
    </Suspense>
  )
}
