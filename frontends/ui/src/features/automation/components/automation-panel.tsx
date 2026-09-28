'use client'

import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ListChecks, Sparkles } from 'lucide-react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SkillsPanel } from '@/features/skills/components/skills-panel'
import { TasksPanel } from '@/features/tasks/components/tasks-panel'
import type { TasksView } from '@/features/tasks/lib/tasks-view'
import { useTranslations } from '@/i18n'
import { parseAutomationTab, tabForDeepLink, type AutomationTab } from '../lib/automation-tab'

/**
 * Automation — Tasks and Skills as tabs inside ONE project section.
 *
 * The two answer two different questions; `lib/automation-tab.ts` is where
 * that split is argued. Tasks leads because it is the one asked most often.
 *
 * Only the ACTIVE tab is mounted. That is load-bearing, not an optimization:
 * panels portal their primary action into the shared section header via
 * `ProjectSectionActions`, which is a single slot — two mounted panels would
 * fight over it.
 *
 * The tab rides `?tab=` via `history.replaceState`, so a deep link lands on the
 * right tab and switching costs no server round-trip. A DRAWER deep link
 * (`?task=` for a run, `?schedule=` for a standing task) wins over `?tab=`,
 * because both params live on the Tasks tab — the panel simply opens it.
 */

interface AutomationPanelProps {
  projectId: string
  projectCollection: string
  /** May create/edit/delete org skills (`org:skills:manage`). */
  canManageOrgSkills: boolean
  /** May create/edit/run/delete this project's tasks (`project:skills:manage`). */
  canManageJobs: boolean
  /**
   * Whether this member may use the agent in this project (`project:chat`).
   * Resolved server-side beside the schedule gate and forwarded into Tasks:
   * without it Delegieren would link a reader into a locked composer.
   */
  canChatInProject?: boolean
  initialTab: AutomationTab
  /**
   * The tasks view to open with — from `?view=`, or the timetable for a legacy
   * `?tab=schedule` link, which meant the scheduled tasks.
   */
  initialView?: TasksView
}

/** The tab a `?task=` / `?schedule=` on the URL belongs to, if there is one. */
function deepLinkTab(): AutomationTab | null {
  try {
    if (typeof window === 'undefined') return null
    return tabForDeepLink(new URL(window.location.href).searchParams)
  } catch {
    return null
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
  initialView = 'list',
}: AutomationPanelProps): JSX.Element {
  const t = useTranslations('nav')
  const [tab, setTab] = useState<AutomationTab>(() => deepLinkTab() ?? initialTab)
  // Corrects `?tab=` once so the address bar matches the tab above: without it,
  // closing a drawer opened from `?tab=skills&task=…` would leave `?tab=skills`
  // over the Tasks list, and a copied link would reopen the wrong tab.
  const correctedRef = useRef(false)

  useEffect(() => {
    if (correctedRef.current) return
    const forced = deepLinkTab()
    if (!forced || forced === initialTab) return
    correctedRef.current = true
    setTab(forced)
    try {
      window.history.replaceState(null, '', tabHref(forced))
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
          initialView={initialView}
        />
      </TabsContent>
      <TabsContent value="skills" className="min-h-0 overflow-y-auto">
        <SkillsPanel canManageOrgSkills={canManageOrgSkills} />
      </TabsContent>
    </Tabs>
  )
}
