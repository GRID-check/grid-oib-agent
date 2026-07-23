'use client'

/**
 * Project card, styled after the click-dummy's Projektübersicht (spec §1/§3):
 * an outer subtle-surface card whose upper part is a raised "header card"
 * (rounded bottom, subtle divider shadow) carrying the project name, status
 * chip and summary line; below it a footer strip with the last-activity
 * timestamp and a per-card settings shortcut.
 *
 * The whole card opens the project via a stretched, resume-aware link; the
 * settings gear is a separate, independently focusable link layered above it
 * (no nested anchors).
 */

import Link from 'next/link'
import { Settings } from 'lucide-react'
import { type JSX, useMemo } from 'react'
import { motion, springSnappy } from '@/components/motion'
import type { Project } from '@/lib/db/schema'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import { useLocale, useTranslations } from '@/i18n'
import { getProjectStatus, ProjectStatusChip } from './project-status'

interface ProjectCardProps {
  project: Project
  /** Number of documents ingested into the project corpus. */
  docCount?: number
}

export function ProjectCard({ project, docCount = 0 }: ProjectCardProps): JSX.Element {
  const t = useTranslations('projects')
  const { locale } = useLocale()
  const status = getProjectStatus(project)
  const summary = project.profileDisplay?.summary?.trim() || t('card.summaryFallback')

  // Last activity: the schema carries no dedicated lastActivityAt — the most
  // recent signal available is the profile update, falling back to creation.
  const activity = project.profileUpdatedAt ?? project.createdAt
  const activityIso = useMemo(() => new Date(activity).toISOString(), [activity])

  // docCount is accepted for API stability but the card face mirrors the
  // click-dummy (name · address · last activity) and does not surface it.
  void docCount

  // Opening a project always lands on Chat — the project's primary workspace
  // (click-dummy IA, spec §5). A plain anchor keeps prefetch and
  // open-in-new-tab working.
  const href = `/app/projects/${project.id}/chat`

  return (
    <motion.div className="h-full" whileHover={{ y: -3 }} whileTap={{ scale: 0.985 }} transition={springSnappy}>
      <article className="relative flex h-full flex-col overflow-hidden rounded-xl border border-border bg-muted/50 shadow-xs transition-shadow duration-200 ease-out hover:shadow-md motion-reduce:transition-none">
        {/* Raised header card — white surface, rounded bottom, soft divider shadow. */}
        <div className="rounded-b-[10px] bg-card px-4 pb-3 pt-3.5 shadow-xs">
          <div className="flex items-center justify-between gap-2.5">
            <h3 className="min-w-0 truncate text-sm font-medium">
              <Link
                href={href}
                aria-label={t('card.open', { name: project.name })}
                className="after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring/50"
              >
                {project.name}
              </Link>
            </h3>
            <ProjectStatusChip status={status} />
          </div>

          <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">{summary}</p>
        </div>

        {/* Footer strip on the subtle surface: last activity · time · settings gear. */}
        <div className="mt-auto flex items-center gap-2 px-4 py-2.5">
          <span className="text-xs text-muted-foreground">{t('card.lastActivity')}</span>
          <time
            dateTime={activityIso}
            title={formatAbsoluteTime(activityIso, locale)}
            suppressHydrationWarning
            className="ml-auto truncate text-xs tabular-nums text-muted-foreground"
          >
            {formatRelativeTime(activityIso, locale)}
          </time>
          <Link
            href={`/app/projects/${project.id}/settings`}
            aria-label={t('card.settingsAria', { name: project.name })}
            className="relative z-10 -mr-1 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none"
          >
            <Settings className="size-3.5" aria-hidden />
          </Link>
        </div>
      </article>
    </motion.div>
  )
}
