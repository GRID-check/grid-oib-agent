'use client'

/**
 * The `ifc_model_picker` card: the project's models as tiles you click to open.
 *
 * "Zeig mir das Modell" used to be answered with a prose bullet list of file
 * names the user had to read and retype — a round-trip through the model for
 * something that is just navigation. This card replaces that: it lists the
 * project's models and each tile is a `<Link>` into the viewer
 * (`buildModelHref`), so a click opens the building directly, client-side, with
 * no second turn.
 *
 * Like every model-backed card it carries no file names of its own — the agent
 * supplies only the heading. The list comes from `useProjectBimModels`, the
 * same live source the viewer resolves against, so a name the model never chose
 * cannot be wrong: there is nothing here to invent. And it is fail-open — a
 * project with no readable model renders nothing and the written answer stands
 * on its own, exactly as the prose did.
 */

import { useMemo } from 'react'
import Link from 'next/link'
import { ArrowRight, Boxes } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { documentDisplayName } from '@/lib/documents/display-name'
import { buildModelHref } from '@/features/bim/lib/model-link'
import { useProjectBimModels } from '@/features/bim/hooks/use-bim-model'

export interface IfcModelPickerCardProps {
  title: string
  note: string | null
  projectId: string | null
}

export function IfcModelPickerCard({
  title,
  note,
  projectId,
}: IfcModelPickerCardProps): JSX.Element | null {
  const t = useTranslations('bim')
  const { data: models, isLoading, error } = useProjectBimModels(projectId)

  // Only models that can actually be opened. A `pending`/`extracting`/`failed`
  // tile would open a viewer with nothing to show, which is the opposite of
  // what a picker is for.
  const ready = useMemo(
    () => (models ?? []).filter((candidate) => candidate.status === 'ready'),
    [models]
  )

  // Still loading: hold a spinner rather than deciding the project is empty —
  // the same distinction the viewer card draws between "not arrived yet" and
  // "genuinely none".
  if (models === null && isLoading) {
    return (
      <section className="rounded-xl border bg-card p-4" aria-label={title}>
        <PickerHeader title={title} />
        <div className="flex items-center justify-center rounded-lg border border-dashed p-6">
          <Spinner className="size-4" />
        </div>
      </section>
    )
  }

  // The list could not be read — a transport failure, a withdrawn feature flag.
  // "Could not look" is not "the project has no models", so say which it is.
  if (error !== null) {
    return (
      <section className="rounded-xl border bg-card p-4" aria-label={title}>
        <PickerHeader title={title} />
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t('modelPicker.failed')}
        </p>
      </section>
    )
  }

  // Fail-open: a project with nothing openable renders nothing at all, and the
  // agent's written answer carries the turn — never an empty picker. Without a
  // project there are no hrefs to build, so there is nothing to offer either.
  if (!projectId || ready.length === 0) return null

  return (
    <section className="rounded-xl border bg-card p-4" aria-label={title}>
      <PickerHeader title={title} />
      <ul className="grid gap-2 sm:grid-cols-2">
        {ready.map((model) => {
          const label = documentDisplayName(model)
          return (
            <li key={model.id}>
              <Link
                href={buildModelHref(projectId, { model: model.filename })}
                aria-label={t('modelPicker.openAria', { name: label })}
                className="group flex items-center gap-3 rounded-lg border bg-background p-3 transition-colors hover:border-primary/60 hover:bg-accent"
              >
                <Boxes className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{label}</span>
                  {model.schemaVersion && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {model.schemaVersion}
                    </span>
                  )}
                </span>
                <ArrowRight
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </Link>
            </li>
          )
        })}
      </ul>
      {note && <p className="mt-3 text-sm text-muted-foreground">{note}</p>}
    </section>
  )
}

function PickerHeader({ title }: { title: string }): JSX.Element {
  return (
    <header className="mb-3 flex items-center gap-2">
      <Boxes className="size-4 text-muted-foreground" aria-hidden="true" />
      <h3 className="text-sm font-semibold">{title}</h3>
    </header>
  )
}
