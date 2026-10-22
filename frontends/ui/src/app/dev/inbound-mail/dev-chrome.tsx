'use client'

/**
 * The previews' own chrome: a fixed strip at the bottom centre that switches
 * the fixture (`?variant=`), the locale (`?locale=en`) and hides itself for a
 * capture (`?chrome=0`). Plain and obviously not part of the design under
 * test; it never ships (the `/dev` layout 404s outside development).
 */

import type { JSX } from 'react'
import Link from 'next/link'

export function DevVariantStrip({ base, variants, current, locale }: { base: string; variants: readonly string[]; current: string; locale: string }): JSX.Element {
  const href = (variant: string, nextLocale = locale) => `${base}?variant=${variant}${nextLocale === 'en' ? '&locale=en' : ''}`
  return (
    <nav
      aria-label="Fixture"
      className="fixed inset-x-0 bottom-2 z-50 mx-auto flex w-fit max-w-[calc(100vw-1rem)] flex-wrap justify-center gap-1 rounded-md border bg-neutral-100 p-1 font-mono text-[11px] text-neutral-700 shadow-sm dark:bg-neutral-800 dark:text-neutral-200"
    >
      {variants.map((variant) => (
        <Link
          key={variant}
          href={href(variant)}
          className={variant === current ? 'rounded bg-white px-1.5 py-0.5 dark:bg-neutral-600' : 'px-1.5 py-0.5'}
        >
          {variant}
        </Link>
      ))}
      <Link href={href(current, locale === 'en' ? 'de' : 'en')} className="px-1.5 py-0.5 underline">
        {locale === 'en' ? 'de' : 'en'}
      </Link>
    </nav>
  )
}
