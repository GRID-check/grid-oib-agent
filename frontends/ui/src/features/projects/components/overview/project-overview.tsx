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
 * What comes from the server (the brief, documents, standards, spend) arrives
 * as props. Memory and the roster are fetched by their tiles, from the same
 * endpoints their sections use, so a tile never shows a number its section
 * would not.
 */

import type { JSX } from 'react'
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
import { BentoGrid, BentoTile, type BentoSpan } from '@/components/ui/bento'
import { Button } from '@/components/ui/button'
import { useLocale, useTranslations } from '@/i18n'
import { formatBytes, formatDate } from '@/lib/format'
import type { FolderWithoutRole, ProjectOverviewData } from '../../types'
import { settingsSectionHref } from '../../lib/settings-sections'
import { FoldersWithoutRole } from '../folders-without-role'
import { ProjectDeleteDialog } from '../project-delete-dialog'
import { ProjectRenameDialog } from '../project-rename-dialog'
import type { ProjectUsageView } from '../settings/usage-settings'
import { ActivityPanel, type ProjectActivityView } from './activity-panel'
import { DocumentsTile } from './documents-tile'
import { MembersTile, MemoryTile } from './live-tiles'
import { UsageTile } from './usage-tile'

export interface ProjectOverviewAccess {
  /** Rename and delete (`project:manage`). */
  manage: boolean
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
  /**
   * Folders whose roles were deleted since (ADR-0088), for a project manager.
   * Empty shows nothing; otherwise a warning sits above the grid, because a
   * folder nobody can read is something to fix, not a figure to glance at.
   */
  foldersWithoutRole?: readonly FolderWithoutRole[]
  access: ProjectOverviewAccess
}

export function ProjectOverview({
  data,
  activity,
  usage,
  foldersWithoutRole = [],
  access,
}: ProjectOverviewProps): JSX.Element {
  const id = data.id
  // Documents and Memory stack beside the hero, so every reader's first two
  // rows are full. Below them, Usage and Members share a row when a reader gets
  // both and either takes the whole row alone; a hole in a bento reads as
  // something missing.
  const usageSpan: BentoSpan = access.manageMembers ? 'major' : 'wide'
  const membersSpan: BentoSpan = usage ? 'small' : 'wide'
  return (
    <div className="flex flex-col gap-4">
      <FoldersWithoutRole projectId={id} folders={foldersWithoutRole} />
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

  const menu = access.manage ? (
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
      entries={[
        {
          type: 'item',
          id: 'rename',
          label: t('project.overview.rename'),
          icon: Pencil,
          onSelect: () => setRenaming(true),
        },
        { type: 'separator' },
        {
          type: 'item',
          id: 'delete',
          label: t('project.overview.delete'),
          icon: Trash2,
          variant: 'destructive',
          onSelect: () => setDeleting(true),
        },
      ]}
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
        <p className="text-balance text-2xl font-semibold tracking-tight md:text-3xl">
          {data.name}
        </p>
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
        <>
          <ProjectRenameDialog
            projectId={data.id}
            projectName={data.name}
            open={renaming}
            onOpenChange={setRenaming}
          />
          <ProjectDeleteDialog
            projectId={data.id}
            projectName={data.name}
            open={deleting}
            onOpenChange={setDeleting}
          />
        </>
      )}
    </BentoTile>
  )
}
