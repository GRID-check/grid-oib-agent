'use client'

import Link from 'next/link'
import { Database, FileText, HardDrive, MessageSquare, Upload } from 'lucide-react'
import type { ProjectOverviewData } from '../types'
import { ApplicableStandards } from './applicable-standards'
import { ProjectBrief } from './project-brief'
import { ProjectDangerZone } from './project-danger-zone'
import { ProjectMemoryPanel } from './project-memory-panel'
import { Stagger, StaggerItem } from '@/components/motion'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { formatFileSize } from '@/lib/utils/format-file-size'
import { useLocale, useTranslations, type Translator } from '@/i18n'
import { useMemo } from 'react'

interface ProjectOverviewProps {
  data: ProjectOverviewData
  /**
   * Whether the current user can delete the project (project:manage). The
   * danger zone is only rendered when true — a viewer/editor never sees the
   * type-to-confirm ritual for an action the API will reject.
   */
  canManageProject?: boolean
}

type BadgeVariant = 'success' | 'info' | 'destructive' | 'secondary'

const DOC_STATUSES = [
  'uploaded',
  'ready',
  'ingested',
  'success',
  'pending',
  'ingesting',
  'processing',
  'uploading',
  'failed',
]

/** One consistent status vocabulary for document badges (design-language token map). */
function statusVariant(status: string | null): BadgeVariant {
  switch (status) {
    case 'uploaded':
    case 'ready':
    case 'ingested':
    case 'success':
      return 'success'
    case 'pending':
    case 'ingesting':
    case 'processing':
    case 'uploading':
      return 'info'
    case 'failed':
      return 'destructive'
    default:
      return 'secondary'
  }
}

function statusLabel(status: string | null, t: Translator): string {
  if (!status) return t('overview.docStatus.unknown')
  if (DOC_STATUSES.includes(status)) return t(`overview.docStatus.${status}`)
  return status.charAt(0).toUpperCase() + status.slice(1)
}

export function ProjectOverview({ data, canManageProject = false }: ProjectOverviewProps) {
  const t = useTranslations('projects')
  const { locale } = useLocale()
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }),
    [locale],
  )
  const profile = data.profileDisplay
  const hasDocuments = data.documentCount > 0

  let createdLabel = ''
  try {
    createdLabel = dateFormatter.format(new Date(data.createdAt))
  } catch {
    createdLabel = ''
  }

  return (
    <Stagger className="mx-auto w-full max-w-5xl space-y-8 px-4 py-6 md:space-y-10 md:px-8 md:py-10">
      {/* Header */}
      <StaggerItem>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{data.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {createdLabel
              ? t('overview.workspaceCreated', { date: createdLabel })
              : t('overview.workspace')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href={`/app/projects/${data.id}/chat`}>
              <MessageSquare className="size-4" aria-hidden />
              {t('overview.askGrid')}
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/app/projects/${data.id}/files`}>
              <Upload className="size-4" aria-hidden />
              {t('overview.uploadFiles')}
            </Link>
          </Button>
        </div>
      </header>
      </StaggerItem>

      {/* Project Brief — the architect-owned context Grid works from. Never blank. */}
      <StaggerItem>
        <ProjectBrief
          projectId={data.id}
          profile={data.profile}
          summary={profile?.summary}
          briefStarted={profile != null}
        />
      </StaggerItem>

      {/* Applicable OIB standards — derived from the brief, orientation only. */}
      <StaggerItem>
        <ApplicableStandards
          projectId={data.id}
          standards={data.applicableStandards}
          briefComplete={data.briefComplete}
        />
      </StaggerItem>

      {/* Project memory — what Grid has learned about this project, user-curated. */}
      <StaggerItem>
        <ProjectMemoryPanel projectId={data.id} />
      </StaggerItem>

      {/* Stats */}
      <StaggerItem>
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-5">
        <div className="rounded-2xl border bg-card p-6 shadow-xs transition-shadow duration-200 ease-out hover:shadow-sm">
          <div className="flex size-9 items-center justify-center rounded-xl bg-muted text-primary">
            <FileText className="size-4" aria-hidden />
          </div>
          <p className="mt-4 text-2xl font-semibold tracking-tight tabular-nums">{data.documentCount}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('overview.stats.files')}</p>
        </div>
        <div className="rounded-2xl border bg-card p-6 shadow-xs transition-shadow duration-200 ease-out hover:shadow-sm">
          <div className="flex size-9 items-center justify-center rounded-xl bg-muted text-primary">
            <HardDrive className="size-4" aria-hidden />
          </div>
          <p className="mt-4 text-2xl font-semibold tracking-tight tabular-nums">
            {formatFileSize(data.totalFileSize)}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('overview.stats.totalSize')}</p>
        </div>
        <div className="col-span-2 rounded-2xl border bg-card p-6 shadow-xs transition-shadow duration-200 ease-out hover:shadow-sm sm:col-span-1">
          <div className="flex size-9 items-center justify-center rounded-xl bg-muted text-primary">
            <Database className="size-4" aria-hidden />
          </div>
          <p className="mt-4 truncate font-mono text-sm text-foreground" title={data.collectionName}>
            {data.collectionName}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('overview.stats.knowledgeBase')}</p>
        </div>
      </section>
      </StaggerItem>

      {/* Recent Files */}
      <StaggerItem>
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {t('overview.recentFiles.heading')}
          </h2>
          {hasDocuments && (
            <Link
              href={`/app/projects/${data.id}/files`}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {t('overview.recentFiles.viewAll')}
            </Link>
          )}
        </div>

        {hasDocuments ? (
          <div className="divide-y divide-border overflow-hidden rounded-2xl border bg-card shadow-xs">
            {data.recentDocuments.map((doc) => (
              <div key={doc.id} className="flex items-center justify-between gap-3 px-4 py-3.5 transition-colors duration-200 ease-out hover:bg-muted/40 sm:gap-4 sm:px-6">
                <div className="flex min-w-0 items-center gap-3">
                  <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate text-sm">{doc.filename}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {formatFileSize(doc.fileSize)}
                  </span>
                </div>
                <Badge variant={statusVariant(doc.status)}>{statusLabel(doc.status, t)}</Badge>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={FileText}
            title={t('overview.recentFiles.emptyTitle')}
            description={t('overview.recentFiles.emptyDescription')}
            action={
              <Button asChild>
                <Link href={`/app/projects/${data.id}/files`}>{t('overview.recentFiles.emptyAction')}</Link>
              </Button>
            }
          />
        )}
      </section>
      </StaggerItem>

      {/* Danger zone — soft delete with grace-period restore. Only shown to
          users who can actually delete (project:manage); viewers/editors never
          see a destructive ritual the API would reject. */}
      {canManageProject && (
        <StaggerItem>
          <ProjectDangerZone projectId={data.id} projectName={data.name} />
        </StaggerItem>
      )}
    </Stagger>
  )
}
