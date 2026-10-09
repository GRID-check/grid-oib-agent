'use client'

/**
 * The tiles that load in the browser, from the endpoints their sections read,
 * so a tile and its section can never disagree about a count.
 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Brain, Pin, Users } from 'lucide-react'
import { AvatarStack } from '@/components/ui/avatar-stack'
import { BentoFigure, BentoTile, type BentoSpan } from '@/components/ui/bento'
import { Chip } from '@/components/ui/chip'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'

type Load<T> = { state: 'loading' } | { state: 'error' } | { state: 'ready'; value: T }

/** One GET, read once on mount; aborted if the tile unmounts first. */
function useJson<T>(url: string, pick: (body: unknown) => T): Load<T> {
  const [load, setLoad] = useState<Load<T>>({ state: 'loading' })
  useEffect(() => {
    const controller = new AbortController()
    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        setLoad({ state: 'ready', value: pick(await res.json()) })
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoad({ state: 'error' })
      })
    return () => controller.abort()
    // `pick` is a pure projection; re-reading on its identity would refetch every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])
  return load
}

function TileSkeleton(): JSX.Element {
  return (
    <div className="space-y-2" aria-hidden>
      <Skeleton className="h-8 w-16" />
      <Skeleton className="h-4 w-32" />
    </div>
  )
}

interface MemoryNote {
  id: string
  content: string
  pinned: boolean
  verification: string
}

/** How much Piloti has noted, how much a person still has to look at, and the pinned notes. */
export function MemoryTile({
  projectId,
  href,
  span = 'small',
}: {
  projectId: string
  href: string
  span?: BentoSpan
}): JSX.Element {
  const t = useTranslations('settings')
  const load = useJson(
    `/api/projects/${encodeURIComponent(projectId)}/memory`,
    (body) => ((body as { items?: MemoryNote[] }).items ?? []) as MemoryNote[]
  )

  return (
    <BentoTile
      label={t('project.overview.memory.label')}
      icon={Brain}
      span={span}
      href={href}
      linkLabel={t('project.overview.memory.open')}
      data-testid="overview-memory"
    >
      {load.state === 'loading' && <TileSkeleton />}
      {load.state === 'error' && (
        <p className="text-muted-foreground text-sm">{t('project.overview.memory.error')}</p>
      )}
      {load.state === 'ready' && <MemoryBody notes={load.value} />}
    </BentoTile>
  )
}

function MemoryBody({ notes }: { notes: readonly MemoryNote[] }): JSX.Element {
  const t = useTranslations('settings')
  if (notes.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('project.overview.memory.empty')}</p>
  }
  const toReview = notes.filter((note) => note.verification === 'unverified').length
  const shown = [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned)).slice(0, 2)

  return (
    <>
      <div className="flex items-end justify-between gap-3">
        <BentoFigure
          value={notes.length}
          caption={t('project.overview.memory.notes', { count: notes.length })}
        />
        <Chip variant={toReview > 0 ? 'warning' : 'success'} size="sm">
          {toReview > 0
            ? t('project.overview.memory.toReview', { count: toReview })
            : t('project.overview.memory.allReviewed')}
        </Chip>
      </div>
      <ul className="flex flex-col gap-1.5 text-sm">
        {shown.map((note) => (
          <li key={note.id} className="flex items-start gap-1.5">
            {note.pinned && (
              <Pin className="text-muted-foreground mt-1 size-3 shrink-0" aria-hidden />
            )}
            <span className="line-clamp-2 min-w-0">{note.content}</span>
          </li>
        ))}
      </ul>
    </>
  )
}

interface RosterEntry {
  userId: string
  name: string
  profilePictureUrl: string | null
  role: string | null
}

/** Who is assigned to the project: the faces and the count. */
export function MembersTile({
  projectId,
  href,
  span = 'small',
}: {
  projectId: string
  href: string
  span?: BentoSpan
}): JSX.Element {
  const t = useTranslations('settings')
  const load = useJson(`/api/projects/${encodeURIComponent(projectId)}/members`, (body) =>
    (((body as { members?: RosterEntry[] }).members ?? []) as RosterEntry[]).filter(
      (member) => member.role
    )
  )

  return (
    <BentoTile
      label={t('project.overview.members.label')}
      icon={Users}
      span={span}
      href={href}
      linkLabel={t('project.overview.members.open')}
      data-testid="overview-members"
    >
      {load.state === 'loading' && <TileSkeleton />}
      {load.state === 'error' && (
        <p className="text-muted-foreground text-sm">{t('project.overview.members.error')}</p>
      )}
      {load.state === 'ready' &&
        (load.value.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('project.overview.members.empty')}</p>
        ) : (
          <>
            <BentoFigure
              value={load.value.length}
              caption={t('project.overview.members.count', { count: load.value.length })}
            />
            <AvatarStack
              people={load.value.map((member) => ({
                userId: member.userId,
                name: member.name,
                profilePictureUrl: member.profilePictureUrl,
              }))}
              max={6}
            />
          </>
        ))}
    </BentoTile>
  )
}
