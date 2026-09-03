'use client'

import { useState } from 'react'
import { z } from 'zod'
import { useAppForm } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { SectionLabel } from '@/components/ui/section-label'
import { createProject } from '@/app/app/(shell)/projects/actions'
import { useTranslations } from '@/i18n'

/**
 * First-run accelerators grounded in the Austrian OIB/RIS domain. Selecting one
 * pre-fills the project name so a new architect isn't staring at a blank field.
 * The chip label and the name it pre-fills are localized (DE keeps the domain
 * terms; EN uses English equivalents) — see projects.form.templates.
 */
const TEMPLATE_KEYS = [
  'neubauWohnbau',
  'betriebsbauBrandschutz',
  'sanierungBestand',
  'oibBrandschutzAudit',
] as const

export function CreateProjectForm(): JSX.Element {
  const t = useTranslations('projects')
  const [serverError, setServerError] = useState<string | null>(null)

  const createProjectSchema = z.object({
    name: z
      .string()
      .trim()
      .min(1, t('form.nameRequired'))
      .max(255, t('form.nameTooLong')),
  })

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
        // The server action re-validates and can surface vendor/database exception
        // text. Never show that to an architect — log it, show a calm message.
        setServerError(t('form.createError'))
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
                  label={t('form.nameLabel')}
                  placeholder={t('form.namePlaceholder')}
                  autoFocus
                  aria-label={t('form.nameLabel')}
                  disabled={isSubmitting}
                />
              )}
            </form.AppField>

            <div className="flex flex-col gap-2">
              <SectionLabel>{t('form.templateLabel')}</SectionLabel>
              <div className="flex flex-wrap gap-2">
                {TEMPLATE_KEYS.map((key) => {
                  const label = t(`form.templates.${key}.label`)
                  const name = t(`form.templates.${key}.name`)
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => form.setFieldValue('name', name)}
                      className="rounded-full border px-3 py-1 text-xs text-muted-foreground transition-colors duration-quick ease-out hover:border-primary/40 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50 motion-reduce:transition-none"
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
          </>
        )}
      </form.Subscribe>

      <p className="text-sm leading-relaxed text-muted-foreground">{t('form.footnote')}</p>

      {serverError && (
        <Alert variant="destructive">
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end pt-1">
        <form.AppForm>
          <form.SubmitButton className="w-full sm:w-auto">{t('form.submit')}</form.SubmitButton>
        </form.AppForm>
      </div>
    </form>
  )
}
