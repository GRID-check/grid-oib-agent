// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DeleteSessionConfirmationModal Component
 *
 * Confirmation dialog displayed before deleting a session.
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

export interface DeleteSessionConfirmationModalProps {
  /** Whether the modal is open */
  open: boolean
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void
  /** Callback when delete is confirmed */
  onConfirm: () => void
}

/**
 * Dialog for confirming session deletion.
 * Displays a warning message with Cancel and Delete Session actions.
 */
export const DeleteSessionConfirmationModal: FC<DeleteSessionConfirmationModalProps> = ({
  open,
  onOpenChange,
  onConfirm,
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
            <span>Deleting Session</span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            You are about to delete this session. You will lose all progress and any files you have
            attached will be removed.
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
            Delete Session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
