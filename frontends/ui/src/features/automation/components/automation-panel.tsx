'use client'

import { useEffect, useRef, useState } from 'react'
import { ListChecks, Repeat, Sparkles } from 'lucide-react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { JobsPanel } from '@/features/jobs/components/jobs-panel'
import { SkillsPanel } from '@/features/skills/components/skills-panel'
import { TasksPanel } from '@/features/tasks/components/tasks-panel'
import { useTranslations } from '@/i18n'
import { parseAutomationTab, type AutomationTab } from '../lib/automation-tab'

/**
 * Automation — Aufgaben, Jobs and Skills as tabs inside ONE project section.
 *
 * The three answer three different questions: a TASK is a single piece of work
 * somebody handed over and walked away from (ADR-0051), a JOB is the recurring
 * schedule behind it, and a SKILL is a reusable instruction the ORGANIZATION
 * owns. Aufgaben leads because it is the question a person asks first; Jobs is
 * the schedule management behind the list, Skills the org toolbox.
 *
 * Only the ACTIVE tab is mounted. That is load-bearing, not an optimization:
 * panels portal their primary action (delegating, a new schedule, a new skill)
 * into the shared section header via `ProjectSectionActions`, which is a
 * single slot — two mounted panels would fight over it.
 *
 * The tab rides `?tab=` via `history.replaceState`, so a deep link lands on
 * the right tab and switching costs no server round-trip. Aufgaben is the
 * default; `?tab=jobs` keeps its id so bookmarks, inbox rows and old links
 * still land on the schedules view.
 */

interface AutomationPanelProps {
  projectId: string
  projectCollection: string
  /** May create/edit/delete org skills (`org:skills:manage`). */
  canManageOrgSkills: boolean
  /** May create/edit/run/delete this project's jobs (`project:skills:manage`). */
  canManageJobs: boolean
  initialTab: AutomationTab
}

/** A drawer deep link off the URL — `?task=` for a run, `?schedule=` for one. */
function hasDrawerSelection(): boolean {
  try {
    if (typeof window === 'undefined') return false
    const params = new URL(window.location.href).searchParams
    return params.has('task') || params.has('schedule')
  } catch {
    return false
  }
}

/** The tab URL with every other param kept — a drawer deep link must survive. */
function tabHref(next: AutomationTab): string {
  const url = new URL(window.location.href)
  url.searchParams.set('tab', next)
  return `${url.pathname}${url.search}${url.hash}`
}

export function AutomationPanel({
  projectId,
  projectCollection,
  canManageOrgSkills,
  canManageJobs,
  initialTab,
}: AutomationPanelProps): JSX.Element {
  const t = useTranslations('nav')
  // A drawer deep link wins over the tab: `?tab=jobs&task=` opens the task,
  // because the drawer lives on Aufgaben. (Same window-guarded initializer
  // shape TasksPanel uses for `?task=` itself.)
  const [tab, setTab] = useState<AutomationTab>(() =>
    hasDrawerSelection() ? 'tasks' : initialTab
  )
  // Corrects `?tab=` once so the address bar matches the tab above: without
  // it closing the drawer would leave `?tab=jobs` over the Aufgaben list, and
  // a copied link would reopen the wrong tab.
  const correctedTabRef = useRef(false)

  useEffect(() => {
    if (correctedTabRef.current || !hasDrawerSelection() || initialTab === 'tasks') return
    correctedTabRef.current = true
    setTab('tasks')
    try {
      window.history.replaceState(null, '', tabHref('tasks'))
    } catch {
      // History unavailable (embedded preview) — the tab still switches.
    }
  }, [initialTab])

  const selectTab = (value: string): void => {
    const next = parseAutomationTab(value)
    setTab(next)
    try {
      // Shareable without a server round-trip; replace (not push) so the back
      // button leaves the section instead of replaying tab flips. Every other
      // param survives the switch, so a `?task=` / `?schedule=` drawer deep
      // link still resolves when its tab remounts.
      window.history.replaceState(null, '', tabHref(next))
    } catch {
      // History unavailable (embedded preview) — the tab still switches.
    }
  }

  return (
    <Tabs value={tab} onValueChange={selectTab} className="h-full min-h-0 gap-0">
      <div className="border-border shrink-0 border-b px-4 py-3 md:px-6">
        <TabsList>
          <TabsTrigger value="tasks">
            <ListChecks aria-hidden />
            {t('sections.tasks')}
          </TabsTrigger>
          <TabsTrigger value="jobs">
            <Repeat aria-hidden />
            {t('sections.jobs')}
          </TabsTrigger>
          <TabsTrigger value="skills">
            <Sparkles aria-hidden />
            {t('sections.skills')}
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="tasks" className="min-h-0 overflow-hidden">
        <TasksPanel
          projectId={projectId}
          projectCollection={projectCollection}
          canManageJobs={canManageJobs}
        />
      </TabsContent>
      <TabsContent value="jobs" className="min-h-0 overflow-hidden">
        <JobsPanel
          projectId={projectId}
          projectCollection={projectCollection}
          canManage={canManageJobs}
        />
      </TabsContent>
      <TabsContent value="skills" className="min-h-0 overflow-y-auto">
        <SkillsPanel canManageOrgSkills={canManageOrgSkills} />
      </TabsContent>
    </Tabs>
  )
}
