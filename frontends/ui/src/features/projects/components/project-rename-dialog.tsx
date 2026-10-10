'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'

interface ProjectRenameDialogProps {
  projectId: string
  projectName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Rename the project, opened from the Overview hero's menu. Backed by
 * `PATCH /api/projects/[id]` (`project:manage`); the caller only offers it
 * when the user holds that capability, and a 403 is still surfaced gracefully.
 */
export function ProjectRenameDialog({
  projectId,
  projectName,
  open,
  onOpenChange,
}: ProjectRenameDialogProps) {
  const t = useTranslations('projects')
  const router = useRouter()
  const [name, setName] = useState(projectName)
  const [pending, setPending] = useState(false)

  // Opened from outside (the menu), so the field is seeded on open rather than
  // in the handler: it must show the current name, not the one at mount.
  useEffect(() => {
    if (open) setName(projectName)
  }, [open, projectName])

  const handleOpenChange = (next: boolean) => {
    if (pending) return
    if (next) setName(projectName)
    onOpenChange(next)
  }

  const trimmed = name.trim()
  const canSave = trimmed.length > 0 && trimmed !== projectName && !pending

  const handleSave = async () => {
    if (!trimmed || trimmed === projectName) return
    setPending(true)
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      if (!res.ok) {
        throw new Error(
          res.status === 403 ? t('overview.rename.forbidden') : t('overview.rename.error')
        )
      }
      toast.success(t('overview.rename.success'))
      setPending(false)
      onOpenChange(false)
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('overview.rename.error'))
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('overview.rename.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('overview.rename.dialogDescription')}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (canSave) void handleSave()
          }}
        >
          <Field>
            <FieldLabel htmlFor="project-rename-input">{t('overview.rename.nameLabel')}</FieldLabel>
            <Input
              id="project-rename-input"
              value={name}
              maxLength={255}
              autoFocus
              // One field, one submit: the soft keyboard's action key is the
              // shortest path out of a dialog that opens with the keyboard
              // already up.
              enterKeyHint="done"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <DialogFooter className="mt-5">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={pending}
            >
              {t('overview.rename.cancel')}
            </Button>
            <Button type="submit" disabled={!canSave} className="min-w-24">
              <Spinner
                size="sm"
                aria-hidden={!pending}
                className={
                  pending
                    ? 'duration-snap transition-opacity ease-out motion-reduce:transition-none'
                    : 'opacity-0'
                }
              />
              {pending ? t('overview.rename.saving') : t('overview.rename.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
