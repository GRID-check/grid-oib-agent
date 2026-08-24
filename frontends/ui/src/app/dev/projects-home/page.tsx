'use client'

/**
 * Projects-home dev preview: the REAL `ProjectsGrid` at the size the redesign
 * exists for — nine projects, three of which this viewer has actually worked in.
 *
 * The rail carries those three (largest cards, "Pick up where you left off"),
 * everything else is a dense row list ordered by recency. `?variant=fresh`
 * renders the other branch: a viewer with no activity anywhere, where the rail
 * is filled by project recency and says so ("Your projects") rather than
 * claiming a "continue" that never happened.
 *
 * Fixture data only, no backend. The `/dev` layout 404s this outside development.
 */

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { ProjectsGrid } from '@/components/projects/projects-grid'
import type { Project } from '@/lib/db/schema'

// Relative to the moment the preview renders, not to a pinned date: the whole
// point of the surface is the *shape* of the recency ordering ("12 minutes ago"
// above "3 hours ago" above "last month"), and a fixed epoch turns all of it
// into "2 years ago" a year from now.
const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000)

function makeProject(id: string, name: string, summary: string | null, createdMinutesAgo: number): Project {
  return {
    id,
    organizationId: 'org_1',
    name,
    createdBy: 'user_me',
    collectionName: `proj_${id}`,
    workosResourceId: null,
    profile: { facts: {}, goals: {}, unknowns: [], assumptions: {} },
    profileVersion: 1,
    profilePromptView: null,
    profileDisplay: summary ? { title: name, summary, keyFacts: [], missingInfo: [] } : null,
    profileUpdatedAt: summary ? minutesAgo(createdMinutesAgo) : null,
    deletedAt: null,
    createdAt: minutesAgo(createdMinutesAgo),
  }
}

const PROJECTS: Project[] = [
  makeProject('p1', 'Wohnbau Seestadt Baufeld D12', 'Wohnbau · 214 Wohneinheiten · GK 5 · Wien', 40),
  makeProject('p2', 'Sanierung Volksschule Grinzing', 'Bildungsbau · Bestandssanierung · Wien', 60 * 26),
  makeProject('p3', 'Bürohaus Lände 3', 'Büro- und Geschäftsgebäude · GK 5 · Wien', 60 * 50),
  makeProject('p4', 'Hotel Semmering — Neubau Gästetrakt', 'Beherbergung · GK 4 · Niederösterreich', 60 * 72),
  makeProject('p5', 'Kindergarten Floridsdorf', 'Bildungsbau · GK 2 · Wien', 60 * 96),
  makeProject('p6', 'Turnsaal-Zubau BG Wien 19', null, 60 * 24 * 7),
  makeProject('p7', 'Wohnhausanlage Linz-Urfahr', 'Wohnbau · 96 Wohneinheiten · GK 5 · Oberösterreich', 60 * 24 * 14),
  makeProject('p8', 'Betriebsgebäude Graz-Süd', 'Gewerbe- und Lagergebäude · GK 4 · Steiermark', 60 * 24 * 21),
  makeProject('p9', 'Pfarrzentrum Klosterneuburg', 'Versammlungsstätte · GK 3 · Niederösterreich', 60 * 24 * 40),
]

const DOC_COUNTS: Record<string, number> = {
  p1: 62,
  p2: 29,
  p3: 18,
  p4: 24,
  p5: 11,
  p6: 3,
  p7: 47,
  p8: 18,
  p9: 1,
}

/** The viewer's own last message per project — what orders the rail. */
const VIEWER_ACTIVITY: Record<string, string> = {
  p1: minutesAgo(12).toISOString(),
  p2: minutesAgo(60 * 3).toISOString(),
  p3: minutesAgo(60 * 27).toISOString(),
}

function ProjectsHomePreview(): JSX.Element {
  const fresh = useSearchParams()?.get('variant') === 'fresh'
  return (
    <main
      data-testid="projects-home-preview"
      className="min-h-dvh bg-background px-6 py-10 text-foreground md:px-10"
    >
      <div className="mx-auto w-full max-w-[1080px]">
        <ProjectsGrid
          projects={PROJECTS}
          docCounts={DOC_COUNTS}
          viewerActivity={fresh ? {} : VIEWER_ACTIVITY}
        />
      </div>
    </main>
  )
}

export default function ProjectsHomeDevPage(): JSX.Element {
  return (
    <Suspense>
      <ProjectsHomePreview />
    </Suspense>
  )
}
