'use client'

/**
 * Name a new folder. Used by the breadcrumb popover's sibling — the right-click
 * "New folder" / "New folder inside" path, which has no popover anchor.
 */

import { useState } from 'react'
import { Folder } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'

export interface NewFolderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (name: string) => Promise<boolean>
}

export function NewFolderDialog({ open, onOpenChange, onCreate }: NewFolderDialogProps): JSX.Element {
  const t = useTranslations('files')
  const [name, setName] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const commit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed || isCreating) return
    setIsCreating(true)
    const ok = await onCreate(trimmed)
    setIsCreating(false)
    if (ok) {
      setName('')
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (isCreating ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('folders.newFolder')}</DialogTitle>
        </DialogHeader>
        <InputGroup>
          <InputGroupAddon align="start" className="left-2">
            <Folder aria-hidden />
          </InputGroupAddon>
          <Input
            autoFocus
            value={name}
            disabled={isCreating}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void commit()
            }}
            placeholder={t('folders.namePlaceholder')}
            aria-label={t('folders.newFolderName')}
            aria-busy={isCreating}
            className="h-8 rounded-md pl-8 pr-8"
            data-testid="listing-new-folder-input"
          />
          {isCreating && (
            <InputGroupAddon align="end">
              <Spinner size="sm" label={t('folders.creating')} />
            </InputGroupAddon>
          )}
        </InputGroup>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isCreating}>
            {t('rename.cancel')}
          </Button>
          <Button type="button" onClick={() => void commit()} disabled={isCreating || name.trim() === ''}>
            {t('folders.newFolder')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
