'use client'

/**
 * Dev preview for the file operations — the two decisions a document's overflow
 * menu leads to, and the trigger they hang off.
 *
 * Both dialogs are controlled, so they render open with fixture state and
 * nothing to click: `?variant=rename` (the default) shows the rename form on a
 * document that has ALREADY been renamed, so the recovery affordance is in
 * frame; `?variant=delete` shows the shared destructive confirm that replaced
 * the old inline red block in the preview's metadata rail.
 *
 * `?variant=move` opens the folder submenu instead: the destinations a document
 * can be re-filed into, each named by its whole path, with a check on the one it
 * is in now. `?variant=moved` goes one step further and PICKS one, printing what
 * came back: jsdom never delivers a synthetic click to a submenu item, so this
 * fixture is the only place the selection itself can be seen working.
 *
 * Behind both, the resting state of the trigger in a header row like the file
 * preview's — the control has to read as an ordinary, ignorable part of the
 * chrome until it is wanted.
 *
 * Not linked from anywhere and 404s outside development.
 */

import { notFound, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { DocumentActionsMenu } from '@/features/documents/components/document-actions'
import { RenameDocumentDialog } from '@/features/documents/components/document-actions/rename-document-dialog'

const DOCUMENT = {
  id: 'dev-doc-1',
  filename: 'Brandschutzkonzept_Wohnbau-Nord_GK4.pdf',
  displayName: 'Brandschutzkonzept Wohnbau Nord.pdf',
  folderId: 'f-brand',
}

/** A nested tree, so the submenu has a path to render and not just a name. */
const FOLDERS = [
  { id: 'f-brand', name: 'Brandschutz', parentId: null },
  { id: 'f-flucht', name: 'Fluchtwege', parentId: 'f-brand' },
  { id: 'f-statik', name: 'Statik', parentId: null },
  { id: 'f-arch', name: 'Architektur', parentId: null },
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __documentActionsShim?: boolean }
  if (!w.__documentActionsShim) {
    w.__documentActionsShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (/\/api\/documents\/[^/]+\/folder$/.test(url)) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { folderId?: string | null }
        return Response.json({ id: 'dev-doc-1', folderId: body.folderId ?? null })
      }
      return real(input, init)
    }
  }
}

/**
 * Drive the menu open, and optionally pick a destination.
 *
 * Keyboard, not `.click()`: the trigger opens on pointerdown, which a synthetic
 * click never produces, and Enter on a submenu trigger both opens it and lands
 * focus on its first item. Guarded by a ref because `reactStrictMode` runs an
 * effect twice and Enter TOGGLES.
 */
function useOpenMoveMenu(pick: boolean): void {
  const driven = useRef(false)
  useEffect(() => {
    if (driven.current) return
    driven.current = true
    const press = (node: Element | null) =>
      node?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="document-actions-trigger"]')
    if (!trigger) return
    trigger.focus()
    press(trigger)
    window.requestAnimationFrame(() => {
      const sub = document.querySelector<HTMLElement>('[data-testid="document-action-move"]')
      sub?.focus()
      press(sub)
      if (!pick) return
      window.requestAnimationFrame(() => {
        const items = Array.from(
          document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-sub-content"] [role="menuitem"]')
        )
        const statik = items.find((item) => item.textContent?.trim() === 'Statik')
        statik?.focus()
        // A real pointer click: this is the path a user takes, and the one
        // jsdom cannot reproduce for a submenu item.
        statik?.click()
      })
    })
  }, [pick])
}

/** The preview pane's header row, close enough to show the trigger in context. */
function HeaderRow({ onMoved }: { onMoved?: (id: string, folderId: string | null) => void }): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-[720px] items-center gap-3 rounded-2xl border bg-card px-5 py-3.5 shadow-2xs">
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-[10px] font-bold uppercase leading-none text-muted-foreground"
        aria-hidden
      >
        PDF
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-[15px] font-semibold leading-tight tracking-[-0.01em] text-foreground">
          {DOCUMENT.displayName}
        </h3>
        <p className="mt-1 truncate text-[11.5px] text-muted-foreground">PDF · Bereit</p>
      </div>
      <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 gap-1.5 px-3">
        <Download className="size-3.5" aria-hidden />
        Herunterladen
      </Button>
      <DocumentActionsMenu
        document={DOCUMENT}
        scope="files"
        actions={['rename', 'move', 'delete']}
        folders={FOLDERS}
        onMoved={onMoved ?? (() => {})}
      />
    </div>
  )
}

function DocumentActionsPreview(): JSX.Element {
  const variant = useSearchParams()?.get('variant') ?? 'rename'
  const isMove = variant === 'move' || variant === 'moved'
  const [moved, setMoved] = useState<string | null>(null)
  useOpenMoveMenu(variant === 'moved')

  return (
    <div className="flex min-h-dvh flex-col justify-center bg-muted/30 p-8" data-testid="document-actions-preview">
      <HeaderRow onMoved={isMove ? (id, folderId) => setMoved(`${id} → ${folderId ?? 'root'}`) : undefined} />

      {moved && (
        // The proof, in text: the selection reached `onMoved` with the folder
        // it was given. Without this the shot only shows a menu being open.
        <p className="mx-auto mt-4 text-sm text-muted-foreground" data-testid="document-moved-result">
          onMoved: {moved}
        </p>
      )}

      {isMove ? null : variant === 'delete' ? (
        <ConfirmDialog
          open
          onOpenChange={() => {}}
          title={`„${DOCUMENT.displayName}“ löschen?`}
          description="Dadurch wird das Dokument aus diesem Projekt entfernt. Dies kann nicht rückgängig gemacht werden."
          confirmLabel="Löschen"
          cancelLabel="Abbrechen"
          onConfirm={() => {}}
        />
      ) : (
        <RenameDocumentDialog
          open
          onOpenChange={() => {}}
          document={DOCUMENT}
          scope="files"
          onRename={() => Promise.resolve(false)}
        />
      )}
    </div>
  )
}

export default function DocumentActionsDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  // `useSearchParams` needs a Suspense boundary in the app router.
  return (
    <Suspense fallback={<div />}>
      <DocumentActionsPreview />
    </Suspense>
  )
}
