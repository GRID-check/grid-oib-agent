'use client'

import { useState } from 'react'
import { ListChecks, Repeat, Sparkles } from 'lucide-react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { JobsPanel } from '@/features/jobs/components/jobs-panel'
import { SkillsPanel } from '@/features/skills/components/skills-panel'
import { TasksPanel } from '@/features/tasks/components/tasks-panel'
import { useTranslations } from '@/i18n'
import { parseAutomationTab, type AutomationTab } from '../lib/automation-tab'

/**
 * Automation — Jobs, Skills and Aufgaben as tabs inside ONE project section.
 *
 * The two were separate rail entries with deliberately identical framing and
 * one shared feature flag; what actually distinguished them is one sentence
 * (a job is a prompt THIS project runs on a timer, a skill is a reusable
 * instruction the ORGANIZATION owns), which is exactly what a segmented
 * control inside one section says better than two rail rows did.
 *
 * Aufgaben is the third, and it is the surface ADR-0051 deferred: `tasks` had a
 * durable row, an inbox item and a review verb, and no list — so a person who
 * delegated work from a chat had nowhere to ask what else was running or where
 * the result went. It offers no create verb, because the two gestures that make
 * a task („@Piloti prüf das …", „Piloti überarbeiten lassen") already say it
 * better than a form would.
 *
 * Only the ACTIVE tab is mounted. That is load-bearing, not an optimization:
 * both panels portal their primary action ("New job" / "New skill") into the
 * shared section header via `ProjectSectionActions`, which is a single slot —
 * two mounted panels would fight over it.
 *
 * The tab rides `?tab=` via `history.replaceState`, so a deep link lands on
 * the right tab and switching costs no server round-trip. Jobs leads and is
 * the default: it is the project-scoped half, and this page lives in a
 * project.
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

export function AutomationPanel({
  projectId,
  projectCollection,
  canManageOrgSkills,
  canManageJobs,
  initialTab,
}: AutomationPanelProps): JSX.Element {
  const t = useTranslations('nav')
  const [tab, setTab] = useState<AutomationTab>(initialTab)

  const selectTab = (value: string): void => {
    const next = parseAutomationTab(value)
    setTab(next)
    try {
      // Shareable without a server round-trip; replace (not push) so the back
      // button leaves the section instead of replaying tab flips.
      window.history.replaceState(null, '', `?tab=${next}`)
    } catch {
      // History unavailable (embedded preview) — the tab still switches.
    }
  }

  return (
    <Tabs value={tab} onValueChange={selectTab} className="h-full min-h-0 gap-0">
      <div className="border-border shrink-0 border-b px-4 py-3 md:px-6">
        <TabsList>
          <TabsTrigger value="jobs">
            <Repeat aria-hidden />
            {t('sections.jobs')}
          </TabsTrigger>
          <TabsTrigger value="skills">
            <Sparkles aria-hidden />
            {t('sections.skills')}
          </TabsTrigger>
          <TabsTrigger value="tasks">
            <ListChecks aria-hidden />
            {t('sections.tasks')}
          </TabsTrigger>
        </TabsList>
      </div>
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
      <TabsContent value="tasks" className="min-h-0 overflow-hidden">
        <TasksPanel projectId={projectId} />
      </TabsContent>
    </Tabs>
  )
}
