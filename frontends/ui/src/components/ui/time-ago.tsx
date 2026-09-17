'use client'

import { useEffect, useState } from 'react'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'

/**
 * Time that is deterministic during SSR/hydration, relative only after mount.
 *
 * `formatRelativeTime` depends on `now`, so server and client render different
 * strings and React warns. Suppressing the warning hides the cause. This
 * component renders the absolute time on the server and on the first client
 * pass, then swaps to relative after mount — no mismatch, no suppression.
 */
export function TimeAgo({ date, locale, className }: { date: string; locale: string; className?: string }): JSX.Element {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return (
    <time dateTime={date} title={formatAbsoluteTime(date, locale)} className={className}>
      {mounted ? formatRelativeTime(date, locale) : formatAbsoluteTime(date, locale)}
    </time>
  )
}
