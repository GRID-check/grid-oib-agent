// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
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

interface CreateProjectDialogProps {
  /** Open on mount — wired to `/projects?new=1` from the project switcher. */
  defaultOpen?: boolean
  label?: string
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
}

export function CreateProjectDialog({
  defaultOpen = false,
  label = 'New project',
  variant = 'default',
  size = 'default',
}: CreateProjectDialogProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant} size={size}>
          <Plus className="size-4" />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a project</DialogTitle>
          <DialogDescription>
            A project is a focused workspace for one building — its documents, members, research,
            and chat context stay together.
          </DialogDescription>
        </DialogHeader>
        <CreateProjectForm />
      </DialogContent>
    </Dialog>
  )
}
