'use client'

/**
 * Product-tour dev preview: the real tours over the real chrome, from fixtures.
 *
 * - `?variant=welcome` (default): the org header over an empty projects home —
 *   the screen a new organization's admin arrives on.
 * - `?variant=project`: the project rail beside an empty chat — the screen a
 *   first project lands on once its setup is saved.
 *
 * The tour starts on load, as it does after onboarding or setup; the account
 * menu's "Product tour" entry restarts it. `?archiv=0` / `?inbox=0` turn those
 * features off to show the shorter tours an organization without them gets.
 *
 * Not `?tour=`: that is the product's own arrival parameter, which the tour
 * strips from the URL as it starts — the preview would flip back to `welcome`.
 *
 * Fixture data only. The `/dev` layout 404s this outside development.
 */

import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect } from 'react'
import { MessageSquare } from 'lucide-react'
import { AppSidebar } from '@/components/shell/app-sidebar'
import { OrgHeader } from '@/components/shell/org-header'
import { ShellContent } from '@/components/shell'
import { ProjectsGrid } from '@/components/projects/projects-grid'
import { EmptyState } from '@/components/ui/empty-state'
import { ProductTour, useStartProductTour } from '@/features/onboarding/components/product-tour'
import type { TourId } from '@/features/onboarding/lib/product-tour'

const USER = { name: 'Anna Berger', email: 'anna.berger@example.at' }
const ORGANIZATION = 'Musterarchitektur ZT GmbH'
const PROJECTS = [{ id: 'p-1', name: 'Wohnbau Seestadt Baufeld D12' }]

function AutoStart(): null {
  const start = useStartProductTour()
  useEffect(() => {
    const timer = window.setTimeout(start, 400)
    return () => window.clearTimeout(timer)
  }, [start])
  return null
}

function Preview(): JSX.Element {
  const params = useSearchParams()
  const tour: TourId = params.get('variant') === 'project' ? 'project' : 'welcome'
  const flags = {
    canAccessArchiv: params.get('archiv') !== '0',
    canAccessInbox: params.get('inbox') !== '0',
  }
  const chrome = {
    user: USER,
    organizationName: ORGANIZATION,
    authRequired: false,
    canManageOrganization: true,
    canViewOrganization: true,
    canManagePlatform: false,
    ...flags,
  }

  return (
    <ProductTour {...flags} tourAt={() => tour}>
      {tour === 'project' ? (
        <div className="bg-background text-foreground flex h-dvh flex-col overflow-hidden md:flex-row">
          <AppSidebar projectId="p-1" projects={PROJECTS} showModels={false} showSkills={false} {...chrome} />
          <main className="bg-background relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
            <EmptyState
              variant="bare"
              icon={MessageSquare}
              title="Wohnbau Seestadt Baufeld D12"
              description="Chat placeholder — the real chat needs a backend."
              className="m-auto"
            />
          </main>
        </div>
      ) : (
        <div className="bg-background text-foreground flex h-dvh flex-col overflow-hidden">
          <OrgHeader {...chrome} />
          <main className="bg-background relative flex min-h-0 flex-1 flex-col overflow-y-auto">
            <ShellContent width="wide">
              <ProjectsGrid projects={[]} docCounts={{}} viewerActivity={{}} />
            </ShellContent>
          </main>
        </div>
      )}
      <AutoStart />
    </ProductTour>
  )
}

export default function ProductTourPreview(): JSX.Element {
  return (
    <Suspense>
      <Preview />
    </Suspense>
  )
}
