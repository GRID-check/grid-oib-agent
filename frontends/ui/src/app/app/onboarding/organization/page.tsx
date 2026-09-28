/**
 * Organization onboarding page
 *
 * Shown to authenticated users who do not yet have an active organization.
 * Calls POST /api/organizations to create the organization, add the user as
 * admin, and refresh the session; then hands over to the projects home with
 * the product tour queued (`TOUR_START_URL`). The screen itself is
 * {@link OrganizationSetup}; this route owns only the data.
 */

'use client'

import { type ReactNode, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/adapters/auth/use-auth'
import { OrganizationSetup } from '@/features/onboarding/components/organization-setup'
import { TOUR_START_URL } from '@/features/onboarding/lib/product-tour'
import { useTranslations } from '@/i18n'
import { capturePosthog } from '@/lib/analytics/posthog'

/** The "you're in" beat before the hand-off. Long enough to read, no longer. */
const HANDOFF_DELAY_MS = 1200

const OrganizationOnboardingPage = (): ReactNode => {
  const t = useTranslations('onboarding')
  const { user, signOut } = useAuth()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [createdName, setCreatedName] = useState<string | null>(null)
  const [selfServeDisabled, setSelfServeDisabled] = useState(false)

  // Surface the invite-only policy BEFORE the user types anything.
  useEffect(() => {
    fetch('/api/organizations')
      .then(async (res) => (res.ok ? ((await res.json()) as { selfServeDisabled?: boolean }) : {}))
      .then((policy) => setSelfServeDisabled(Boolean(policy.selfServeDisabled)))
      .catch(() => {})
  }, [])

  const create = async (name: string): Promise<void> => {
    setError(null)
    try {
      const response = await fetch('/api/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string }
        // The API returns stable error codes, never raw provider messages —
        // translate them here.
        if (data.error === 'self-serve-disabled') throw new Error(t('errors.selfServeDisabled'))
        throw new Error(t('errors.createFailed'))
      }

      capturePosthog('organization_created')
      setCreatedName(name)
      // Straight to the projects home (no bounce through the home redirect),
      // with the tour queued for arrival.
      setTimeout(() => router.replace(TOUR_START_URL), HANDOFF_DELAY_MS)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.generic'))
    }
  }

  return (
    <OrganizationSetup
      email={user?.email}
      selfServeDisabled={selfServeDisabled}
      createdName={createdName}
      error={error}
      onCreate={create}
      onSignOut={() => signOut()}
    />
  )
}

export default OrganizationOnboardingPage
