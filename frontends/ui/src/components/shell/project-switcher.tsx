'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Check, ChevronsUpDown, FolderKanban, Plus } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { motion, springSnappy } from '@/components/motion'
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

export function ProjectSwitcher({ projects, activeProjectId, collapsed }: ProjectSwitcherProps) {
  const router = useRouter()
  const t = useTranslations('nav')
  const active = projects.find((p) => p.id === activeProjectId)
  const [open, setOpen] = React.useState(false)

  return (
    <DropdownMenu onOpenChange={setOpen}>
      <DropdownMenuTrigger
        className={cn(
          'flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm font-medium',
          'transition-colors duration-200 ease-out hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none',
          collapsed && 'justify-center px-0',
        )}
        aria-label={
          active
            ? t('projectSwitcher.switchCurrent', { name: active.name })
            : t('projectSwitcher.select')
        }
      >
        <span
          className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
          aria-hidden
        >
          <FolderKanban className="size-3.5" />
        </span>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate">{active?.name ?? t('projectSwitcher.select')}</span>
            <motion.span
              className="flex shrink-0"
              initial={false}
              animate={{ rotate: open ? 180 : 0 }}
              transition={springSnappy}
              aria-hidden
            >
              <ChevronsUpDown className="size-3.5 text-muted-foreground" aria-hidden />
            </motion.span>
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="w-60">
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">{t('projectSwitcher.projects')}</DropdownMenuLabel>
        {projects.map((project) => (
          <DropdownMenuItem
            key={project.id}
            onSelect={() => router.push(`/app/projects/${project.id}`)}
            className="gap-2"
          >
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            {project.id === activeProjectId && <Check className="size-4 shrink-0" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push('/app/projects')} className="gap-2">
          <FolderKanban className="size-4 text-muted-foreground" aria-hidden />
          {t('projectSwitcher.allProjects')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push('/app/projects?new=1')} className="gap-2">
          <Plus className="size-4 text-muted-foreground" aria-hidden />
          {t('projectSwitcher.newProject')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
