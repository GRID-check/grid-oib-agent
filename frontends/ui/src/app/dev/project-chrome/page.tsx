'use client'

/*
 * A client component only because `SearchField` is a controlled input and this
 * fixture hands it a no-op `onChange`. As a server component the page threw
 * "Event handlers cannot be passed to Client Component props" and returned 500,
 * so the `project-chrome` target in `visual/registry.mjs` — declared with
 * `mobile: true` — has never produced a screenshot.
 */

/**
 * Dev preview for the shared project-section chrome: title + subtitle +
 * actions, one fixture per section that uses it. No breadcrumb — the rail
 * already names where a section sits, and a trail repeating it here cost
 * every page a row for something the reader was not missing.
 *
 * Chat is the documented exception and is not shown. Archiv and Inbox are
 * org-scoped (OrgTopbar, not the project rail) but they share the same
 * PageHeader molecule, so they sit in their own group at the bottom.
 *
 * Not linked from anywhere; the `/dev` layout 404s this outside development.
 */

import type { JSX, ReactNode } from 'react'

import { Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { SearchField } from '@/components/ui/search-field'
import { SectionLabel } from '@/components/ui/section-label'

function Chrome({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle: string
  action?: ReactNode
}): JSX.Element {
  return <PageHeader title={title} subtitle={subtitle} action={action} />
}

function Group({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <section className="space-y-6">
      <SectionLabel>{label}</SectionLabel>
      <div className="space-y-10">{children}</div>
    </section>
  )
}

export default function ProjectChromePreviewPage(): JSX.Element {
  return (
    <main data-testid="project-chrome-preview" className="bg-background space-y-12 p-8 text-foreground">
      <Group label="Work">
        <Chrome
          title="Files"
          subtitle="Documents that ground Piloti’s answers in this project."
          action={<Button type="button">Upload</Button>}
        />
        <Chrome
          title="History"
          subtitle="Every conversation and deep-research run in this project."
          action={
            <SearchField
              type="text"
              className="w-full sm:w-64"
              value=""
              onChange={() => undefined}
              placeholder="Search history…"
              label="Search conversations by title"
            />
          }
        />
      </Group>

      <Group label="Automate">
        <Chrome
          title="Jobs"
          subtitle="Prompts this project runs on a timer."
          action={
            <Button type="button" size="sm">
              <Plus className="size-4" aria-hidden />
              New job
            </Button>
          }
        />
        <Chrome
          title="Skills"
          subtitle="Reusable instructions the organization writes once."
          action={
            <Button type="button" size="sm">
              <Plus className="size-4" aria-hidden />
              New skill
            </Button>
          }
        />
      </Group>

      <Group label="Project">
        <Chrome
          title="Knowledge"
          subtitle="What the knowledge base currently contains."
        />
        <Chrome
          title="Settings"
          subtitle="Project profile, members, memory, and danger zone."
        />
        <Chrome
          title="Setup"
          subtitle="Guided briefing for this project."
        />
      </Group>

      <Group label="Organization">
        <Chrome
          title="Archiv"
          subtitle="Shared documents available to every project in your organization"
        />
        <Chrome
          title="Inbox"
          subtitle="Requests and updates from your team."
        />
      </Group>
    </main>
  )
}
