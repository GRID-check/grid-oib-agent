'use client'

import { useId, useState, type FC, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface TypeToConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  /** The exact string the user must type (e.g. the project name). */
  confirmName: string
  /** Label of the destructive button. */
  confirmLabel: string
  onConfirm: () => void | Promise<void>
  /** Disables all controls while the deletion request is in flight. */
  pending?: boolean
}

export const TypeToConfirmDialog: FC<TypeToConfirmDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  confirmName,
  confirmLabel,
  onConfirm,
  pending = false,
}) => {
  const [value, setValue] = useState('')
  const inputId = useId()
  const matches = value === confirmName

  const handleOpenChange = (next: boolean) => {
    if (pending) return
    if (!next) setValue('')
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
            <span>{title}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="text-sm">{description}</div>
          <label htmlFor={inputId} className="text-sm">
            Type <span className="font-semibold">{confirmName}</span> to confirm:
          </label>
          <Input
            id={inputId}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={confirmName}
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
          />
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={!matches || pending}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
