'use client'

import { useState } from 'react'
import { z } from 'zod'
import { useAppForm } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { createProject } from '@/app/app/projects/actions'

const createProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Project name is required.')
    .max(255, 'Project name must be at most 255 characters.'),
})

/**
 * First-run accelerators grounded in the Austrian OIB/RIS domain. Selecting one
 * pre-fills the project name so a new architect isn't staring at a blank field.
 */
const PROJECT_TEMPLATES: Array<{ label: string; name: string }> = [
  { label: 'Neubau Wohnbau', name: 'Neubau Wohnbau' },
  { label: 'Betriebsbau Brandschutz', name: 'Betriebsbau — Brandschutz' },
  { label: 'Sanierung Bestand', name: 'Sanierung Bestand' },
  { label: 'OIB Brandschutz-Audit', name: 'OIB Brandschutz-Audit' },
]

// The server action re-validates and can surface vendor/database exception text.
// Never show that to an architect — log it, show a calm, actionable message.
const FRIENDLY_CREATE_ERROR =
  "We couldn't create this project just now. Please try again in a moment."

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
        console.error('[CreateProjectForm] create failed:', result.error)
        setServerError(FRIENDLY_CREATE_ERROR)
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
          <>
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

            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                Start from a template
              </span>
              <div className="flex flex-wrap gap-2">
                {PROJECT_TEMPLATES.map((template) => (
                  <button
                    key={template.name}
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => form.setFieldValue('name', template.name)}
                    className="rounded-full border px-3 py-1 text-xs text-muted-foreground transition-colors duration-200 ease-out hover:border-primary/40 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
                  >
                    {template.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </form.Subscribe>

      <p className="text-sm leading-relaxed text-muted-foreground">
        Create a focused workspace for documents, retrieval, members, and chat grounded in the
        OIB/RIS corpus.
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
