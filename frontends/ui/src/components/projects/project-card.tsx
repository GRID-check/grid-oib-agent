'use client'

import Link from 'next/link'
import { FileText, Folder } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { motion, springSnappy } from '@/components/motion'
import type { Project } from '@/lib/db/schema'
import { useLocale, useTranslations } from '@/i18n'
import { useMemo } from 'react'

interface ProjectCardProps {
  project: Project
  /** Number of documents ingested into the project corpus. */
  docCount?: number
}

export function ProjectCard({ project, docCount = 0 }: ProjectCardProps): JSX.Element {
  const t = useTranslations('projects')
  const { locale } = useLocale()
  const formatDate = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' })
    return (date: Date) => formatter.format(date)
  }, [locale])
  const summary = project.profileDisplay?.summary?.trim() || t('card.summaryFallback')

  const activityDate = project.profileUpdatedAt ?? project.createdAt
  const activityLabel = project.profileUpdatedAt
    ? t('card.updated', { date: formatDate(activityDate) })
    : t('card.created', { date: formatDate(activityDate) })

  const isActive = docCount > 0
  const docLabel = t('card.docLabel', {
    count: docCount,
    unit: docCount === 1 ? t('card.document') : t('card.documents'),
  })

  return (
    <Link
      href={`/app/projects/${project.id}`}
      className="group block h-full rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      aria-label={t('card.open', { name: project.name })}
    >
      <motion.div
        className="h-full"
        whileHover={{ y: -3 }}
        whileTap={{ scale: 0.985 }}
        transition={springSnappy}
      >
        <Card className="h-full gap-4 p-6 shadow-xs transition-shadow duration-200 ease-out group-hover:shadow-md">
          <div className="flex items-start justify-between gap-4">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-primary">
              <Folder className="size-4" />
            </div>
            <Badge variant={isActive ? 'success' : 'secondary'}>
              {isActive ? t('card.active') : t('card.draft')}
            </Badge>
          </div>

          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold tracking-tight">{project.name}</h3>
            <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">{summary}</p>
          </div>

          <div className="mt-auto flex items-center justify-between gap-4 border-t border-border pt-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <FileText className="size-3.5" />
              {docLabel}
            </span>
            <span className="tabular-nums">{activityLabel}</span>
          </div>
        </Card>
      </motion.div>
    </Link>
  )
}
