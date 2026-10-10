/**
 * Dev preview: the „Ähnliche Projekte" section (`/app/projects/{id}/settings/references`)
 * rendered through the real organism with fixture data, no backend
 * (`_fixtures/similar-projects.ts`):
 *
 *   1. THE SECTION — „Verglichen nach" with a suggested class and two open
 *      facts, two alike references (one with unconfirmed values, decisions of
 *      all three origins and a permit; one running and empty), and an unrelated
 *      closed project listed apart, then „… und 3 weitere".
 *   2. THE EMPTY STATE — an office with no closed project yet.
 *
 * Not linked anywhere; the `/dev` server layout 404s it outside development.
 */

import type { JSX } from 'react'
import { SimilarProjects } from '@/features/references/components/similar-projects'
import { EMPTY_SIMILAR_PAGE, SIMILAR_PAGE } from '../_fixtures/similar-projects'

export default function SimilarProjectsPreview(): JSX.Element {
  return (
    <div className="flex flex-col gap-10">
      <SimilarProjects projectId="preview" page={SIMILAR_PAGE} />
      <SimilarProjects projectId="preview" page={EMPTY_SIMILAR_PAGE} />
    </div>
  )
}
