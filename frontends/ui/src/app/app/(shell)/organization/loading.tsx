import { Skeleton } from '@/components/ui/skeleton'
import { getTranslations } from '@/i18n/server'

/**
 * Content-column fallback for the organization segment. The layout already
 * owns the topbar, back link and section nav — this only mirrors the page
 * header + stacked-card geometry so the column does not jump when the
 * server page arrives.
 *
 * Both cards mirror `Card` (`rounded-lg border`, header/content `px-6`,
 * `py-6` rhythm): the overview card's `sm:grid-cols-2` fact grid, and the
 * settings card's field rows (`h-10 rounded-lg` controls, the `Input` /
 * `Select` box) with the save action. All heights are fixed — nothing sizes
 * to content, which is what keeps the fallback from collapsing and jumping.
 */
export default async function OrganizationLoading(): Promise<JSX.Element> {
  const t = await getTranslations('organization')
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <span className="sr-only" role="status">
        {t('loading')}
      </span>
      {/* `PageHeader`: `text-xl` title + one-line `text-sm` subtitle. */}
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-5 w-80 max-w-full" />
      </div>
      <div className="flex flex-col gap-6">
        {/* Overview card: header (title + description) over the 2-column fact
            grid — label eyebrow plus value line per fact. */}
        <div className="flex flex-col gap-6 rounded-lg border border-border bg-card py-6">
          <div className="space-y-1.5 px-6">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </div>
          <div className="grid grid-cols-1 gap-4 px-6 sm:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i}>
                <Skeleton className="h-3 w-24" />
                <Skeleton className="mt-1 h-5 w-40 max-w-full" />
              </div>
            ))}
          </div>
        </div>
        {/* Settings card: header over field rows (label + `h-10` control, the
            display-name input / locale select box) and the save action. */}
        <div className="flex flex-col gap-6 rounded-lg border border-border bg-card py-6">
          <div className="space-y-1.5 px-6">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </div>
          <div className="space-y-4 px-6">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i}>
                <Skeleton className="h-4 w-32" />
                <Skeleton className="mt-1.5 h-10 w-full rounded-lg" />
              </div>
            ))}
            <Skeleton className="h-9 w-28 rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  )
}
