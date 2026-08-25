'use client'

/**
 * Shared chrome for every project section except Ask Piloti.
 *
 * Chat owns its own header. Every other project page used to invent one
 * (PageHeader vs a hand-rolled h1 vs a compact bar). The title and the action
 * slot live here so the pages only supply content — and, via
 * {@link ProjectSectionActions}, the controls that belong in this header
 * rather than a second one.
 */

import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react'
import { usePathname } from 'next/navigation'

import { PageHeader } from '@/components/ui/page-header'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

const PROJECT_SECTION_KEYS = [
  'files',
  'history',
  'jobs',
  'skills',
  'settings',
  'knowledge',
  'intake',
  'members',
  'model',
  'research',
] as const

type ProjectChromeSection = (typeof PROJECT_SECTION_KEYS)[number]

const PROJECT_SECTION_KEY_SET: ReadonlySet<string> = new Set(PROJECT_SECTION_KEYS)

const FILL_SECTIONS: ReadonlySet<ProjectChromeSection> = new Set(['files', 'jobs'])

const RETURN_TARGET_SECTIONS: ReadonlySet<ProjectChromeSection> = new Set(['members', 'model'])

const ActionsContext = createContext<(node: ReactNode) => void>(() => {})

function isProjectChromeSection(segment: string): segment is ProjectChromeSection {
  return PROJECT_SECTION_KEY_SET.has(segment)
}

function isProjectChatPath(pathname: string, projectId: string): boolean {
  const parts = pathname.split('/').filter(Boolean)
  return parts[0] === 'app' && parts[1] === 'projects' && parts[2] === projectId && parts[3] === 'chat'
}

function lastPathSegment(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/**
 * Portal the page's primary actions into {@link ProjectSectionFrame}'s header.
 * Renders nothing at the call site.
 */
export function ProjectSectionActions({ children }: { children: ReactNode }): null {
  const setActions = useContext(ActionsContext)
  useLayoutEffect(() => {
    setActions(children)
    return () => setActions(null)
  }, [children, setActions])
  return null
}

export function ProjectSectionFrame({
  projectId,
  projectName,
  children,
}: {
  projectId: string
  projectName: string
  children: ReactNode
}): JSX.Element {
  const pathname = usePathname() ?? ''
  const t = useTranslations('nav')
  const [actions, setActions] = useState<ReactNode>(null)

  if (isProjectChatPath(pathname, projectId)) {
    return <>{children}</>
  }

  const segment = lastPathSegment(pathname)
  const known = isProjectChromeSection(segment)
  const sectionLabel = !known
    ? projectName
    : RETURN_TARGET_SECTIONS.has(segment)
      ? t(`returnTargets.${segment}`)
      : t(`sections.${segment}`)
  const fill = known && FILL_SECTIONS.has(segment)

  return (
    <ActionsContext.Provider value={setActions}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b border-border bg-background px-4 py-4 md:px-8">
          <PageHeader title={sectionLabel} action={actions} />
        </div>
        <div className={cn('min-h-0 flex-1', fill ? 'overflow-hidden' : 'overflow-y-auto')}>{children}</div>
      </div>
    </ActionsContext.Provider>
  )
}
