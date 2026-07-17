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
import { FileText, Settings } from 'lucide-react'
import { useMemo } from 'react'
import { motion, springSnappy } from '@/components/motion'
import type { Project } from '@/lib/db/schema'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import { useLocale, useTranslations } from '@/i18n'
import { useResumeProjectHref } from '@/hooks/use-last-project-section'
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

  const docLabel = t('card.docLabel', {
    count: docCount,
    unit: docCount === 1 ? t('card.document') : t('card.documents'),
  })

  // Resume into the section last used for this project. SSR-safe: renders the
  // project root on the server and upgrades to the remembered section after
  // mount, so there's no hydration mismatch and the anchor still supports
  // open-in-new-tab. Direct deep links never pass through here.
  const href = useResumeProjectHref(project.id)

  return (
    <motion.div className="h-full" whileHover={{ y: -3 }} whileTap={{ scale: 0.985 }} transition={springSnappy}>
      <article className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-muted/50 shadow-xs transition-shadow duration-200 ease-out hover:shadow-md motion-reduce:transition-none">
        {/* Raised header card — white surface, rounded bottom, soft divider shadow. */}
        <div className="rounded-b-xl bg-card p-5 shadow-xs">
          <div className="flex items-start justify-between gap-3">
            <h3 className="min-w-0 text-base font-semibold tracking-tight">
              <Link
                href={href}
                aria-label={t('card.open', { name: project.name })}
                className="after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring/50"
              >
                {project.name}
              </Link>
            </h3>
            <ProjectStatusChip status={status} />
          </div>

          <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted-foreground">{summary}</p>

          <p className="mt-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <FileText className="size-3.5" aria-hidden />
            {docLabel}
          </p>
        </div>

        {/* Footer strip on the subtle surface: last activity + settings gear. */}
        <div className="mt-auto flex items-center justify-between gap-3 px-5 py-3">
          <p className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
            <span className="text-[10.5px] font-medium uppercase tracking-[0.05em]">{t('card.lastActivity')}</span>
            <time
              dateTime={activityIso}
              title={formatAbsoluteTime(activityIso, locale)}
              suppressHydrationWarning
              className="truncate tabular-nums"
            >
              {formatRelativeTime(activityIso, locale)}
            </time>
          </p>
          <Link
            href={`/app/projects/${project.id}/settings`}
            aria-label={t('card.settingsAria', { name: project.name })}
            className="relative z-10 -m-1.5 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none"
          >
            <Settings className="size-4" aria-hidden />
          </Link>
        </div>
      </article>
    </motion.div>
  )
}
