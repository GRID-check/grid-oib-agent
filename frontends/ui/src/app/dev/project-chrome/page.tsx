/**
 * Dev preview for the shared project-section chrome: breadcrumb + title +
 * subtitle + actions. Three stacked fixtures so one screenshot proves the
 * rhythm is the same on Files (primary action), History (search), and
 * Settings (no action). Chat is the documented exception and is not shown.
 *
 * Not linked from anywhere; the `/dev` layout 404s this outside development.
 */

import type { ReactNode } from 'react'

import { Search } from 'lucide-react'

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'

const PROJECT = 'Stadthaus Wien'

function Chrome({
  section,
  title,
  subtitle,
  action,
}: {
  section: string
  title: string
  subtitle: string
  action?: ReactNode
}): JSX.Element {
  return (
    <PageHeader
      title={title}
      subtitle={subtitle}
      action={action}
      breadcrumb={
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <span>{PROJECT}</span>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{section}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      }
    />
  )
}

export default function ProjectChromePreviewPage(): JSX.Element {
  return (
    <main data-testid="project-chrome-preview" className="bg-background space-y-10 p-8 text-foreground">
      <Chrome
        section="Files"
        title="Files"
        subtitle="Project corpus — these documents ground Piloti’s answers"
        action={<Button type="button">Upload</Button>}
      />
      <Chrome
        section="History"
        title="History"
        subtitle="Every conversation and deep-research run in this project."
        action={
          <div className="relative w-full sm:w-64">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              readOnly
              placeholder="Search history…"
              aria-label="Search conversations by title"
              className="h-9 rounded-md pl-9"
            />
          </div>
        }
      />
      <Chrome
        section="Settings"
        title="Settings"
        subtitle="Project parameters, members, memory, and the danger zone."
      />
    </main>
  )
}
