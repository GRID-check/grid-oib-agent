/**
 * DeleteAllSessionsConfirmationModal Component
 *
 * Confirmation dialog displayed before deleting all sessions.
 * Shows a warning message and requires explicit confirmation.
 */

'use client'

import { type FC } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslations } from '@/i18n'

export interface DeleteAllSessionsConfirmationModalProps {
  /** Whether the modal is open */
  open: boolean
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void
  /** Callback when delete is confirmed */
  onConfirm: () => void
  /** Number of sessions that will be deleted, shown in the dialog copy */
  count?: number
}

/**
 * Dialog for confirming deletion of all sessions.
 * Displays a warning message with Cancel and Delete Sessions actions.
 */
export const DeleteAllSessionsConfirmationModal: FC<DeleteAllSessionsConfirmationModalProps> = ({
  open,
  onOpenChange,
  onConfirm,
  count,
}) => {
  const t = useTranslations('research')
  const tc = useTranslations('common')
  const handleConfirm = () => {
    onConfirm()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" aria-hidden="true" />
            <span>{t('deleteModals.all.title')}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            {t('deleteModals.aboutToDelete')}{' '}
            <span className="font-semibold">
              {count && count > 0
                ? t('deleteModals.all.countSessions', { count })
                : t('deleteModals.all.allSessions')}
            </span>
            {t('deleteModals.lossSuffix')}
          </p>
          {/* Scope reassurance: delete-all is project-local (UX-8). */}
          <p className="text-sm">{t('deleteModals.all.scopeNote')}</p>
          <p className="text-sm">{t('deleteModals.cannotReverse')}</p>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">{tc('actions.cancel')}</Button>
          </DialogClose>
          <Button variant="destructive" onClick={handleConfirm}>
            {t('deleteModals.all.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
