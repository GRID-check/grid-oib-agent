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
    <Flex
      direction="col"
      align="center"
      justify="center"
      className="bg-surface-sunken relative min-h-screen p-8"
    >
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-30">
        <div className="h-[600px] w-[600px]">
          <StarfieldAnimation particleCount={250} maxRadius={250} rotationSpeed={0.001} />
        </div>
      </div>

      <Card className="relative z-10 w-full max-w-md p-6">
        <Stack gap="6" align="center">
          <Logo kind="horizontal" className="h-8" />

          <Flex direction="col" gap="2" align="center">
            <Text kind="title/lg">Create your organization</Text>
            <Text kind="body/regular/md" className="text-secondary text-center">
              Set up your team workspace to continue.
            </Text>
          </Flex>

          {error && (
            <Flex
              direction="col"
              gap="2"
              className="bg-status-error-muted border-status-error w-full rounded-md border p-4"
            >
              <Text kind="label/semibold/sm" className="text-status-error">
                Error
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
                  placeholder="Acme Corp"
                  disabled={isSubmitting}
                  className="w-full"
                />
              </FormField>
              <Button
                type="submit"
                kind="primary"
                size="large"
                disabled={isSubmitting || !name.trim()}
                className="w-full"
              >
                {isSubmitting ? 'Creating...' : 'Create organization'}
              </Button>
            </Stack>
          </form>
        </Stack>
      </Card>
    </Flex>
  )
}

export default OrganizationOnboardingPage
