'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { PencilLine } from 'lucide-react'
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

interface ProjectRenameButtonProps {
  projectId: string
  projectName: string
}

/**
 * Rename affordance for the project overview header. Backed by
 * `PATCH /api/projects/[id]` (`project:manage`); the caller only renders this
 * when the user holds that capability, and a 403 is still surfaced gracefully.
 */
export function ProjectRenameButton({ projectId, projectName }: ProjectRenameButtonProps) {
  const t = useTranslations('projects')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(projectName)
  const [pending, setPending] = useState(false)

  const handleOpenChange = (next: boolean) => {
    if (pending) return
    if (next) setName(projectName)
    setOpen(next)
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
      setOpen(false)
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('overview.rename.error'))
      setPending(false)
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground size-8 shrink-0"
        onClick={() => handleOpenChange(true)}
        aria-label={t('overview.rename.action')}
        title={t('overview.rename.action')}
      >
        <PencilLine className="size-4" aria-hidden />
      </Button>

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
              <FieldLabel htmlFor="project-rename-input">
                {t('overview.rename.nameLabel')}
              </FieldLabel>
              <Input
                id="project-rename-input"
                value={name}
                maxLength={255}
                autoFocus
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
    </>
  )
}
