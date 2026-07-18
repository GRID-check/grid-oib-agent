/**
 * LandingFooter — a minimal, quiet footer: brand mark, a one-line description,
 * the domain sources Piloti is grounded in, and the legal pages every public
 * surface must link to (Impressum, privacy, terms, AI transparency).
 */

import { type FC } from 'react'
import Link from 'next/link'
import { Logo } from '@/components/brand/logo'
import { useLocale, useTranslations } from '@/i18n'
import { legalNavEntries } from '@/lib/legal'

export const LandingFooter: FC = () => {
  const t = useTranslations('landing')
  const { locale } = useLocale()
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-12 md:flex-row md:items-center md:justify-between md:px-8">
        <div className="flex flex-col gap-2">
          <Logo kind="horizontal" size="small" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('footer.description')}
          </p>
        </div>
        <div className="flex flex-col gap-3 md:items-end">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('footer.sources')}
          </p>
          <nav aria-label={t('footer.legalNav')}>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs leading-relaxed">
              {legalNavEntries(locale).map((entry) => (
                <li key={entry.slug}>
                  <Link
                    href={`/legal/${entry.slug}`}
                    className="text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                  >
                    {entry.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>
    </footer>
  )
}
