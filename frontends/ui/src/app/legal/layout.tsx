/**
 * Legal pages layout — public, unauthenticated shell for `/legal/[slug]`.
 *
 * A quiet reading column under the brand mark with a way back home; the
 * pages themselves are prose documents (Impressum, privacy policy, terms,
 * AI transparency, subprocessors) rendered from `@/lib/legal`.
 */

import { type ReactNode } from 'react'
import Link from 'next/link'
import { Logo } from '@/components/brand/logo'
import { getTranslations } from '@/i18n/server'

interface LegalLayoutProps {
  children: ReactNode
}

const LegalLayout = async ({ children }: LegalLayoutProps): Promise<ReactNode> => {
  const t = await getTranslations('legal')
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" aria-label={t('nav.home')}>
            <Logo kind="horizontal" size="small" />
          </Link>
          <Link
            href="/"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('nav.backHome')}
          </Link>
        </div>
      </header>
      <main id="main-content" className="flex-1">
        <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-12">{children}</div>
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto w-full max-w-3xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-xs leading-relaxed text-muted-foreground sm:px-6">
          {t('nav.footerNote')}
        </div>
      </footer>
    </div>
  )
}

export default LegalLayout
