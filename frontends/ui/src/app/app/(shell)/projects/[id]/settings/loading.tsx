import type { JSX } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { getTranslations } from '@/i18n/server'

/**
 * Loading state for a Settings section. The layout (and its section nav) is
 * already on screen while a section loads, so this only stands in for the
 * section body: a stack of panels, the shape every section opens with.
 */
export default async function SettingsSectionLoading(): Promise<JSX.Element> {
  const t = await getTranslations('settings')
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <span className="sr-only" role="status">
        {t('loading')}
      </span>
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-28 rounded-xl" />
    </div>
  )
}
