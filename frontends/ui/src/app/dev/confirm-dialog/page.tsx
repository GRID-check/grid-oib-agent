'use client'

/**
 * ConfirmDialog dev preview: the shared destructive-confirm primitive shown
 * open, so the confirm anatomy (tone icon, copy, button order) is screenshot-
 * reviewable. 404s outside development.
 */

import { notFound } from 'next/navigation'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

export default function ConfirmDialogPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  return (
    <main className="min-h-dvh bg-background px-4 py-10" data-testid="confirm-dialog-preview">
      <h1 className="mx-auto mb-6 max-w-lg font-mono text-xs text-muted-foreground">
        /dev/confirm-dialog — shared destructive confirm
      </h1>
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        tone="destructive"
        title="Zugangsdaten widerrufen?"
        description="Der Schlüssel wird dauerhaft aus dem Tresor entfernt. Laufende Chats fallen auf den Plattform-Modus zurück."
        confirmLabel="Widerrufen"
        cancelLabel="Abbrechen"
        onConfirm={() => {}}
      >
        <p className="text-sm text-muted-foreground">Dies kann nicht rückgängig gemacht werden.</p>
      </ConfirmDialog>
    </main>
  )
}
