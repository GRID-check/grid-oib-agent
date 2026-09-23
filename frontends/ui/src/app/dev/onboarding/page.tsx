'use client'

/**
 * Organization-setup dev preview: the real {@link OrganizationSetup} in each of
 * its states, from fixtures. `?state=` picks one — `form` (default), `error`,
 * `invite-only`, `done`. Submitting the form succeeds after a short delay, so
 * the hand-off beat can be watched without a backend.
 *
 * Fixture data only. The `/dev` layout 404s this outside development.
 */

import { useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import { OrganizationSetup } from '@/features/onboarding/components/organization-setup'

function Preview(): JSX.Element {
  const state = useSearchParams().get('state') ?? 'form'
  const [createdName, setCreatedName] = useState<string | null>(
    state === 'done' ? 'Musterarchitektur ZT GmbH' : null,
  )

  return (
    <OrganizationSetup
      email="anna.berger@example.at"
      selfServeDisabled={state === 'invite-only'}
      createdName={createdName}
      error={state === 'error' ? 'Failed to create organization.' : null}
      onCreate={async (name) => {
        await new Promise((resolve) => setTimeout(resolve, 600))
        setCreatedName(name)
      }}
      onSignOut={() => {}}
    />
  )
}

export default function OnboardingPreview(): JSX.Element {
  return (
    <Suspense>
      <Preview />
    </Suspense>
  )
}
