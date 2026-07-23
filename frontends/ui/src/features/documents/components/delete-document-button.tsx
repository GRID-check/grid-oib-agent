'use client'

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'

interface DeleteDocumentButtonProps {
  fileId: string
  filename: string
  onDeleted: (fileId: string) => void
  /** DELETE endpoint — project docs and Archiv docs differ only here. */
  deleteUrl: string
  /** i18n namespace holding the `delete.*` keys ('files' or 'archiv'). */
  namespace: 'files' | 'archiv'
}

/**
 * Two-step Delete affordance for a document: the first click reveals an inline
 * Confirm/Cancel row so a stray tap can't purge a document. Shared by the Files
 * and Archiv workspaces, which used to hand-roll this identical control — they
 * differ only in the DELETE endpoint and the i18n namespace.
 */
export function DeleteDocumentButton({ fileId, filename, onDeleted, deleteUrl, namespace }: DeleteDocumentButtonProps) {
  const t = useTranslations(namespace)
  const [confirming, setConfirming] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const handleDelete = useCallback(async () => {
    setIsDeleting(true)
    try {
      const res = await fetch(deleteUrl, { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`)
      toast.success(t('delete.success', { name: filename }))
      onDeleted(fileId)
    } catch {
      toast.error(t('delete.error'))
      setIsDeleting(false)
      setConfirming(false)
    }
  }, [deleteUrl, fileId, filename, onDeleted, t])

  if (!confirming) {
    return (
      <Button
        type="button"
        variant="ghost"
        className="mt-2 w-full gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={() => setConfirming(true)}
      >
        <Trash2 className="size-4" aria-hidden />
        {t('delete.action')}
      </Button>
    )
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <p className="text-xs text-muted-foreground">{t('delete.confirm')}</p>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="flex-1 gap-1.5"
          onClick={handleDelete}
          disabled={isDeleting}
        >
          <Trash2 className="size-3.5" aria-hidden />
          {isDeleting ? t('delete.deleting') : t('delete.confirmAction')}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(false)} disabled={isDeleting}>
          {t('delete.cancel')}
        </Button>
      </div>
    </div>
  )
}
