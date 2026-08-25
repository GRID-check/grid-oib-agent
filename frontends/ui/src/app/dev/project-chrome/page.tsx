'use client'

/**
 * Dev preview for the shared project-section chrome: title + actions on one
 * line, one fixture per section that uses it.
 *
 * The gallery's point is that the sections line up — same band height, same
 * title baseline, whatever sits in the action slot (a button, a search field,
 * nothing at all). Chat is the documented exception and is not shown. Archiv and
 * Inbox are org-scoped (OrgTopbar, not the project rail) but they share the same
 * PageHeader molecule, so they sit in their own group at the bottom.
 *
 * A client page: the History fixture hands `SearchField` an `onChange`, and a
 * function prop cannot cross the server boundary — without this the route threw
 * and the screenshot target captured the error page.
 *
 * Not linked from anywhere; the `/dev` layout 404s this outside development.
 */

import type { ReactNode } from 'react'

import { LayoutGrid, List, ListTree, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { SearchField } from '@/components/ui/search-field'
import { SectionLabel } from '@/components/ui/section-label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { FileSearchField } from '@/features/documents/components/file-search-bar'

/**
 * One section's header inside the band the shell wraps it in, so the gallery
 * shows the real height rather than a bare `PageHeader`.
 */
function Chrome({ title, action }: { title: string; action?: ReactNode }): JSX.Element {
  return (
    <div className="border-b border-border bg-background px-4 py-4 md:px-8">
      <PageHeader title={title} action={action} />
    </div>
  )
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
        {/* Files carries the fullest action slot in the app — view toggles,
            assignment filter, the corpus search and Upload. It is the width
            case: if the header row survives here, it survives everywhere. */}
        <Chrome
          title="Files"
          action={
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
              <ToggleGroup type="single" value="cards" segmented size="icon-sm" aria-label="View">
                <ToggleGroupItem value="cards" aria-label="Cards">
                  <LayoutGrid />
                </ToggleGroupItem>
                <ToggleGroupItem value="list" aria-label="List">
                  <List />
                </ToggleGroupItem>
                <ToggleGroupItem value="tree" aria-label="Folders">
                  <ListTree />
                </ToggleGroupItem>
              </ToggleGroup>
              <ToggleGroup type="single" value="all" size="sm" aria-label="Responsible">
                <ToggleGroupItem value="all" className="px-2 text-xs">
                  All
                </ToggleGroupItem>
                <ToggleGroupItem value="mine" className="px-2 text-xs">
                  Mine
                </ToggleGroupItem>
                <ToggleGroupItem value="unassigned" className="px-2 text-xs">
                  Unassigned
                </ToggleGroupItem>
              </ToggleGroup>
              {/* The real control, not a lookalike — the run button is part of
                  the width this row has to survive. */}
              <FileSearchField
                className="basis-full sm:w-56 sm:basis-auto lg:w-64"
                value=""
                onChange={() => undefined}
                onSubmit={() => undefined}
                onClear={() => undefined}
                placeholder="Search files..."
                searchLabel="Search files"
                resetLabel="Reset search"
                canSearch
                runLabel="Search"
                isSearching={false}
              />
              <Button type="button">Upload</Button>
            </div>
          }
        />
        <Chrome
          title="History"
          action={
            <SearchField
              type="text"
              className="w-48 sm:w-64"
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
          action={
            <Button type="button" size="sm">
              <Plus className="size-4" aria-hidden />
              New job
            </Button>
          }
        />
        <Chrome
          title="Skills"
          action={
            <Button type="button" size="sm">
              <Plus className="size-4" aria-hidden />
              New skill
            </Button>
          }
        />
      </Group>

      <Group label="Project">
        <Chrome title="Knowledge" />
        <Chrome title="Settings" />
        <Chrome title="Setup" />
      </Group>

      <Group label="Organization">
        <Chrome title="Archiv" />
        <Chrome title="Inbox" />
      </Group>
    </main>
  )
}
