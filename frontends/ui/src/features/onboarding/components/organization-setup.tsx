'use client'

/**
 * The first screen a new customer sees after signing in: name the
 * organization, become its admin, go in.
 *
 * It used to open with a 5xl headline over a rotating starfield, three feature
 * tiles and the same three-step list twice, once as a promise and once as a
 * receipt. The design language asks for the opposite (no decoration, one focal
 * point, 20px page titles), and the screen asks one question, so it is now
 * built like the question it is: a narrow column, one field, one ink button,
 * and three quiet lines saying what happens next. Everything else it said was
 * restating the button.
 *
 * Presentational on purpose: the route (`app/app/onboarding/organization`)
 * owns the fetches, and `/dev/onboarding` renders every state from fixtures.
 * Sign-out stays in the header in every state: signed in with the wrong
 * account, or waiting on an invitation, must never be a dead end (UX-17).
 */

import * as React from 'react'
import { z } from 'zod'
import { Check, Compass, Lock, LogOut, UserPlus, type LucideIcon } from 'lucide-react'

import { useAppForm } from '@/components/form'
import { FadeIn } from '@/components/motion'
import { Logo } from '@/components/brand/logo'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyStateDisc } from '@/components/ui/empty-state'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import type { JSX } from 'react'

export interface OrganizationSetupProps {
  /** The signed-in account, shown beside sign-out. */
  email?: string | null
  /** The platform creates organizations itself; this person needs an invite. */
  selfServeDisabled: boolean
  /** Set once the organization exists: the screen becomes the hand-off. */
  createdName: string | null
  /** A translated failure from the last attempt. */
  error: string | null
  /** Resolves when created; rejects are the caller's to turn into `error`. */
  onCreate: (name: string) => Promise<void>
  onSignOut: () => void
}

export function OrganizationSetup({
  email,
  selfServeDisabled,
  createdName,
  error,
  onCreate,
  onSignOut,
}: OrganizationSetupProps): JSX.Element {
  const t = useTranslations('onboarding')
  const tc = useTranslations('common')

  return (
    <main id="main-content" className="bg-background flex min-h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 px-4 pt-[env(safe-area-inset-top)] md:px-6">
        <Logo kind="horizontal" size="small" />
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-muted-foreground hidden min-w-0 truncate text-xs sm:block">
            {email ? t('account.signedInAs', { email }) : t('account.signedIn')}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={onSignOut}>
            <LogOut className="size-3.5" aria-hidden />
            {tc('actions.signOut')}
          </Button>
        </div>
      </header>

      <div className="flex flex-1 justify-center px-4 pb-16 pt-[min(14vh,8rem)]">
        <FadeIn className="w-full max-w-sm" key={createdName ? 'done' : 'form'}>
          {createdName ? (
            <SetupDone name={createdName} />
          ) : selfServeDisabled ? (
            <InviteOnly onSignOut={onSignOut} />
          ) : (
            <SetupForm error={error} onCreate={onCreate} />
          )}
        </FadeIn>
      </div>
    </main>
  )
}

function SetupHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <p className="text-muted-foreground text-[10.5px] font-medium uppercase tracking-wider">{eyebrow}</p>
      <h1 className="mt-2 text-xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{children}</p>
    </div>
  )
}

function SetupForm({
  error,
  onCreate,
}: {
  error: string | null
  onCreate: (name: string) => Promise<void>
}): JSX.Element {
  const t = useTranslations('onboarding')

  const schema = z.object({
    name: z.string().trim().min(1, t('validation.nameRequired')).max(100, t('validation.nameTooLong')),
  })

  const form = useAppForm({
    defaultValues: { name: '' },
    validators: { onChange: schema },
    onSubmit: async ({ value }) => onCreate(value.name.trim()),
  })

  const next: { icon: LucideIcon; label: string }[] = [
    { icon: Lock, label: t('next.private') },
    { icon: UserPlus, label: t('next.admin') },
    { icon: Compass, label: t('next.tour') },
  ]

  return (
    <div>
      <SetupHeading eyebrow={t('form.eyebrow')} title={t('form.title')}>
        {t('form.description')}
      </SetupHeading>

      {error && (
        <Alert variant="destructive" className="mt-6">
          <AlertTitle>{t('errors.title')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card className="mt-6 px-5">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void form.handleSubmit()
          }}
          className="flex flex-col gap-4"
        >
          <form.AppField name="name">
            {(field) => (
              <field.TextField
                label={t('form.nameLabel')}
                placeholder={t('form.namePlaceholder')}
                description={t('form.nameHint')}
                autoComplete="organization"
                enterKeyHint="go"
                autoFocus
              />
            )}
          </form.AppField>
          <form.AppForm>
            <form.SubmitButton className="w-full">{t('form.submit')}</form.SubmitButton>
          </form.AppForm>
        </form>
      </Card>

      <section className="mt-8" aria-labelledby="setup-next">
        <h2 id="setup-next" className="text-muted-foreground text-[10.5px] font-medium uppercase tracking-wider">
          {t('next.heading')}
        </h2>
        <ul className="mt-3 space-y-2.5">
          {next.map(({ icon: Icon, label }) => (
            <li key={label} className="text-muted-foreground flex items-start gap-2.5 text-sm">
              <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{label}</span>
            </li>
          ))}
        </ul>
      </section>

      <p className="text-muted-foreground border-border mt-8 border-t pt-4 text-xs leading-relaxed">
        {t('form.invitedHint')}
      </p>
    </div>
  )
}

function InviteOnly({ onSignOut }: { onSignOut: () => void }): JSX.Element {
  const t = useTranslations('onboarding')
  const tc = useTranslations('common')
  return (
    <div>
      <SetupHeading eyebrow={t('inviteOnly.eyebrow')} title={t('inviteOnly.title')}>
        {t('inviteOnly.description')}
      </SetupHeading>
      <p className="text-muted-foreground mt-4 text-sm leading-relaxed">{t('inviteOnly.wrongAccount')}</p>
      <Button type="button" variant="outline" className="mt-6" onClick={onSignOut}>
        <LogOut className="size-4" aria-hidden />
        {tc('actions.signOut')}
      </Button>
    </div>
  )
}

function SetupDone({ name }: { name: string }): JSX.Element {
  const t = useTranslations('onboarding')
  return (
    <div role="status" aria-live="polite">
      <EmptyStateDisc icon={Check} />
      <h1 className="mt-5 text-xl font-semibold tracking-tight">{t('success.title')}</h1>
      <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
        {t('success.description', { name })}
      </p>
      <p className="text-muted-foreground mt-6 flex items-center gap-2 text-sm">
        <Spinner size="sm" />
        {t('success.redirecting')}
      </p>
    </div>
  )
}
