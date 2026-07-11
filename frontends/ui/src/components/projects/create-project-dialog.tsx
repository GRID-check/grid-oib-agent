'use client'

import { useCallback, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'

import { Button, type ButtonProps } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { CreateProjectForm } from './create-project-form'
import { useTranslations } from '@/i18n'

interface CreateProjectDialogProps {
  /** Open on mount — wired to `/app/projects?new=1` from the project switcher. */
  defaultOpen?: boolean
  label?: string
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
}

export function CreateProjectDialog({
  defaultOpen = false,
  label,
  variant = 'default',
  size = 'default',
}: CreateProjectDialogProps): JSX.Element {
  const t = useTranslations('projects')
  const router = useRouter()
  const pathname = usePathname()
  const [open, setOpen] = useState(defaultOpen)

  // When this dialog was auto-opened from `?new=1` (project switcher deep link),
  // strip the param on close so a refresh or back-navigation doesn't re-open it.
  const handleOpenChange = useCallback(
    (next: boolean): void => {
      setOpen(next)
      if (!next && defaultOpen && pathname) {
        router.replace(pathname, { scroll: false })
      }
    },
    [defaultOpen, pathname, router],
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant={variant} size={size}>
          <Plus className="size-4" />
          {label ?? t('dialog.newProject')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('dialog.title')}</DialogTitle>
          <DialogDescription>{t('dialog.description')}</DialogDescription>
        </DialogHeader>
        <CreateProjectForm />
      </DialogContent>
    </Dialog>
  )
}
