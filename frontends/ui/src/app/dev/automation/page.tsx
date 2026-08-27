'use client'

/**
 * Dev preview for the merged Automation section — Jobs and Skills as tabs
 * inside one project section (visual/registry.mjs → `automation-panel`). Not
 * linked anywhere and 404s outside development.
 *
 * The two panels have their own richer previews (`/dev/jobs-panel`,
 * `/dev/skills-panel`); what THIS page is evidence of is the join — the
 * segmented control, which tab leads, and that only the active tab mounts. The
 * fetch shim answers both panels' list calls with empty sets so the chrome is
 * the subject, not the fixtures.
 */

import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { AutomationPanel } from '@/features/automation/components/automation-panel'

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __automationShim?: boolean }
  if (!w.__automationShim) {
    w.__automationShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/skills') return Response.json({ skills: [] })
      if (url.includes('/jobs') && !url.includes('/runs') && !url.includes('/async/')) {
        return Response.json({ jobs: [] })
      }
      return real(input, init)
    }
  }
}

export default function AutomationDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="automation-preview"
        className="bg-background text-foreground flex h-dvh flex-col"
      >
        <AutomationPanel
          projectId="p1"
          projectCollection="proj_1"
          canManageOrgSkills
          canManageJobs
          initialTab="jobs"
        />
      </main>
    </I18nProvider>
  )
}
