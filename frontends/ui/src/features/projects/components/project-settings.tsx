'use client'

/**
 * Project Settings page body (spec §5, FB-9) — the consolidated home for what
 * used to be the Overview and Members pages, in the click-dummy's warm two-column
 * language:
 *
 *   a Projektparameter form card + honest Insights card (top grid) →
 *   the detailed brief (edit-into-intake) → applicable standards → members →
 *   memory → danger zone.
 *
 * The Projektparameter card and Insights card are the dummy's chrome; every
 * feature the page consolidated is kept below, unchanged — the sections reuse
 * the existing components so their own permission checks and data flows keep
 * working.
 */

import Link from 'next/link'
import { BarChart3, BookOpenCheck } from 'lucide-react'
import { useMemo } from 'react'
import type { ProjectOverviewData } from '../types'
import { formatBareValue } from '@/lib/project-profile/brief-view'
import {
  flattenIntakeQuestions,
  formatIntakeAnswer,
  projectIntakeDefinitionV1,
} from '@/lib/project-profile/intake-definition'
import type { ProjectProfile } from '@/lib/project-profile/types'
import { ApplicableStandards } from './applicable-standards'
import { ProjectBrief } from './project-brief'
import { ProjectDangerZone } from './project-danger-zone'
import { ProjectMemoryPanel } from './project-memory-panel'
import { ProjectRenameButton } from './project-rename-button'
import { ProjectMembersForm } from '@/components/projects/project-members-form'
import { Stagger, StaggerItem } from '@/components/motion'
import { EmptyState } from '@/components/ui/empty-state'
import { useLocale, useTranslations } from '@/i18n'

interface ProjectSettingsProps {
  data: ProjectOverviewData
  /**
   * Whether the current user manages the project (project:manage). Gates the
   * rename affordance, member management, the danger zone and the "edit
   * parameters" link — viewers and editors get a dignified read-only page,
   * never a control the API rejects.
   */
  canManageProject?: boolean
  /** Whether the flagged project knowledge page is linked from here (spec §5). */
  showKnowledgeLink?: boolean
}

/**
 * Resolve a stored fact to its human-readable value using the same intake
 * vocabulary the rest of the app renders in (option labels, not raw enum
 * tokens). Returns null when the fact was never captured, so the field falls
 * back to an honest "not provided" placeholder rather than an empty box.
 */
function factValue(profile: ProjectProfile | null, key: string): string | null {
  const fact = profile?.facts?.[key]
  if (!fact) return null
  const question = flattenIntakeQuestions(projectIntakeDefinitionV1).find(
    (q) => q.writesTo === `/facts/${key}/value`,
  )
  const value = question ? formatIntakeAnswer(question, fact.value) : formatBareValue(fact.value)
  return value && value !== '—' ? value : null
}

