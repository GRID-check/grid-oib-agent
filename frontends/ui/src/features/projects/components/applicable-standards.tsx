// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link'
import { ClipboardCheck, ExternalLink, MessageSquareText } from 'lucide-react'
import type { ApplicableStandard, ApplicableStatus } from '@/lib/oib/applicable-standards'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'

interface ApplicableStandardsProps {
  projectId: string
  standards: ApplicableStandard[]
  /** Whether the project brief has enough facts to tailor applicability. */
  briefComplete: boolean
}

type BadgeVariant = 'info' | 'secondary' | 'warning'

/** Map an applicability verdict to the design-language badge token. */
function statusVariant(status: ApplicableStatus): BadgeVariant {
  switch (status) {
    case 'required':
      return 'info'
    case 'check':
      return 'warning'
    case 'likely':
    default:
      return 'secondary'
  }
}

function statusLabel(status: ApplicableStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

/** Build the deep link that prefills the chat composer with a question about a Richtlinie. */
function askGridHref(projectId: string, standard: ApplicableStandard): string {
  const question = `Which requirements of ${standard.code} (${standard.titleEn}) apply to this project?`
  return `/projects/${projectId}/chat?ask=${encodeURIComponent(question)}`
}

/**
 * Compliance-orientation panel: which OIB-Richtlinien are relevant to this
 * project, derived from the brief, each with a project-grounded reason, a link to
 * the source, and an "Ask Grid" action. Server-renderable (no client hooks).
 */
export function ApplicableStandards({ projectId, standards, briefComplete }: ApplicableStandardsProps) {
  return (
    <section className="space-y-3 animate-in fade-in-0">
      <div>
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Applicable standards
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          OIB-Richtlinien relevant to this project, based on the brief.
        </p>
        {!briefComplete && (
          <p className="mt-1 text-xs text-muted-foreground">
            Complete the project brief for applicability tailored to this building.
          </p>
        )}
      </div>

      {standards.length > 0 ? (
        <div className="divide-y rounded-lg border bg-card">
          {standards.map((standard) => (
            <div
              key={standard.code}
              className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
            >
              {/* Left: code + title + reason */}
              <div className="flex min-w-0 gap-3">
                <Badge variant="outline" className="mt-0.5 shrink-0 font-mono">
                  {standard.code}
                </Badge>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{standard.titleEn}</p>
                  <p className="text-xs text-muted-foreground">{standard.titleDe}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{standard.reason}</p>
                </div>
              </div>

              {/* Right: status + quiet actions */}
              <div className="flex shrink-0 items-center gap-3 sm:pt-0.5">
                <Badge variant={statusVariant(standard.status)}>{statusLabel(standard.status)}</Badge>
                <a
                  href={standard.oibUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={`Open the source for ${standard.code}`}
                  title="Open the OIB source"
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                  Source
                </a>
                <Link
                  href={askGridHref(projectId, standard)}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={`Ask Grid about ${standard.code}`}
                  title="Ask Grid about this Richtlinie"
                >
                  <MessageSquareText className="size-3.5" aria-hidden />
                  Ask Grid
                </Link>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={ClipboardCheck}
          title="No applicable standards yet"
          description="Complete the project brief so Grid can work out which OIB-Richtlinien apply to this building."
        />
      )}

      <p className="text-xs text-muted-foreground">
        Orientation only — not legal advice. Confirm applicability against the current Bauordnung and
        the authority having jurisdiction.
      </p>
    </section>
  )
}
