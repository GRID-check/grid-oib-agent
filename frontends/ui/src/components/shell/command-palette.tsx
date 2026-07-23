'use client'

/**
 * The command palette (⌘K / Ctrl+K) — keyboard-first navigation over things
 * the UI can already do: jump to a project, jump to a section of the current
 * project, and a handful of global actions (new project, organization,
 * profile, theme, sign out). Pure navigation/dispatch; no new capabilities.
 *
 * The project list is fetched lazily from the existing `GET /api/projects`
 * endpoint (the same list the project switcher renders) the first time the
 * palette opens.
 */

import * as React from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Building2, FolderKanban, LogOut, Moon, Plus, Sun, UserRound } from 'lucide-react'

import { useAuth } from '@/adapters/auth/use-auth'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { useLayoutStore } from '@/features/layout/store'
import { useTranslations } from '@/i18n'
import { paletteSections } from './project-sections'

interface PaletteProject {
  id: string
  name: string
}

/** Extract the active project id from `/app/projects/{id}[/…]`, if any. */
export function projectIdFromPathname(pathname: string): string | null {
  const match = /^\/app\/projects\/([^/]+)/.exec(pathname)
  return match ? match[1] : null
}

export interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Whether sign-out is meaningful (WorkOS auth configured). */
  authRequired: boolean
  /** Whether the organization page is reachable for this user. */
  canViewOrganization: boolean
  /** Whether the project knowledge page is enabled (feature-flagged, default off). */
  showKnowledge?: boolean
  /** Whether the Workflows page is enabled (feature-flagged, default off). */
  showWorkflows?: boolean
  /** Whether the org-wide Archiv is reachable (`organization-archiv`, ADR-0024). */
  canAccessArchiv?: boolean
}

export function CommandPalette({
  open,
  onOpenChange,
  authRequired,
  canViewOrganization,
  showKnowledge = false,
  showWorkflows = false,
  canAccessArchiv = false,
}: CommandPaletteProps) {
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const { signOut } = useAuth()
  const theme = useLayoutStore((s) => s.theme)
  const setTheme = useLayoutStore((s) => s.setTheme)
  const t = useTranslations('shortcuts.palette')
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')

  const projectId = projectIdFromPathname(pathname)

  // Lazy project list — fetched once, the first time the palette opens.
  const [projects, setProjects] = React.useState<PaletteProject[] | null>(null)
  React.useEffect(() => {
    if (!open || projects !== null) return
    let cancelled = false
    fetch('/api/projects')
      .then(async (res) => (res.ok ? ((await res.json()) as PaletteProject[]) : []))
      .then((rows) => {
        if (!cancelled) setProjects(rows.map((row) => ({ id: row.id, name: row.name })))
      })
      .catch(() => {
        if (!cancelled) setProjects([])
      })
    return () => {
      cancelled = true
    }
  }, [open, projects])

  const runCommand = React.useCallback(
    (action: () => void) => {
      onOpenChange(false)
      action()
    },
    [onOpenChange],
  )

  // "Toggle theme" flips between light and dark; from `system` it flips to
  // the opposite of what the device currently shows. Same store the user
  // menu's theme picker writes.
  const toggleTheme = React.useCallback(() => {
    const prefersDark =
      typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
    const isDark = theme === 'dark' || (theme === 'system' && prefersDark)
    setTheme(isDark ? 'light' : 'dark')
  }, [theme, setTheme])

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('title')}
      description={t('description')}
    >
      <CommandInput placeholder={t('placeholder')} />
      <CommandList>
        <CommandEmpty>{t('empty')}</CommandEmpty>

        {projects !== null && projects.length > 0 && (
          <CommandGroup heading={t('groups.projects')}>
            {projects.map((project) => (
              <CommandItem
                key={project.id}
                value={`project-${project.id} ${project.name}`}
                onSelect={() => runCommand(() => router.push(`/app/projects/${project.id}`))}
              >
                <FolderKanban className="text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {projectId && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t('groups.currentProject')}>
              {paletteSections({ showKnowledge, showWorkflows, canAccessArchiv }).map((item) => {
                const Icon = item.icon
                const label = tNav(`sections.${item.i18nKey}`)
                const href =
                  item.href ??
                  (item.segment
                    ? `/app/projects/${projectId}/${item.segment}`
                    : `/app/projects/${projectId}`)
                return (
                  <CommandItem
                    key={item.key}
                    value={`section-${item.key} ${label}`}
                    onSelect={() => runCommand(() => router.push(href))}
                  >
                    <Icon className="text-muted-foreground" aria-hidden />
                    {label}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading={t('groups.general')}>
          <CommandItem
            value={`new-project ${tNav('projectSwitcher.newProject')}`}
            onSelect={() => runCommand(() => router.push('/app/projects?new=1'))}
          >
            <Plus className="text-muted-foreground" aria-hidden />
            {tNav('projectSwitcher.newProject')}
          </CommandItem>
          <CommandItem
            value={`all-projects ${tNav('projectSwitcher.allProjects')}`}
            onSelect={() => runCommand(() => router.push('/app/projects'))}
          >
            <FolderKanban className="text-muted-foreground" aria-hidden />
            {tNav('projectSwitcher.allProjects')}
          </CommandItem>
          {canViewOrganization && (
            <CommandItem
              value={`organization ${tNav('userMenu.organization')}`}
              onSelect={() => runCommand(() => router.push('/app/organization'))}
            >
              <Building2 className="text-muted-foreground" aria-hidden />
              {tNav('userMenu.organization')}
            </CommandItem>
          )}
          <CommandItem
            value={`profile ${tNav('userMenu.profile')}`}
            onSelect={() => runCommand(() => router.push('/app/profile'))}
          >
            <UserRound className="text-muted-foreground" aria-hidden />
            {tNav('userMenu.profile')}
          </CommandItem>
          <CommandItem
            value={`toggle-theme ${t('toggleTheme')}`}
            onSelect={() => runCommand(toggleTheme)}
          >
            {theme === 'dark' ? (
              <Sun className="text-muted-foreground" aria-hidden />
            ) : (
              <Moon className="text-muted-foreground" aria-hidden />
            )}
            {t('toggleTheme')}
          </CommandItem>
          {authRequired && (
            <CommandItem
              value={`sign-out ${tCommon('actions.signOut')}`}
              onSelect={() => runCommand(() => void signOut())}
            >
              <LogOut className="text-muted-foreground" aria-hidden />
              {tCommon('actions.signOut')}
            </CommandItem>
          )}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
