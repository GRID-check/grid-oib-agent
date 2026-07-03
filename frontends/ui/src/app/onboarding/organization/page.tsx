// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Organization onboarding page
 *
 * Shown to authenticated users who do not yet have an active WorkOS organization
 * (no org_id in their access token). Collects an organization name and calls
 * POST /api/organizations to create the org, add the user as admin, and refresh
 * the session. Redirects to the home page on success.
 */

'use client'

import { type FormEvent, type ReactNode, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Card, Flex, FormField, Logo, Stack, Text, TextInput } from '@/adapters/ui'
import { CheckCircle, Folder, Lock, Users } from '@/adapters/ui/icons'
import { StarfieldAnimation } from '@/shared/components/StarfieldAnimation'

const OrganizationOnboardingPage = (): ReactNode => {
  const router = useRouter()
  const [name, setName] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()

    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('Organization name is required.')
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      const response = await fetch('/api/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to create organization.')
      }

      router.replace('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="relative min-h-[100dvh] overflow-hidden bg-surface-sunken p-6 md:p-10">
      <div className="pointer-events-none absolute -right-28 top-8 h-[640px] w-[640px] opacity-25">
        <StarfieldAnimation particleCount={260} maxRadius={270} rotationSpeed={0.001} />
      </div>

      <div className="relative mx-auto grid min-h-[calc(100dvh-5rem)] w-full max-w-6xl grid-cols-1 items-center gap-8 lg:grid-cols-[1.05fr_0.95fr]">
        <section className="space-y-8">
          <Logo kind="horizontal" className="h-9" />
          <Flex direction="col" gap="4" className="max-w-2xl">
            <Text kind="body/regular/xs" className="text-subtle uppercase tracking-[0.24em]">
              first workspace
            </Text>
            <Text kind="title/xl" className="text-primary tracking-[-0.04em] md:text-5xl md:leading-none">
              Set the organization boundary before Grid handles project data.
            </Text>
            <Text kind="body/regular/md" className="max-w-xl text-subtle">
              This creates the WorkOS organization, makes you an admin, and refreshes the session so project access starts from the right tenant.
            </Text>
          </Flex>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              { icon: Lock, label: 'Auth bound' },
              { icon: Users, label: 'Admin role' },
              { icon: Folder, label: 'Projects ready' },
            ].map(({ icon: Icon, label }) => (
              <div key={label} className="rounded-[1.25rem] border border-base bg-surface-raised-30 p-4">
                <Icon className="mb-3 h-5 w-5 text-brand" />
                <Text kind="label/semibold/sm" className="text-primary">
                  {label}
                </Text>
              </div>
            ))}
          </div>
        </section>

        <Card className="relative z-10 w-full rounded-[2rem] border-base bg-surface-raised-30 p-6 shadow-[0_35px_100px_-75px_rgba(15,23,42,0.8)] md:p-8">
          <Stack gap="6">
            <Flex direction="col" gap="2">
              <Text kind="body/regular/xs" className="text-subtle uppercase tracking-[0.24em]">
                organization setup
              </Text>
              <Text kind="title/lg" className="text-primary">
                Create your control room
              </Text>
              <Text kind="body/regular/md" className="text-secondary">
                Use the legal team, office, or client organization name.
              </Text>
            </Flex>

            {error && (
              <Flex
                direction="col"
                gap="2"
                className="bg-status-error-muted border-status-error w-full rounded-2xl border p-4"
              >
                <Text kind="label/semibold/sm" className="text-status-error">
                  Organization setup failed
                </Text>
                <Text kind="body/regular/sm">{error}</Text>
              </Flex>
            )}

            <form onSubmit={handleSubmit} className="w-full">
              <Stack gap="4" className="w-full">
                <FormField slotLabel="Organization name" className="w-full">
                  <TextInput
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Grid Bauphysik Vienna"
                    disabled={isSubmitting}
                    className="w-full"
                  />
                </FormField>
                <Button
                  type="submit"
                  kind="primary"
                  size="large"
                  disabled={isSubmitting || !name.trim()}
                  className="w-full transition active:scale-[0.98]"
                >
                  {isSubmitting ? 'Creating...' : 'Create organization'}
                </Button>
              </Stack>
            </form>

            <Flex direction="col" gap="3" className="border-t border-base pt-5">
              {['Create WorkOS organization', 'Attach current user as admin', 'Refresh session and enter Grid'].map((item) => (
                <Flex key={item} align="center" gap="3">
                  <CheckCircle className="h-4 w-4 text-brand" />
                  <Text kind="body/regular/sm" className="text-subtle">
                    {item}
                  </Text>
                </Flex>
              ))}
            </Flex>
          </Stack>
        </Card>
      </div>
    </main>
  )
}

export default OrganizationOnboardingPage
