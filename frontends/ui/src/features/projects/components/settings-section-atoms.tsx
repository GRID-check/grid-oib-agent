'use client'

/**
 * The pieces a project Settings section is drawn from, so a section organism
 * composes them instead of re-spelling the heading, the description and the
 * card body in Tailwind.
 *
 * The type steps are the ones the neighbouring sections already use by hand
 * (`project-reindex-card.tsx`, the members block in `project-settings.tsx`):
 * `text-sm font-semibold` for the heading, muted `text-sm leading-relaxed`
 * capped at `max-w-2xl` for the description. Moving those sections onto these
 * atoms is the next change to either of them, not this one.
 */

import type { JSX, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { RaisedCard, RaisedCardBody } from '@/components/ui/raised-card'

/** A settings section on the raised card, named for assistive tech by `label`. */
export function SettingsSectionCard({
  label,
  children,
}: {
  label: string
  children: ReactNode
}): JSX.Element {
  return (
    <RaisedCard role="region" aria-label={label}>
      <RaisedCardBody className="space-y-5 p-6">{children}</RaisedCardBody>
    </RaisedCard>
  )
}

/** Heading and one-paragraph explanation, with an optional action on the right. */
export function SettingsSectionHeader({
  title,
  description,
  action,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h2 className="text-foreground text-sm font-semibold">{title}</h2>
        {description && (
          <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

/** A short list of conditions that apply to the section, one line each. */
export function SettingsRuleList({
  label,
  children,
}: {
  label: string
  children: ReactNode
}): JSX.Element {
  return (
    <ul aria-label={label} className="grid gap-2.5 sm:grid-cols-2">
      {children}
    </ul>
  )
}

export function SettingsRule({
  icon: Icon,
  children,
}: {
  icon: LucideIcon
  children: ReactNode
}): JSX.Element {
  return (
    <li className="text-muted-foreground flex items-start gap-2.5 text-sm leading-relaxed">
      <Icon className="text-foreground/70 mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </li>
  )
}
