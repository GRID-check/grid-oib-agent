'use client'

import type { MissingDocument } from '@/lib/document-roles/prompt-loader'

/**
 * Dev preview for the folder brief („Was Piloti hier weiß") and the read state
 * on folder tiles — the real `FolderBrief` and `FolderCard`, over the
 * „Wohnbau Seestadt Nord" corpus in `fixtures.ts`.
 *
 * Six sections, one per state the brief has to show: the project root, a
 * nested folder with failures, the collapsed header, a folder where everything
 * is read (no „Needs you"), the office shelf's root, and the folder tiles with
 * their subtree read state. `?section=a|b|c|d|e|f` shows just one of them, for
 * captures; the default shows all six.
 *
 * "Alle erneut lesen" is faked here: it steps a progress object to completion
 * on a timer and changes no document, so the button's busy state can be seen
 * without a backend.
 *
 * Not linked from anywhere and 404s outside development.
 */

import type { JSX, ReactNode } from 'react'
import { Suspense, useEffect, useRef, useState } from 'react'
import { notFound, useSearchParams } from 'next/navigation'
import { FolderBrief } from '@/features/documents/components/folder-brief'
import { FolderCard } from '@/features/documents/components/folder-navigation'
import { buildFolderBrief, subtreeTallies } from '@/features/documents/lib/folder-knowledge'
import type { BulkReingestProgress } from '@/features/documents/hooks/use-bulk-reingest'
import { FILES, FOLDERS, PROJECT_NAME } from './fixtures'

const SECTIONS = ['a', 'b', 'c', 'd', 'e', 'f'] as const
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
