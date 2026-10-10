/**
 * Dev preview: the „Ähnliche Projekte" section (`/app/projects/{id}/settings/references`)
 * rendered through the real organism with fixture data, no backend:
 *
 *   1. TWO REFERENCES — a Holzbau project in Niederösterreich whose OIB edition
 *      was only suggested from its documents (unconfirmed), with decisions of
 *      all three origins and a permit with its Auflagen; and a project with a
 *      confirmed edition and nothing recorded yet.
 *   2. THE EMPTY STATE — what a person sees when no closed project is like this one.
 *
 * Not linked anywhere; the `/dev` server layout 404s it outside development.
 */

import type { JSX } from 'react'
import { SimilarProjects } from '@/features/references/components/similar-projects'
import { SIMILAR_PROJECTS as FIXTURES } from '../_fixtures/similar-projects'

export default function SimilarProjectsPreview(): JSX.Element {
  return (
    <div className="flex flex-col gap-10">
      <SimilarProjects projects={FIXTURES} />
      <SimilarProjects projects={[]} />
    </div>
  )
}
