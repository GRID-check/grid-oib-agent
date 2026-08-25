/**
 * SourceBasisRow — one body of knowledge, listed.
 *
 * Replaces `DataConnectionCard`, which was a `role="button"` div wrapping a
 * `<Switch>` that needed `stopPropagation` and two eslint-disables to survive.
 * A screen reader met two controls for one fact and had to guess which one it
 * was on. Here the Switch is the only control, the row is a plain `Item`, and
 * the row's own text is the Switch's accessible name.
 *
 * Four states, four different pictures — because they are four different facts:
 *
 * - **on / off** — a Switch the reader can flip.
 * - **locked** — on, and not theirs to change: a `Chip` reading "Immer aktiv"
 *   where the Switch would be, plus the reason on its own line. Today this is
 *   only Baurecht & Richtlinien, and only because the wire cannot yet express
 *   a turn without it (see `source-basis-model`).
 * - **unavailable** — a `Chip variant="outline"` reading "Anmeldung nötig" plus
 *   the reason as visible `ItemDescription`. The old row drew this identically
 *   to "off" (`opacity-50` + unchecked Switch, reason hidden in a `title=`), and
 *   an unflippable switch is a lie about agency.
 */

'use client'

import { type FC } from 'react'

import { Chip } from '@/components/ui/chip'
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { iconForTint } from '../SourceSignalChip'
import type { SourceCategory, SourceCategoryId } from './source-basis-model'

export interface SourceBasisRowProps {
  entry: SourceCategory
  /** A turn is in flight — the basis is frozen for its duration. */
  isBusy?: boolean
  onToggle?: (id: SourceCategoryId, enabled: boolean) => void
}

export const SourceBasisRow: FC<SourceBasisRowProps> = ({ entry, isBusy = false, onToggle }) => {
  const t = useTranslations('research')
  const Icon = iconForTint(entry.signal)
  const isSwitchable = entry.state === 'on' || entry.state === 'off'

  return (
    <Item
      as="li"
      data-testid={`source-basis-row-${entry.id}`}
      data-state={entry.state}
      className={cn('gap-3 px-3 py-2.5', !isSwitchable && 'hover:bg-transparent')}
    >
      {/* Provenance rides on its own tint, exactly as the citation chips do. The
          old picker drew a `Globe` on `bg-muted` for every row while the chips
          800 lines away were fully colour-coded — two controls, one subject,
          opposite visual languages. */}
      <ItemMedia
        className="size-8 rounded-lg"
        style={{ backgroundColor: `var(--source-${entry.signal}-tint, var(--muted))` }}
      >
        <Icon
          className="size-4"
          style={{ color: `var(--source-${entry.signal}-text, var(--muted-foreground))` }}
          aria-hidden="true"
        />
      </ItemMedia>

      <ItemContent className="space-y-0.5">
        <ItemTitle>{entry.name}</ItemTitle>
        {/* The reason a row cannot be switched is information, so it is on the
            page — not in a `title=` attribute no touch user will ever see. */}
        <ItemDescription>
          {entry.state === 'unavailable'
            ? (entry.unavailableReason ?? t('sourceBasis.signInReason'))
            : entry.description}
        </ItemDescription>
        {entry.state === 'locked' && entry.lockedReason && (
          <ItemDescription className="text-muted-foreground/80">
            {entry.lockedReason}
          </ItemDescription>
        )}
      </ItemContent>

      <ItemActions>
        {entry.state === 'locked' ? (
          <Chip variant="muted" size="sm">
            {t('sourceBasis.alwaysOnChip')}
          </Chip>
        ) : entry.state === 'unavailable' ? (
          <Chip variant="outline" size="sm">
            {t('sourceBasis.signInRequired')}
          </Chip>
        ) : (
          <Switch
            checked={entry.state === 'on'}
            disabled={isBusy}
            onCheckedChange={(next) => onToggle?.(entry.id, next)}
            aria-label={t('sourceBasis.toggleAria', { name: entry.name })}
          />
        )}
      </ItemActions>
    </Item>
  )
}
