'use client'

/**
 * Product-tour dev preview: the real tours over the real chrome, from fixtures,
 * started through the same three roads the product uses.
 *
 * Which screen — `?variant=`:
 * - `welcome` (default): the org header over an empty projects home.
 * - `project`: the project rail beside an empty chat.
 *
 * Which reader:
 * - `?tour=welcome` / `?tour=project` — the CREATOR, handed over by onboarding
 *   or by the first intake save ("your organization is ready").
 * - `?joined=1` — the JOINER on a first visit: the server marked the tour
 *   eligible ("welcome to Musterarchitektur"). Add `&member=1` for someone who
 *   cannot manage the organization.
 * - neither — a REPLAY from the account menu.
 *
 * `?archiv=0` / `?inbox=0` turn those features off. Fixture data only; the
 * `/dev` layout 404s this outside development.
 */

import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { MessageSquare } from 'lucide-react'
import { AppSidebar } from '@/components/shell/app-sidebar'
import { OrgHeader } from '@/components/shell/org-header'
import { ShellContent } from '@/components/shell'
import { ProjectsGrid } from '@/components/projects/projects-grid'
import { EmptyState } from '@/components/ui/empty-state'
import { ProductTour, useStartProductTour } from '@/features/onboarding/components/product-tour'
import { NO_TOURS, type TourId } from '@/features/onboarding/lib/product-tour'

const USER = { name: 'Anna Berger', email: 'anna.berger@example.at' }
const ORGANIZATION = 'Musterarchitektur ZT GmbH'
const PROJECTS = [{ id: 'p-1', name: 'Wohnbau Seestadt Baufeld D12' }]

/** The replay road: what the account menu's "Product tour" entry does. */
function Replay(): null {
  const start = useStartProductTour()
  useEffect(() => {
    const timer = window.setTimeout(start, 400)
    return () => window.clearTimeout(timer)
  }, [start])
  return null
}

function Preview(): JSX.Element {
  const params = useSearchParams()
  const variant: TourId = params.get('variant') === 'project' ? 'project' : 'welcome'
  const joined = params.get('joined') === '1'
  // Read once: the tour takes `?tour=` out of the URL as it starts, and the
  // preview must not then mistake itself for a replay and start it again.
  const [handover] = useState(() => params.has('tour'))
  const flags = {
    canAccessArchiv: params.get('archiv') !== '0',
    canAccessInbox: params.get('inbox') !== '0',
    canManageOrganization: params.get('member') !== '1',
  }
  const chrome = {
    user: USER,
    organizationName: ORGANIZATION,
    authRequired: false,
    canViewOrganization: true,
    canManagePlatform: false,
    ...flags,
  }

  return (
    <ProductTour
      {...flags}
      eligible={joined ? { welcome: true, project: true } : NO_TOURS}
      tourAt={() => variant}
    >
      {variant === 'project' ? (
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
      {!joined && !handover && <Replay />}
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
