'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Settings } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

export interface ProjectSwitcherProject {
  id: string
  name: string
}

export interface ProjectSwitcherProps {
  projects: ProjectSwitcherProject[]
  activeProjectId?: string
  collapsed?: boolean
}

/**
 * A small dashed-ring status dot — the click dummy's project marker. Green
 * (`--status-active`) for the active project, quiet ink otherwise. The color
 * always travels with the project label beside it, never alone.
 */
function StatusDot({ active }: { active?: boolean }) {
  const color = active ? 'var(--status-active)' : 'var(--muted-foreground)'
  return (
    <span
      className="flex size-3.5 shrink-0 items-center justify-center rounded-full border border-dashed"
      style={{ borderColor: color }}
      aria-hidden
    >
      <span className="size-[5px] rounded-full" style={{ backgroundColor: color }} />
    </span>
  )
}

export function ProjectSwitcher({ projects, activeProjectId, collapsed }: ProjectSwitcherProps) {
  const router = useRouter()
  const t = useTranslations('nav')
  const active = projects.find((p) => p.id === activeProjectId)
  const [open, setOpen] = React.useState(false)

  return (
    <DropdownMenu onOpenChange={setOpen}>
      <DropdownMenuTrigger
        className={cn(
          'flex h-9 w-full items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 text-left shadow-xs',
          'transition-[color,background-color,border-color,box-shadow,transform] duration-quick ease-out',
          'hover:bg-accent active:scale-[0.98] motion-reduce:transition-none',
          'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none',
          collapsed && 'w-10 justify-center px-0',
        )}
        aria-label={
          active
            ? t('projectSwitcher.switchCurrent', { name: active.name })
            : t('projectSwitcher.select')
        }
      >
        <StatusDot active={Boolean(active)} />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
              {active?.name ?? t('projectSwitcher.select')}
            </span>
            <span
              className={cn(
                'flex size-3.5 shrink-0 transition-transform duration-quick ease-out motion-reduce:transition-none',
                open && 'rotate-180',
              )}
              aria-hidden
            >
              <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
            </span>
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="w-60 motion-reduce:animate-none">
        <DropdownMenuLabel className="text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
          {t('projectSwitcher.switchHeading')}
        </DropdownMenuLabel>
        {projects.map((project) => {
          const isCurrent = project.id === activeProjectId
          return (
            <DropdownMenuItem
              key={project.id}
              // Switching into a project always lands on its Chat — the
              // project's primary workspace (spec §5).
              onSelect={() => router.push(`/app/projects/${project.id}/chat`)}
              className="gap-2.5 pr-1.5"
            >
              <StatusDot active={isCurrent} />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[13px]',
                  isCurrent ? 'font-medium text-foreground' : 'text-foreground/90',
                )}
              >
                {project.name}
              </span>
              <button
                type="button"
                aria-label={t('projectSwitcher.projectSettings', { name: project.name })}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  router.push(`/app/projects/${project.id}/settings`)
                }}
                // ≥44px touch target (a11y) via padding, with the icon kept
                // small; negative margin keeps the row from growing.
                className="-my-2 -mr-1.5 flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,transform] duration-quick ease-out hover:bg-accent hover:text-foreground active:scale-[0.98] motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
              >
                <Settings className="size-3.5" aria-hidden />
              </button>
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => router.push('/app/projects')}
          className="text-[13px] font-medium text-foreground"
        >
          {t('projectSwitcher.viewAllProjects')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
