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
            <span>Deleting All Sessions</span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            You are about to delete{' '}
            <span className="font-semibold">
              {count && count > 0 ? `all ${count} sessions` : 'ALL sessions'}
            </span>
            . You will lose all progress and any files you have attached will be removed.
          </p>
          <p className="text-sm">
            This action cannot be reversed. Are you sure you want to do this?
          </p>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="destructive" onClick={handleConfirm}>
            Delete ALL Sessions
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
