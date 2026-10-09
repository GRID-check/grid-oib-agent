'use client'

/**
 * The words for an Answer-quality scope, shared by every view that says which
 * scope it is showing: the date range in the reader's locale, then how far
 * organizations and projects narrow it ("1.–30. Sept. 2026 · 2 Organisationen").
 * One composition, so the citation and runtime views cannot describe the same
 * scope two ways.
 */

import { useCallback } from 'react'
import { useLocale, useTranslations } from '@/i18n'
import { formatDayRange } from '@/lib/format'
import type { QualityScope } from '@/lib/quality/scope'

export function useQualityScopeLabel(): (scope: QualityScope) => string {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  return useCallback(
    (scope: QualityScope) =>
      [
        formatDayRange(scope.from, scope.to, locale),
        scope.organizationIds.length > 0
          ? t('citations.scopeLabel.organizations', { count: scope.organizationIds.length })
          : null,
        scope.projectIds.length > 0
          ? t('citations.scopeLabel.projects', { count: scope.projectIds.length })
          : null,
      ]
        .filter(Boolean)
        .join(' · '),
    [locale, t]
  )
}
