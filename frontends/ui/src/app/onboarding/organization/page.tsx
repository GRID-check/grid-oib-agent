// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Organization onboarding page
 *
 * Shown to authenticated users who do not yet have an active organization.
 * Collects an organization name and calls POST /api/organizations to create the
 * organization, add the user as admin, and refresh the session. Shows a brief
 * "workspace ready" confirmation before entering the projects workspace.
 */

'use client'

import { type ReactNode, useState } from 'react'
import { useRouter } from 'next/navigation'
import { z } from 'zod'
import { CheckCircle2, Folder, Lock, Users } from 'lucide-react'
import { useAppForm } from '@/components/form'
import { Card } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Spinner } from '@/components/ui/spinner'
import { Logo } from '@/components/brand/logo'
import { StarfieldAnimation } from '@/shared/components/StarfieldAnimation'

const organizationSchema = z.object({
  name: z.string().trim().min(1, 'Organization name is required.'),
})

const SETUP_STEPS = [
  'Create your organization',
  'Make you the workspace admin',
  'Open Grid and your first project',
]

const OrganizationOnboardingPage = (): ReactNode => {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'success'>('idle')

  const form = useAppForm({
    defaultValues: { name: '' },
    validators: { onChange: organizationSchema },
    onSubmit: async ({ value }) => {
      setError(null)

      try {
        const response = await fetch('/api/organizations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: value.name.trim() }),
        })

        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          throw new Error(data.error || 'Failed to create organization.')
        }

        // A deliberate "workspace ready" beat before entering the workspace,
        // then straight to /projects (no bounce through the home redirect).
        setStatus('success')
        setTimeout(() => router.replace('/projects'), 1400)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong.')
      }
    },
  })

  return (
    <main className="relative min-h-[100dvh] overflow-hidden bg-muted p-6 md:p-10">
      <div className="pointer-events-none absolute -right-28 top-8 h-[640px] w-[640px] opacity-25">
        <StarfieldAnimation particleCount={260} maxRadius={270} rotationSpeed={0.001} />
      </div>

      <div className="relative mx-auto grid min-h-[calc(100dvh-5rem)] w-full max-w-6xl grid-cols-1 items-center gap-8 lg:grid-cols-[1.05fr_0.95fr]">
        <section className="space-y-8">
          <Logo kind="horizontal" size="large" />
          <div className="flex max-w-2xl flex-col gap-4">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              first workspace
            </span>
            <h1 className="text-4xl font-semibold tracking-[-0.04em] md:text-5xl md:leading-none">
              Set your organization before Grid handles project data.
            </h1>
            <p className="max-w-xl text-sm text-muted-foreground">
              Your organization is the private boundary for your building projects — documents,
              members, and OIB/RIS research all live inside it. You become its admin.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              { icon: Lock, label: 'Private tenant' },
              { icon: Users, label: 'Admin access' },
              { icon: Folder, label: 'Projects ready' },
            ].map(({ icon: Icon, label }) => (
              <div key={label} className="rounded-lg border bg-card p-4">
                <Icon className="mb-3 h-5 w-5 text-primary" />
                <span className="text-sm font-semibold">{label}</span>
              </div>
            ))}
          </div>
        </section>

        <Card className="relative z-10 w-full gap-6 rounded-2xl p-6 shadow-lg md:p-8">
          {status === 'success' ? (
            <div className="flex flex-col gap-6" role="status" aria-live="polite">
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  workspace ready
                </span>
                <h2 className="text-lg font-semibold">You&rsquo;re all set</h2>
                <p className="text-sm text-muted-foreground">
                  Your organization is created and you&rsquo;re the admin.
                </p>
              </div>

              <div className="flex flex-col gap-3 border-t pt-5">
                {SETUP_STEPS.map((item) => (
                  <div key={item} className="flex items-center gap-3">
                    <CheckCircle2 className="h-4 w-4 text-primary" />
                    <span className="text-sm text-foreground">{item}</span>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2 border-t pt-5 text-sm text-muted-foreground">
                <Spinner size="sm" />
                Taking you to your projects…
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  organization setup
                </span>
                <h2 className="text-lg font-semibold">Name your organization</h2>
                <p className="text-sm text-muted-foreground">
                  Use your office, practice, or client organization name.
                </p>
              </div>

              {error && (
                <Alert variant="destructive">
                  <AlertTitle>Organization setup failed</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  form.handleSubmit()
                }}
                className="w-full"
              >
                <div className="flex w-full flex-col gap-4">
                  <form.AppField name="name">
                    {(field) => (
                      <field.TextField
                        label="Organization name"
                        placeholder="Grid Bauphysik Vienna"
                        autoFocus
                      />
                    )}
                  </form.AppField>
                  <form.AppForm>
                    <form.SubmitButton size="lg" className="w-full transition active:scale-[0.98]">
                      Create organization
                    </form.SubmitButton>
                  </form.AppForm>
                </div>
              </form>

              <div className="flex flex-col gap-3 border-t pt-5">
                {SETUP_STEPS.map((item) => (
                  <div key={item} className="flex items-center gap-3">
                    <CheckCircle2 className="h-4 w-4 text-primary" />
                    <span className="text-sm text-muted-foreground">{item}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>
    </main>
  )
}

export default OrganizationOnboardingPage
