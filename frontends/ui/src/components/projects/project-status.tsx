'use client'

/**
 * Project status — derivation helper + chip.
 *
 * Honesty note: the projects table has NO status/archived/completed column
 * (see `src/lib/db/schema/projects.ts` — the only lifecycle field is
 * `deletedAt`), and soft-deleted rows never reach the grid (filtered upstream
 * with `WHERE deleted_at IS NULL`; they surface in the "Recently deleted"
 * panel instead). So every project a card renders is, truthfully, active.
 * A "Done/Abgeschlossen" state is deliberately NOT invented here — it appears
 * only once the data model grows a real completion/archive concept.
 */

import type { CSSProperties } from 'react'
import { Activity } from 'lucide-react'
import type { Project } from '@/lib/db/schema'
import { useTranslations } from '@/i18n'

export type ProjectStatus = 'active'

/**
 * Derive the display status for a project that reached the grid. Currently the
 * only value the data can support is `active` (see module note); the helper
 * exists so call sites stay unchanged when a real status field lands.
 */
export function getProjectStatus(_project: Pick<Project, 'deletedAt'>): ProjectStatus {
  return 'active'
}

/**
 * Status colors via the `--status-*` token family (spec §4). The tokens are
 * being introduced by the parallel token retune (WS-1); until they exist the
 * chip falls back to the semantic success feedback tokens — never hex, and
 * theme-aware in both cases.
 */
const STATUS_STYLE: Record<ProjectStatus, CSSProperties> = {
  active: {
    backgroundColor:
      'var(--status-active-tint, color-mix(in oklch, var(--status-active, var(--text-color-feedback-success)) 14%, transparent))',
    color: 'var(--status-active-text, var(--status-active, var(--text-color-feedback-success)))',
  },
}

interface ProjectStatusChipProps {
  status: ProjectStatus
}

/** Small tinted status chip (Aktiv / Active) shown on every project card. */
export function ProjectStatusChip({ status }: ProjectStatusChipProps): JSX.Element {
  const t = useTranslations('projects')
  return (
    <span
      className="inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium"
      style={STATUS_STYLE[status]}
    >
      <Activity className="size-3" strokeWidth={2.4} aria-hidden />
      {t(`card.status.${status}`)}
    </span>
  )
}
