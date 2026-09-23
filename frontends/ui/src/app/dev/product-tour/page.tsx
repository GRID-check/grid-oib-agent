'use client'

/**
 * Product-tour dev preview: the real tour over the real org chrome and an empty
 * projects home — the exact screen a new organization's admin arrives on.
 *
 * The tour starts on load, as it does after onboarding; the account menu's
 * "Product tour" entry restarts it. `?archiv=0` / `?inbox=0` drop those
 * doorways to show the shorter tour an organization without them gets.
 *
 * Fixture data only. The `/dev` layout 404s this outside development.
 */

import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect } from 'react'
import { OrgHeader } from '@/components/shell/org-header'
import { ShellContent } from '@/components/shell'
import { ProjectsGrid } from '@/components/projects/projects-grid'
import { ProductTour, useStartProductTour } from '@/features/onboarding/components/product-tour'

const HOME = '/dev/product-tour'

function AutoStart(): null {
  const start = useStartProductTour()
  useEffect(() => {
    const timer = window.setTimeout(start, 300)
    return () => window.clearTimeout(timer)
  }, [start])
  return null
}

function Preview(): JSX.Element {
  const params = useSearchParams()
  return (
    <ProductTour home={HOME}>
      <div className="bg-background text-foreground flex h-dvh flex-col overflow-hidden">
        <OrgHeader
          user={{ name: 'Anna Berger', email: 'anna.berger@example.at' }}
          organizationName="Musterarchitektur ZT GmbH"
          authRequired={false}
          canManageOrganization
          canViewOrganization
          canManagePlatform={false}
          canAccessArchiv={params.get('archiv') !== '0'}
          canAccessInbox={params.get('inbox') !== '0'}
        />
        <main className="bg-background relative flex min-h-0 flex-1 flex-col overflow-y-auto">
          <ShellContent width="wide">
            <ProjectsGrid projects={[]} docCounts={{}} viewerActivity={{}} />
          </ShellContent>
        </main>
      </div>
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
