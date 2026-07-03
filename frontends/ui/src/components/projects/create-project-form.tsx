// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { z } from 'zod'
import { useAppForm } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { createProject } from '@/app/projects/actions'

const createProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Project name is required.')
    .max(255, 'Project name must be at most 255 characters.'),
})

export function CreateProjectForm(): JSX.Element {
  const [serverError, setServerError] = useState<string | null>(null)

  const form = useAppForm({
    defaultValues: { name: '' },
    validators: { onChange: createProjectSchema },
    onSubmit: async ({ value }) => {
      setServerError(null)
      const formData = new FormData()
      formData.set('name', value.name.trim())
      const result = await createProject({}, formData)
      if (result?.error) {
        setServerError(result.error)
      }
    },
  })

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        form.handleSubmit()
      }}
      className="flex flex-col gap-4"
    >
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(isSubmitting) => (
          <form.AppField name="name">
            {(field) => (
              <field.TextField
                label="Project name"
                placeholder="OIB fire safety review"
                autoFocus
                aria-label="Project name"
                disabled={isSubmitting}
              />
            )}
          </form.AppField>
        )}
      </form.Subscribe>

      <p className="text-sm text-muted-foreground">
        Create a focused workspace for documents, retrieval, members, and chat context.
      </p>

      {serverError && (
        <Alert variant="destructive">
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end pt-1">
        <form.AppForm>
          <form.SubmitButton className="w-full sm:w-auto">Create project</form.SubmitButton>
        </form.AppForm>
      </div>
    </form>
  )
}