export function ProjectSettings({
  data,
  canManageProject = false,
  showKnowledgeLink = false,
}: ProjectSettingsProps) {
  const t = useTranslations('settings')
  const { locale } = useLocale()
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }),
    [locale],
  )

  let createdLabel = ''
  try {
    createdLabel = dateFormatter.format(new Date(data.createdAt))
  } catch {
    createdLabel = ''
  }

  const intakeHref = `/app/projects/${data.id}/intake`
  const profile = data.profile
  // Standort prefers the free-text location (used for out-of-Austria projects),
  // otherwise the Bundesland the building code is derived from.
  const location = factValue(profile, 'standort_details') ?? factValue(profile, 'bundesland')
  const buildingClass = factValue(profile, 'gebaeudeklasse')
  const constructionType = factValue(profile, 'bestand_neubau')
  const use = factValue(profile, 'hauptnutzung')

  const notProvided = t('project.parameters.notProvided')

  return (
    <Stagger className="mx-auto w-full max-w-5xl space-y-8 px-4 py-6 md:space-y-10 md:px-8 md:py-10">
      {/* Header: eyebrow + name + rename. Status lives in the parameters card,
          matching the dummy. Soft-deleted projects 404 in the layout, so a
          project rendered here is by definition active. */}
      <StaggerItem>
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              {t('project.eyebrow')}
            </span>
            <div className="mt-1 flex min-w-0 items-center gap-2">
              <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">{data.name}</h1>
              {canManageProject && (
                <ProjectRenameButton projectId={data.id} projectName={data.name} />
              )}
            </div>
            {createdLabel && (
              <p className="mt-1 text-sm text-muted-foreground">
                {t('project.createdOn', { date: createdLabel })}
              </p>
            )}
          </div>
          {showKnowledgeLink && (
            <Link
              href={`/app/projects/${data.id}/knowledge`}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <BookOpenCheck className="size-4" aria-hidden />
              {t('project.knowledgeLink')}
            </Link>
          )}
        </header>
      </StaggerItem>

      {/* Top grid: Projektparameter form (left) + honest Insights (right) — the
          dummy's card chrome. The parameters are read-only here; editing runs
          through the intake wizard (the "edit details" link + the brief below). */}
      <StaggerItem>
        <div className="grid gap-4 md:grid-cols-[1.2fr_1fr] md:items-start md:gap-[18px]">
          {/* Projektparameter */}
          <section
            aria-label={t('project.sections.parameters')}
            className="rounded-lg border bg-card p-5 shadow-sm"
          >
            <h2 className="mb-4 text-sm font-semibold text-foreground">
              {t('project.sections.parameters')}
            </h2>
            <div className="flex flex-col gap-3.5">
              <ParameterField label={t('project.parameters.fields.name')} value={data.name} />
              <ParameterField
                label={t('project.parameters.fields.location')}
                value={location}
                placeholder={notProvided}
              />
              <div className="flex gap-3">
                <ParameterField
                  className="flex-1"
                  label={t('project.parameters.fields.buildingClass')}
                  value={buildingClass}
                  placeholder={notProvided}
                />
                <ParameterField
                  className="flex-1"
                  label={t('project.parameters.fields.constructionType')}
                  value={constructionType}
                  placeholder={notProvided}
                />
              </div>
              <ParameterField
                label={t('project.parameters.fields.use')}
                value={use}
                placeholder={notProvided}
              />
              {/* Status: projects here are active (soft-deleted ones 404), so
                  "Aktiv" is the selected, truthful state. The muted second chip
                  mirrors the dummy without pretending a lifecycle we don't have. */}
              <div>
                <div className="mb-1.5 text-xs text-muted-foreground">
                  {t('project.parameters.fields.status')}
                </div>
                <div className="flex gap-2">
                  <span className="inline-flex h-7 items-center gap-2 rounded-md border bg-card px-3 text-xs font-medium text-foreground shadow-2xs">
                    <span className="size-1.5 rounded-full bg-status-active" aria-hidden />
                    {t('project.status.active')}
                  </span>
                  <span
                    className="inline-flex h-7 items-center rounded-md border px-3 text-xs text-muted-foreground"
                    aria-disabled
                  >
                    {t('project.status.completed')}
                  </span>
                </div>
              </div>
            </div>

            {canManageProject && (
              <div className="mt-5 flex justify-end border-t pt-4">
                <Link
                  href={intakeHref}
                  className="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90"
                >
                  {t('project.parameters.edit')}
                </Link>
              </div>
            )}
          </section>

          {/* Insights — honest empty state only: per-project telemetry
              aggregation does not exist yet (spec §2.3), so this promises
              nothing and shows nothing fake. The card chrome + heading match the
              dummy, ready for the source-mix layout once telemetry exists. */}
          <section
            aria-label={t('project.sections.insights')}
            className="rounded-lg border bg-card p-5 shadow-sm"
          >
            <h2 className="text-sm font-semibold text-foreground">
              {t('project.sections.insights')}
            </h2>
            <EmptyState
              variant="bare"
              icon={BarChart3}
              title={t('project.insights.emptyTitle')}
              description={t('project.insights.emptyDescription')}
              className="py-8"
            />
          </section>
        </div>
      </StaggerItem>

      {/* Project brief — the detailed intake context with its edit-into-wizard
          link, Piloti's assumptions awaiting confirmation and the open gaps. */}
      <StaggerItem>
        <ProjectBrief
          projectId={data.id}
          profile={data.profile}
          summary={data.profileDisplay?.summary}
          briefStarted={data.profileDisplay != null}
        />
      </StaggerItem>

      {/* Standards applicability derived from the brief. */}
      <StaggerItem>
        <ApplicableStandards
          projectId={data.id}
          standards={data.applicableStandards}
          briefComplete={data.briefComplete}
        />
      </StaggerItem>

      {/* Members — the exact roster form the old Members page rendered;
          management controls stay gated inside the reused component. */}
      <StaggerItem>
        <section aria-label={t('project.sections.members')} className="space-y-4">
          <div className="space-y-1">
            <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              {t('project.sections.members')}
            </h2>
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {canManageProject
                ? t('project.membersDescriptionManage')
                : t('project.membersDescriptionReadOnly')}
            </p>
          </div>
          <ProjectMembersForm projectId={data.id} canManage={canManageProject} />
        </section>
      </StaggerItem>

      {/* Project memory — what Grid has learned about this project, user-curated. */}
      <StaggerItem>
        <ProjectMemoryPanel projectId={data.id} />
      </StaggerItem>

      {/* Danger zone — soft delete with grace-period restore. Only shown to
          users who can actually delete (project:manage). */}
      {canManageProject && (
        <StaggerItem>
          <ProjectDangerZone projectId={data.id} projectName={data.name} />
        </StaggerItem>
      )}
    </Stagger>
  )
}

/**
 * A read-only Projektparameter field styled as the dummy's labelled input:
 * a 12px label over a hairline, paper-inset value box. Uncaptured facts show a
 * muted placeholder rather than an empty control.
 */
function ParameterField({
  label,
  value,
  placeholder,
  className,
}: {
  label: string
  value: string | null | undefined
  placeholder?: string
  className?: string
}) {
  const hasValue = value != null && value !== ''
  return (
    <div className={className}>
      <div className="mb-1.5 text-xs text-muted-foreground">{label}</div>
      <div className="flex h-9 items-center rounded-md border bg-input-background px-3 text-sm shadow-2xs">
        <span className={hasValue ? 'truncate text-foreground' : 'truncate text-muted-foreground'}>
          {hasValue ? value : (placeholder ?? '')}
        </span>
      </div>
    </div>
  )
}
