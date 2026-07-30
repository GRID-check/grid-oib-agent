'use client'

/**
 * One inbox row — the generic, registry-driven renderer (spec IB-6).
 *
 * **There is deliberately no `switch (item.type)` in this file.** Every visual
 * decision comes from `INBOX_TYPE_PRESENTATION[item.type]`: which icon to draw,
 * which pair of translation keys to read, and whether the row reads as a request
 * or as an FYI. That is the whole extensibility promise — a new notification type
 * is a registry entry plus two strings, never a new component.
 *
 * The row answers **who / what / where / when without being opened** (IB-20):
 * the title carries the actor, the body the subject, the excerpt the actual
 * question, and the timestamp the when (relative, with the exact moment on hover).
 *
 * Two behaviours here are security-visible rather than cosmetic:
 *   - An **inert** item (its target was unshared, deleted or purged — IB-13/IB-14)
 *     renders as plain text, never as an anchor. `href` is null for those rows and
 *     an anchor with an empty or `#` href would be a working-looking link to
 *     content the user may no longer reach.
 *   - The **archive** control is a sibling of the row link, not a child of it.
 *     Nesting a button inside an anchor is an accessibility defect and makes the
 *     link's accessible name include the button's.
 */

import Link from 'next/link'
import {
  Archive,
  AtSign,
  CheckCircle2,
  EyeOff,
  MessageSquare,
  UserPlus,
  type LucideIcon,
} from 'lucide-react'

import { useI18n, useLocale, useTranslations } from '@/i18n'
import { getByPath } from '@/i18n/translate'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import { INBOX_TYPE_PRESENTATION, type InboxItemView } from '@/lib/inbox/types'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/**
 * The ONE place the registry's icon names become components. Keeping the map here
 * (rather than storing components in `lib/inbox/types.ts`) keeps the registry a
 * plain data module that the server half can import without pulling in React.
 */
const ICONS: Record<(typeof INBOX_TYPE_PRESENTATION)[keyof typeof INBOX_TYPE_PRESENTATION]['icon'], LucideIcon> =
  {
    'at-sign': AtSign,
    'message-square': MessageSquare,
    'user-plus': UserPlus,
    'check-circle': CheckCircle2,
  }

/** Dictionary root for the item-type entries. */
const TYPES_PATH = 'collaboration.inbox.types'

/**
 * Pick the counted title key by hand, because this i18n layer interpolates but
 * has no plural rules (see the dictionary header): counted types ship
 * `titleOne`/`titleMany`, uncounted ones a single `title`. Reading the dictionary
 * directly — rather than calling `t()` and sniffing the returned key — keeps a
 * type that legitimately has no `titleOne` from logging a missing-key warning on
 * every render.
 */
function pickKey(dictionary: unknown, i18nKey: string, candidates: readonly string[]): string | null {
  for (const leaf of candidates) {
    if (typeof getByPath(dictionary, `${TYPES_PATH}.${i18nKey}.${leaf}`) === 'string') return leaf
  }
  return null
}

export interface InboxItemRowProps {
  item: InboxItemView
  /** Called when the row's link is followed, so the list can mark it read. */
  onOpen?: (item: InboxItemView) => void
  /** Called by the archive button. Omit to hide the control. */
  onArchive?: (itemId: string) => void
}

