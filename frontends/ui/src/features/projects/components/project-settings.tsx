'use client'

/**
 * Project Settings page body (spec §5, FB-9) — the consolidated home for what
 * used to be the Overview and Members pages:
 *
 *   parameters (intake brief + applicable standards) → members → memory →
 *   insights (honest empty state, no telemetry backend yet) → danger zone.
 *
 * Everything here is composition: the sections reuse the existing components
 * unchanged, so their own permission checks and data flows keep working.
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
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { useLocale, useTranslations } from '@/i18n'

interface ProjectSettingsProps {
  data: ProjectOverviewData
  /**
   * Whether the current user manages the project (project:manage). Gates the
   * rename affordance, member management, and the danger zone — viewers and
   * editors get a dignified read-only page, never a control the API rejects.
   */
  canManageProject?: boolean
  /** Whether the flagged project knowledge page is linked from here (spec §5). */
  showKnowledgeLink?: boolean
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

  return (
    <Stagger className="mx-auto w-full max-w-5xl space-y-8 px-4 py-6 md:space-y-10 md:px-8 md:py-10">
      {/* Header: eyebrow + name + rename + status. Soft-deleted projects 404
          in the layout, so a project rendered here is by definition active. */}
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
              <Badge variant="success">{t('project.status.active')}</Badge>
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

      {/* Project parameters — the intake brief (with its own "edit" link into
          the intake wizard) plus the standards applicability derived from it. */}
      <StaggerItem>
        <section aria-label={t('project.sections.parameters')} className="space-y-6">
          <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {t('project.sections.parameters')}
          </h2>
          <ProjectBrief
            projectId={data.id}
            profile={data.profile}
            summary={data.profileDisplay?.summary}
            briefStarted={data.profileDisplay != null}
          />
          <ApplicableStandards
            projectId={data.id}
            standards={data.applicableStandards}
            briefComplete={data.briefComplete}
          />
        </section>
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

      {/* Insights — honest empty state only: per-project telemetry aggregation
          does not exist yet (spec §2.3), so this promises nothing and shows
          nothing fake. */}
      <StaggerItem>
        <section aria-label={t('project.sections.insights')} className="space-y-4">
          <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {t('project.sections.insights')}
          </h2>
          <EmptyState
            icon={BarChart3}
            title={t('project.insights.emptyTitle')}
            description={t('project.insights.emptyDescription')}
          />
        </section>
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
