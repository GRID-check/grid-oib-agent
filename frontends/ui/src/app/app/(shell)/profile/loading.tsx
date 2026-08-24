import { Skeleton } from '@/components/ui/skeleton'
import { ShellContent } from '@/components/shell'
import { getTranslations } from '@/i18n/server'

/**
 * Route-level loading state for the profile page. The page is a server
 * component reading the WorkOS session, so without this the navigation from the
 * user menu gives no feedback.
 *
 * It no longer draws a topbar. The one it used to draw was `h-14` where the
 * real one was `h-16`, so every arrival on this page moved the entire column up
 * by 8px — a live jump, shipped by a fallback whose whole purpose was to
 * prevent one. There is nothing left to get wrong: the chrome is persistent and
 * already on screen, and the column below comes from the same `ShellContent`
 * the page itself uses.
 */
export default async function ProfileLoading(): Promise<JSX.Element> {
  const t = await getTranslations('profile')
  return (
    <ShellContent aria-busy="true">
      <span className="sr-only" role="status">
        {t('loading')}
      </span>

      <Skeleton className="mb-6 h-6 w-28 rounded-full" />

      <div className="mb-8 space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>

      <div className="flex flex-col gap-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-44 w-full" />
        ))}
      </div>
    </ShellContent>
  )
}
