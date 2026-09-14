'use client'

import { useEffect, useRef, useState } from 'react'
import { ListChecks, Sparkles } from 'lucide-react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SkillsPanel } from '@/features/skills/components/skills-panel'
import { TasksPanel } from '@/features/tasks/components/tasks-panel'
import { useTranslations } from '@/i18n'
import { parseAutomationTab, type AutomationTab } from '../lib/automation-tab'

/**
 * Automation — Aufgaben and Skills as tabs inside ONE project section.
 *
 * The two answer two different questions: a TASK is work somebody handed over —
 * a one-off handover or the recurring schedule that fires it, which migration
 * 0086 collapsed into one row — and a SKILL is a reusable instruction the
 * ORGANIZATION owns. Aufgaben leads because it is the question a person asks
 * first; schedules are the group at the top of that same list, not a tab.
 *
 * Only the ACTIVE tab is mounted. That is load-bearing, not an optimization:
 * panels portal their primary action (delegating, a new schedule, a new skill)
 * into the shared section header via `ProjectSectionActions`, which is a
 * single slot — two mounted panels would fight over it.
 *
 * The tab rides `?tab=` via `history.replaceState`, so a deep link lands on
 * the right tab and switching costs no server round-trip. Aufgaben is the
 * default; `?tab=jobs` parses to Aufgaben, so the retired tab's bookmarks and
 * inbox deep links keep answering.
 */

interface AutomationPanelProps {
  projectId: string
  projectCollection: string
  /** May create/edit/delete org skills (`org:skills:manage`). */
  canManageOrgSkills: boolean
  /** May create/edit/run/delete this project's schedules (`project:skills:manage`). */
  canManageJobs: boolean
  /**
   * Whether this member may use the agent in this project (`project:chat`).
   * Resolved server-side beside the schedule gate and forwarded into Aufgaben:
   * without it Delegieren would link a reader into a locked composer.
   */
  canChatInProject?: boolean
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
  canChatInProject = true,
  initialTab,
}: AutomationPanelProps): JSX.Element {
  const t = useTranslations('nav')
  // A drawer deep link wins over the tab: `?tab=skills&task=` opens the task,
  // because the drawer lives on Aufgaben. (Same window-guarded initializer
  // shape TasksPanel uses for `?task=` itself.)
  const [tab, setTab] = useState<AutomationTab>(() =>
    hasDrawerSelection() ? 'tasks' : initialTab
  )
  // Corrects `?tab=` once so the address bar matches the tab above: without
  // it closing the drawer would leave `?tab=skills` over the Aufgaben list, and
  // a copied link would reopen the wrong tab.
  const correctedTabRef = useRef(false)
  // The tab the URL asked for, and whether the reader has picked one since.
  // A drawer deep link that never matches a row must not strand them on the
  // rewritten `?tab=tasks`: untouched since mount, they go back to this.
  const initialTabRef = useRef(initialTab)
  const tabTouchedRef = useRef(false)

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

  // A mount deep link that never matched a row here restores the requested
  // tab — but only when the reader has not picked one since: their explicit
  // switch wins over the link's failure. The drawer stays open on the
  // unresolved copy either way; the TasksPanel already dropped the dead
  // `?task=` / `?schedule=` params, so this only moves `?tab=` back.
  const handleDeepLinkSettled = (resolved: boolean): void => {
    if (resolved) return
    if (tabTouchedRef.current) return
    if (initialTabRef.current === 'tasks') return
    setTab(initialTabRef.current)
    try {
      window.history.replaceState(null, '', tabHref(initialTabRef.current))
    } catch {
      // History unavailable (embedded preview) — the tab still switches.
    }
  }

  const selectTab = (value: string): void => {
    const next = parseAutomationTab(value)
    tabTouchedRef.current = true
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
      {/* One slim bar. The frame above already carries the section title and
          its subtitle, so a second full-width description strip here read as a
          doubled header; the tabs are the only thing this row owes. */}
      <div className="border-border shrink-0 border-b px-4 py-2 md:px-6">
        <TabsList>
          <TabsTrigger value="tasks">
            <ListChecks aria-hidden />
            {t('sections.tasks')}
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
          canChatInProject={canChatInProject}
          onDeepLinkSettled={handleDeepLinkSettled}
        />
      </TabsContent>
      <TabsContent value="skills" className="min-h-0 overflow-y-auto">
        <SkillsPanel canManageOrgSkills={canManageOrgSkills} />
      </TabsContent>
    </Tabs>
  )
}