export function InboxItemRow({ item, onOpen, onArchive }: InboxItemRowProps): JSX.Element {
  const t = useTranslations('collaboration')
  const { dictionary } = useI18n()
  const { locale } = useLocale()

  const presentation = INBOX_TYPE_PRESENTATION[item.type]
  const Icon = ICONS[presentation.icon]

  const inert = item.state === 'inert'
  const unread = item.state === 'unread'
  const resolved = item.state === 'resolved'
  // A request only reads as a request while it is still outstanding; once it is
  // answered it is history, and colouring it would keep shouting for attention.
  const isRequest = presentation.tone === 'request' && item.actionable && !resolved && !inert

  // A REDACTED row — inert, or its target no longer reachable — carries no href
  // and no payload, because the server withholds the conversation title exactly
  // as it withholds the quoted snippet (IB-13). Falling back to "Untitled
  // conversation" there would misstate WHY the row is nameless: the thread has a
  // title, this reader is simply no longer entitled to it.
  const redacted = !item.href

  const vars = {
    actor: item.actorName ?? t('inbox.unknownActor'),
    subject: item.subject ?? t(redacted ? 'inbox.inert' : 'inbox.untitledConversation'),
    count: item.count,
  }

  const titleLeaf =
    pickKey(dictionary, presentation.i18nKey, item.count > 1 ? ['titleMany', 'title'] : ['titleOne', 'title']) ??
    'title'
  const title = t(`inbox.types.${presentation.i18nKey}.${titleLeaf}`, vars)
  const bodyLeaf = pickKey(dictionary, presentation.i18nKey, ['body'])
  const body = bodyLeaf ? t(`inbox.types.${presentation.i18nKey}.${bodyLeaf}`, vars) : null

  return (
    <li
      data-testid="inbox-item"
      data-state={item.state}
      data-type={item.type}
      className={cn(
        'relative flex items-start gap-3 px-4 py-3.5 transition-colors duration-200 ease-out md:px-5',
        inert ? 'bg-muted/25' : 'hover:bg-accent/40',
      )}
    >
      {/* Type icon. A live request carries the "needs attention" tint; colour
          never travels alone here — the icon and the title text say the same. */}
      <span
        aria-hidden
        className={cn(
          'mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full border',
          isRequest
            ? 'border-transparent bg-warning-subtle text-warning'
            : 'border-border bg-card text-muted-foreground',
          inert && 'opacity-60',
        )}
      >
        <Icon className="size-4" />
      </span>

      <div className={cn('min-w-0 flex-1', inert && 'opacity-70')}>
        <div className="flex min-w-0 items-start gap-2">
          {/* Unread marker — the row is also heavier, so this is decoration. */}
          {unread && (
            <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-foreground" />
          )}
          {item.href && !inert ? (
            // Stretched link: the whole row is the target without nesting the
            // archive button inside the anchor (that button is lifted above the
            // overlay with `z-10`).
            <Link
              href={item.href}
              onClick={() => onOpen?.(item)}
              className={cn(
                'min-w-0 rounded-sm text-sm leading-snug outline-none',
                'after:absolute after:inset-0 after:content-[""]',
                'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
                unread ? 'font-semibold text-foreground' : 'text-foreground',
              )}
            >
              {title}
            </Link>
          ) : (
            <span
              className={cn(
                'min-w-0 text-sm leading-snug',
                unread ? 'font-semibold text-foreground' : 'text-foreground',
              )}
            >
              {title}
            </span>
          )}
        </div>

        {body && <p className="mt-0.5 truncate text-sm text-muted-foreground">{body}</p>}

        {item.excerpt && (
          <p className="mt-1.5 line-clamp-2 border-l border-border pl-2.5 text-sm leading-relaxed text-muted-foreground">
            {item.excerpt}
          </p>
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <time
            className="text-xs text-muted-foreground"
            dateTime={item.createdAt}
            title={formatAbsoluteTime(item.createdAt, locale)}
          >
            {formatRelativeTime(item.createdAt, locale)}
          </time>
          {resolved && item.actionable && (
            <Badge variant="success" className="gap-1">
              <CheckCircle2 aria-hidden />
              {t('inbox.resolved')}
            </Badge>
          )}
          {inert && (
            <>
              <Badge variant="secondary" className="gap-1">
                <EyeOff aria-hidden />
                {t('inbox.inert')}
              </Badge>
              <span className="text-xs text-muted-foreground">{t('inbox.inertHint')}</span>
            </>
          )}
        </div>
      </div>

      {onArchive && (
        <button
          type="button"
          // z-10 keeps this above the stretched link's overlay so it stays
          // clickable; it is a sibling of the anchor, never a child.
          className={cn(
            'relative z-10 mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg',
            'text-muted-foreground outline-none transition-colors duration-200 ease-out',
            'hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
          )}
          aria-label={t('inbox.archive')}
          onClick={() => onArchive(item.id)}
        >
          <Archive className="size-4" aria-hidden />
        </button>
      )}
    </li>
  )
}
