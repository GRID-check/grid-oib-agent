import type { JSX, ReactNode } from 'react'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

/**
 * One block of a project settings section: a titled card, the material the
 * organization tier's sections are built from, so the two settings tiers read
 * as one product.
 *
 * The title is a level-2 heading because the section frame already owns the
 * page's `h1` ("Settings").
 */
export function SettingsPanel({
  title,
  description,
  action,
  children,
  'data-testid': testId,
}: {
  title: ReactNode
  description?: ReactNode
  /** A control that acts on the whole block, top right from `sm` up. */
  action?: ReactNode
  children?: ReactNode
  'data-testid'?: string
}): JSX.Element {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {title}
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      {children ? <CardContent>{children}</CardContent> : null}
    </Card>
  )
}

/**
 * The opening line of a section whose content brings its own cards (the
 * project brief, the memory list), where wrapping it in a {@link SettingsPanel}
 * would put a card inside a card.
 */
export function SettingsSectionIntro({
  title,
  description,
}: {
  title: ReactNode
  description?: ReactNode
}): JSX.Element {
  return (
    <div className="space-y-1">
      <h2 className="text-foreground text-sm font-semibold">{title}</h2>
      {description ? (
        <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">{description}</p>
      ) : null}
    </div>
  )
}
