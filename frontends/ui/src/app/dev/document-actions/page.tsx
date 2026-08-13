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
 * Behind both, the resting state of the trigger in a header row like the file
 * preview's — the control has to read as an ordinary, ignorable part of the
 * chrome until it is wanted.
 *
 * Not linked from anywhere and 404s outside development.
 */

import { notFound, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { DocumentActionsMenu } from '@/features/documents/components/document-actions'
import { RenameDocumentDialog } from '@/features/documents/components/document-actions/rename-document-dialog'

const DOCUMENT = {
  id: 'dev-doc-1',
  filename: 'Brandschutzkonzept_Wohnbau-Nord_GK4.pdf',
  displayName: 'Brandschutzkonzept Wohnbau Nord.pdf',
}

/** The preview pane's header row, close enough to show the trigger in context. */
function HeaderRow(): JSX.Element {
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
      <DocumentActionsMenu document={DOCUMENT} scope="files" actions={['rename', 'delete']} />
    </div>
  )
}

function DocumentActionsPreview(): JSX.Element {
  const variant = useSearchParams()?.get('variant') ?? 'rename'

  return (
    <div className="flex min-h-dvh flex-col justify-center bg-muted/30 p-8" data-testid="document-actions-preview">
      <HeaderRow />

      {variant === 'delete' ? (
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
