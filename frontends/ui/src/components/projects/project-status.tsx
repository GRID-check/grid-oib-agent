'use client'

/**
 * Project status: the derivation helper and the chip (ADR-0088).
 *
 * A project is `active` or `closed` (`projects.status`, migration 0115). A
 * soft-deleted project never reaches a surface that shows this chip; it lives in
 * the "Recently deleted" panel.
 *
 * Two chips, one decision each:
 *   - {@link ProjectStatusChip}: the project's own status, on the project card
 *     and, for a closed project only, on the list row.
 *   - {@link ProjectClosedChip}: on a FILE, wherever it appears, to say which
 *     closed project it belongs to. A file of an active project carries
 *     nothing; the project it is in is the page around it.
 */

import type { JSX } from 'react'
import type { CSSProperties } from 'react'
import { Activity, Lock } from 'lucide-react'
import { Chip } from '@/components/ui/chip'
import type { Project } from '@/lib/db/schema'
import type { ProjectStatus } from '@/lib/projects/project-status'
import { useTranslations } from '@/i18n'

export type { ProjectStatus }

/** The display status of a project that reached a surface. */
export function getProjectStatus(project: Pick<Project, 'status'>): ProjectStatus {
  return project.status === 'closed' ? 'closed' : 'active'
}

/**
 * Status colors via the `--status-*` token family (spec §4), with the semantic
 * success tokens as the fallback for `active`. A closed project is quiet: the
 * muted chip carries it, and the lock icon says what closed means.
 */
const STATUS_STYLE: Record<ProjectStatus, CSSProperties | undefined> = {
  active: {
    backgroundColor:
      'var(--status-active-tint, color-mix(in oklch, var(--status-active, var(--text-color-feedback-success)) 14%, transparent))',
    color: 'var(--status-active-text, var(--status-active, var(--text-color-feedback-success)))',
  },
  closed: undefined,
}

const STATUS_VARIANT: Record<ProjectStatus, 'success' | 'muted'> = {
  active: 'success',
  closed: 'muted',
}

const STATUS_ICON: Record<ProjectStatus, typeof Activity> = {
  active: Activity,
  closed: Lock,
}

interface ProjectStatusChipProps {
  status: ProjectStatus
  size?: 'sm' | 'md'
}

/** Small tinted status chip (Aktiv / Abgeschlossen). */
export function ProjectStatusChip({ status, size = 'md' }: ProjectStatusChipProps): JSX.Element {
  const t = useTranslations('projects')
  const Icon = STATUS_ICON[status]
  return (
    <Chip variant={STATUS_VARIANT[status]} size={size} style={STATUS_STYLE[status]}>
      <Icon aria-hidden />
      {t(`card.status.${status}`)}
    </Chip>
  )
}

/**
 * A file's project, said to be closed: „Projekt Seestadt · abgeschlossen".
 * The name is the project's; without one the chip says only that it is closed.
 */
export function ProjectClosedChip({ projectName, className }: { projectName?: string | null; className?: string }): JSX.Element {
  const t = useTranslations('projects')
  const label = projectName ? t('lifecycle.fileChip', { name: projectName }) : t('lifecycle.fileChipNoName')
  return (
    <Chip variant="muted" size="sm" className={className} title={label}>
      <Lock aria-hidden />
      <span className="max-w-[16rem] truncate">{label}</span>
    </Chip>
  )
}
