'use client'

/**
 * Plain confirm dialog for deleting a skill or a job. Both are
 * recoverable-ish (a job is re-creatable; a deleted skill's jobs keep their
 * snapshot and keep running), so a single explicit confirmation — not
 * type-to-confirm — is the right friction here. Shared with `features/jobs`,
 * which imports it rather than growing a second copy.
 */

import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'

interface ConfirmDeleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  pending?: boolean
  onConfirm: () => void | Promise<void>
}

export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  pending = false,
  onConfirm,
}: ConfirmDeleteDialogProps): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-destructive" aria-hidden />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={pending}>
              {cancelLabel}
            </Button>
          </DialogClose>
          <Button variant="destructive" disabled={pending} onClick={() => void onConfirm()}>
            {pending && <Spinner size="sm" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
