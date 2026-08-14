/**
 * Render a component or hook with the app reading in one specific language.
 *
 * Without a provider `useI18nContext` degrades to the default locale, which is
 * what most specs rely on — so asserting the OTHER locale's copy needs the real
 * provider around the tree, not a stubbed translator: a stub asserts that the
 * hook called `t`, this asserts the sentence the user reads.
 *
 * `fixedLocale` skips the provider's first-mount reconciliation against the
 * user's saved preference and their organization's default, which a unit test
 * has no server to answer — the same reason the `/dev/*` preview routes pin it.
 */

import type { ReactNode } from 'react'
import { I18nProvider, type Locale } from '@/i18n'

export function localeWrapper(locale: Locale): ({ children }: { children: ReactNode }) => ReactNode {
  const LocaleWrapper = ({ children }: { children: ReactNode }): ReactNode => (
    <I18nProvider initialLocale={locale} fixedLocale>
      {children}
    </I18nProvider>
  )
  LocaleWrapper.displayName = `LocaleWrapper(${locale})`
  return LocaleWrapper
}
