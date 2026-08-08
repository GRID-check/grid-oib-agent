'use client'

/**
 * Project Settings page body (spec §5, FB-9) — the consolidated home for what
 * used to be the Overview and Members pages, in the click-dummy's warm two-column
 * language:
 *
 *   the project profile card (the single "Projektparameter" surface) + honest
 *   Insights card (top grid) → applicable standards → members → memory →
 *   danger zone.
 *
 * ONE profile surface, ONE editor. The profile is shown once — as the
 * {@link ProjectBrief} (facts, summary, Piloti's assumptions and the open
 * gaps) — and edited in one place, the guided intake wizard (its "Briefing
 * bearbeiten" link). An earlier revision also rendered a separate
 * "Projektparameter" field card here; it duplicated the same facts and pointed
 * at the same wizard, so it was removed. The project's *facts* are
 * interdependent (building class / use / floors drive which OIB standards
 * apply), which is exactly why editing runs through the wizard's guided,
 * consistency-checked flow rather than loose inline fields.
 *
 * Every feature the page consolidated is kept below, unchanged — the sections
 * reuse the existing components so their own permission checks and data flows
 * keep working.
 */

import Link from 'next/link'
import { BarChart3, BookOpenCheck } from 'lucide-react'
import { useMemo } from 'react'
import type { ProjectOverviewData } from '../types'
import { ApplicableStandards } from './applicable-standards'
import { ProjectBrief } from './project-brief'
import { ProjectDangerZone } from './project-danger-zone'
import { ProjectMemoryPanel } from './project-memory-panel'
import { ProjectRenameButton } from './project-rename-button'
import { ProjectMembersForm } from '@/components/projects/project-members-form'
import { Stagger, StaggerItem } from '@/components/motion'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionLabel } from '@/components/ui/section-label'
import { useLocale, useTranslations } from '@/i18n'

interface ProjectSettingsProps {
  data: ProjectOverviewData
  /**
   * Whether the current user manages the project (project:manage). Gates the
   * rename affordance, member management, the danger zone and the brief's
   * "edit" link — viewers and editors get a dignified read-only page, never a
   * control the API rejects.
   */
  canManageProject?: boolean
  /** Whether the flagged project knowledge page is linked from here (spec §5). */
  showKnowledgeLink?: boolean
  /**
   * The signed-in user's own organization membership id, threaded down to
   * {@link ProjectMembersForm} so it can recognize "your own row" in the
   * roster and guard against self-lockout. `null`/omitted when unknown.
   */
  currentMembershipId?: string | null
}

export function ProjectSettings({
  data,
  canManageProject = false,
  showKnowledgeLink = false,
  currentMembershipId = null,
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

  return (
    <Stagger className="mx-auto w-full max-w-5xl space-y-8 px-4 py-6 md:space-y-10 md:px-8 md:py-10">
      {/* Header: eyebrow + name + rename. Soft-deleted projects 404 in the
          layout, so a project rendered here is by definition active. */}
      <StaggerItem>
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <SectionLabel>{t('project.eyebrow')}</SectionLabel>
            <div className="mt-1 flex min-w-0 items-center gap-2">
              <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">{data.name}</h1>
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
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground touch-target"
            >
              <BookOpenCheck className="size-4" aria-hidden />
              {t('project.knowledgeLink')}
            </Link>
          )}
        </header>
      </StaggerItem>

      {/* Top grid, the dummy's card chrome: the single project-profile card
          (left) beside the honest Insights card (right). The profile is the
          ProjectBrief — facts, summary, Piloti's assumptions and the open gaps,
          with its one "Briefing bearbeiten" link into the guided wizard. */}
      <StaggerItem>
        <div className="grid gap-4 md:grid-cols-[1.4fr_1fr] md:items-start md:gap-[18px]">
          {/* The single project-profile card. ProjectBrief renders its own card
              chrome, so it sits directly in the grid column. */}
          <ProjectBrief
            projectId={data.id}
            profile={data.profile}
            summary={data.profileDisplay?.summary}
            summaryLocale={data.profileDisplay?.summaryLocale}
            briefStarted={data.profileDisplay != null}
            canEdit={canManageProject}
          />

          {/* Insights — honest empty state only: per-project telemetry
              aggregation does not exist yet (spec §2.3), so this promises
              nothing and shows nothing fake. The card chrome + heading match the
              dummy, ready for the source-mix layout once telemetry exists. */}
          <section
            aria-label={t('project.sections.insights')}
            className="rounded-2xl border bg-card p-6 shadow-sm"
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
            <h2 className="text-sm font-semibold text-foreground">{t('project.sections.members')}</h2>
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {canManageProject
                ? t('project.membersDescriptionManage')
                : t('project.membersDescriptionReadOnly')}
            </p>
          </div>
          <ProjectMembersForm
            projectId={data.id}
            canManage={canManageProject}
            currentMembershipId={currentMembershipId}
          />
        </section>
      </StaggerItem>

      {/* Project memory — what Piloti has learned about this project, user-curated. */}
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
