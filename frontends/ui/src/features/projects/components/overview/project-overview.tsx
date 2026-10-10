'use client'

/**
 * The project Overview: a bento dashboard of where this project stands.
 *
 * It replaced a settings page. A person opening a project's hub wants to know
 * how the project is doing (is the briefing complete, what is it costing, what
 * has Piloti learned, who is on it) and only now and then to change something.
 * So every tile is a live summary with one number up front, and opens the
 * section where that thing is changed. Renaming and deleting moved into the
 * hero's menu: one deliberate click away, out of the reading flow.
 *
 * What comes from the server (documents, activity, spend, the Steckbrief)
 * arrives as props; similar projects stream in through a Suspense slot. Memory
 * and the roster are fetched by their tiles, from the same endpoints their
 * sections use, so a tile never shows a number its section would not.
 */

import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import Link from 'next/link'
import {
  CalendarDays,
  ClipboardList,
  FileText,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react'
import { ActionMenu } from '@/components/ui/action-menu'
import { BentoCell, BentoGrid, BentoTile, type BentoSpan } from '@/components/ui/bento'
import { Button } from '@/components/ui/button'
import { ProjectStatusChip } from '@/components/projects/project-status'
import type { SteckbriefView } from '@/lib/projects/steckbrief-types'
import { useLocale, useTranslations } from '@/i18n'
import { formatBytes, formatDate } from '@/lib/format'
import type { ProjectOverviewData } from '../../types'
import { settingsSectionHref } from '../../lib/settings-sections'
import { ProjectDeleteDialog } from '../project-delete-dialog'
import { ProjectLifecycleCard } from '../project-lifecycle-card'
import { ProjectRenameDialog } from '../project-rename-dialog'
import { ProjectSteckbrief, type SteckbriefAccount } from '../project-steckbrief'
import type { ProjectUsageView } from '../settings/usage-settings'
import { ActivityPanel, type ProjectActivityView } from './activity-panel'
import { DocumentsTile } from './documents-tile'
import { MembersTile, MemoryTile } from './live-tiles'
import { UsageTile } from './usage-tile'

export interface ProjectOverviewAccess {
  /** Rename (`project:manage`, refused in a closed project). */
  manage: boolean
  /** Close, reopen and delete: `project:manage` even when closed (ADR-0090). */
  changeStatus: boolean
  /** The closing debrief's confirm and lesson (`project:memory:write`). */
  writeMemory: boolean
  /** Open the intake wizard (`project:edit`). */
  editProfile: boolean
  /** The roster tile (`project:members:manage`). */
  manageMembers: boolean
}

export interface ProjectOverviewProps {
  data: ProjectOverviewData
  /** Questions asked, for everyone: counts only, never whose or which. */
  activity: ProjectActivityView
  /** Null for a reader who may not see the project's spend. */
  usage: ProjectUsageView | null
  /** The Steckbrief (ADR-0091): period and people, what stays once the project closes. */
  steckbrief?: SteckbriefView
  /** Accounts a Steckbrief person may be linked to; empty unless the reader may edit it. */
  steckbriefAccounts?: readonly SteckbriefAccount[]
  /**
   * The similar-projects tile, streamed: finding them reads every closed
   * project's memory and permits, and the rest of the dashboard should not wait
   * for that. The page passes a Suspense boundary here.
   */
  similar?: ReactNode
  access: ProjectOverviewAccess
}

export function ProjectOverview({
  data,
  activity,
  usage,
  steckbrief,
  steckbriefAccounts = [],
  similar,
  access,
}: ProjectOverviewProps): JSX.Element {
  const id = data.id
  // Documents and Memory stack beside the hero, so every reader's first two
  // rows are full. Below them, Usage and Members share a row when a reader gets
  // both and either takes the whole row alone; a hole in a bento reads as
  // something missing.
  const usageSpan: BentoSpan = access.manageMembers ? 'major' : 'wide'
  const membersSpan: BentoSpan = usage ? 'small' : 'wide'
  // The project's record beside the control that closes it; alone, the record
  // takes the row.
  const steckbriefSpan: BentoSpan = access.changeStatus ? 'major' : 'wide'
  return (
    <div className="flex flex-col gap-4">
      <BentoGrid data-testid="project-overview">
        <HeroTile data={data} activity={activity} access={access} />
        <DocumentsTile
          documentCount={data.documentCount}
          totalFileSize={data.totalFileSize}
          recent={data.recentDocuments}
          href={settingsSectionHref(id, 'documents')}
        />
        <MemoryTile projectId={id} href={settingsSectionHref(id, 'memory')} />
        {usage && (
          <UsageTile usage={usage} href={settingsSectionHref(id, 'usage')} span={usageSpan} />
        )}
        {access.manageMembers && (
          <MembersTile
            projectId={id}
            href={settingsSectionHref(id, 'members')}
            span={membersSpan}
          />
        )}
        {steckbrief && (
          <BentoCell span={steckbriefSpan}>
            <ProjectSteckbrief projectId={id} steckbrief={steckbrief} accounts={steckbriefAccounts} />
          </BentoCell>
        )}
        {/* Close or reopen (ADR-0090): the one change a closed project allows. */}
        {access.changeStatus && (
          <BentoCell span={steckbrief ? 'small' : 'wide'}>
            <ProjectLifecycleCard
              projectId={id}
              status={data.status}
              closedAt={data.closedAt}
              profile={data.profile}
              startedOn={steckbrief?.startedOn ?? null}
              canWriteMemory={access.writeMemory}
            />
          </BentoCell>
        )}
        {similar}
      </BentoGrid>
    </div>
  )
}

function HeroTile({
  data,
  activity,
  access,
}: {
  data: ProjectOverviewData
  activity: ProjectActivityView
  access: ProjectOverviewAccess
}): JSX.Element {
  const t = useTranslations('settings')
  const { locale } = useLocale()
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const projectPath = `/app/projects/${encodeURIComponent(data.id)}`
  const summary = data.profileDisplay?.summary?.trim()

  const entries = [
    ...(access.manage
      ? [
          {
            type: 'item' as const,
            id: 'rename',
            label: t('project.overview.rename'),
            icon: Pencil,
            onSelect: () => setRenaming(true),
          },
        ]
      : []),
    ...(access.manage && access.changeStatus ? [{ type: 'separator' as const }] : []),
    // Deleting stays open in a closed project: it is still the way to remove it.
    ...(access.changeStatus
      ? [
          {
            type: 'item' as const,
            id: 'delete',
            label: t('project.overview.delete'),
            icon: Trash2,
            variant: 'destructive' as const,
            onSelect: () => setDeleting(true),
          },
        ]
      : []),
  ]

  const menu =
    entries.length > 0 ? (
      <ActionMenu
        mode="dropdown"
        trigger={
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground size-7"
            aria-label={t('project.overview.actions')}
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </Button>
        }
        entries={entries}
      />
    ) : undefined

  return (
    <BentoTile
      label={t('project.overview.createdOn', { date: formatDate(data.createdAt, locale) })}
      icon={CalendarDays}
      span="hero"
      action={menu}
      bodyClassName="gap-4 p-6 md:p-8"
      data-testid="overview-hero"
    >
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <p className="text-balance text-2xl font-semibold tracking-tight md:text-3xl">
            {data.name}
          </p>
          {data.status === 'closed' && <ProjectStatusChip status="closed" size="sm" />}
        </div>
        <p
          className={
            summary
              ? 'text-foreground/80 line-clamp-3 max-w-3xl text-pretty leading-relaxed'
              : 'text-muted-foreground max-w-3xl text-pretty leading-relaxed'
          }
        >
          {summary ?? t('project.overview.summaryEmpty')}
        </p>
        <p className="text-muted-foreground text-sm tabular-nums">
          {t('project.overview.documentsCount', { count: data.documentCount })}
          {' · '}
          {formatBytes(data.totalFileSize, locale)}
        </p>
      </div>

      <ActivityPanel activity={activity} />

      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link href={`${projectPath}/chat?new=1`}>
            <MessageSquare className="size-4" aria-hidden />
            {t('project.overview.askPiloti')}
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={`${projectPath}/files`}>
            <FileText className="size-4" aria-hidden />
            {t('project.overview.openFiles')}
          </Link>
        </Button>
        {access.editProfile && (
          <Button asChild variant="outline">
            <Link href={`${projectPath}/intake`}>
              <ClipboardList className="size-4" aria-hidden />
              {data.profileDisplay != null
                ? t('project.overview.editBrief')
                : t('project.overview.setUpBrief')}
            </Link>
          </Button>
        )}
      </div>

      {access.manage && (
        <ProjectRenameDialog
          projectId={data.id}
          projectName={data.name}
          open={renaming}
          onOpenChange={setRenaming}
        />
      )}
      {access.changeStatus && (
        <ProjectDeleteDialog
          projectId={data.id}
          projectName={data.name}
          open={deleting}
          onOpenChange={setDeleting}
        />
      )}
    </BentoTile>
  )
}
