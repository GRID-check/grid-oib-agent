'use client'

/**
 * Project card, styled after the click-dummy's Projektübersicht (spec §1/§3):
 * an outer subtle-surface card whose upper part is a raised "header card"
 * (rounded bottom, subtle divider shadow) carrying the project name, status
 * chip and summary line; below it a footer strip with the activity timestamp
 * and a shortcut to the project's Übersicht.
 *
 * THE card for "a project, listed" — the resume rail on projects-home and any
 * future project grid render this one, not a lookalike. Its SHAPE comes from
 * the shared `RaisedCard` primitive and its PARTS from `project-atoms.tsx`,
 * which is also what the dense list row is made of, so neither the geometry nor
 * the two arrangements can drift apart. See `docs/design/project-surfaces.md`
 * before adding a third.
 *
 * The whole card opens the project via a stretched, resume-aware link; the
 * Übersicht shortcut is a separate, independently focusable link layered above it
 * (no nested anchors).
 */

import type { JSX } from 'react'
import { RaisedCard, RaisedCardBody, RaisedCardFooter } from '@/components/ui/raised-card'
import type { Project } from '@/lib/db/schema'
import {
  ProjectActivity,
  ProjectOpenLink,
  ProjectMailWaiting,
  ProjectOverviewLink,
  ProjectSummaryLine,
} from './project-atoms'
import { ProjectStatusMark } from './project-status'

interface ProjectCardProps {
  project: Project
  /** Number of documents ingested into the project corpus. */
  docCount?: number
  /**
   * ISO timestamp of the VIEWER's own last activity in this project, when they
   * have any. Absent → the footer falls back to the project's own last movement
   * under the neutral label (see `ProjectActivity`).
   */
  activityAt?: string
  /**
   * Mails waiting in the project's E-Mail-Eingang for the viewer (ADR-0134);
   * absent or 0 shows nothing. Only a reader who may file the mail gets one.
   */
  mailWaiting?: number
}

export function ProjectCard({ project, docCount = 0, activityAt, mailWaiting = 0 }: ProjectCardProps): JSX.Element {
  // docCount is accepted for API stability but the card face mirrors the
  // click-dummy (name · summary · last activity) and does not surface it. The
  // dense list row does, where there is a column for it.
  void docCount

  return (
    // `RaisedCard` is the shared two-surface shape (tray + laid-in sheet +
    // footer tab). This card used to carry its own copy of that geometry — one
    // of the four the primitive's docstring lists; this is that migration.
    <RaisedCard interactive>
      <RaisedCardBody>
        <div className="flex items-center justify-between gap-2.5">
          {/* `text-sm font-semibold` is the ramp's card/subsection title — and
              it is what makes the rail outrank the list typographically rather
              than only by shape, since the row's name is `font-medium`. */}
          <h3 className="min-w-0 text-sm font-semibold">
            <ProjectOpenLink project={project} />
          </h3>
          {/* Quiet while active, like the row: the rail holds active projects, so
              a chip here is the exception (ADR-0098). */}
          <ProjectStatusMark project={project} size="md" />
        </div>

        <ProjectSummaryLine project={project} className="mt-0.5" />
      </RaisedCardBody>

      {/* Footer tab on the tray: activity · time · Übersicht. */}
      <RaisedCardFooter>
        <ProjectActivity project={project} activityAt={activityAt} compact />
        <ProjectMailWaiting project={project} count={mailWaiting} className="ml-auto" />
        <ProjectOverviewLink project={project} showLabel className={mailWaiting > 0 ? '-mr-2' : '-mr-2 ml-auto'} />
      </RaisedCardFooter>
    </RaisedCard>
  )
}
