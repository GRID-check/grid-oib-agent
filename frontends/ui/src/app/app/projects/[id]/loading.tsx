import { Skeleton } from '@/components/ui/skeleton'

/**
 * Content-area loading state for all project sections (Overview, Files,
 * Research, Members, Intake, Chat). The sidebar layout persists across
 * navigations, so this only fills the swapped content pane — the user keeps
 * their navigation context while the server page resolves.
 */
export default function ProjectSectionLoading(): JSX.Element {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 md:px-8" aria-busy="true">
      <span className="sr-only" role="status">
        Loading…
      </span>
      <div className="space-y-2">
        <Skeleton className="h-7 w-56 max-w-full" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="mt-8 space-y-4">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
    </div>
  )
}
