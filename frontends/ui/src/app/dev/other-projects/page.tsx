'use client'

/**
 * Dev preview: how a chat shows that it drew on other projects (ADR-0094).
 * Rendered through the real components with fixture data, no backend:
 *
 *   1. THE SOURCES — an answer citing a project upload of this chat, a passage
 *      from a closed project's detail folder and one from a running project:
 *      each chip from another project names it.
 *   2. THE NOTICE — what the composer says while other projects narrow the chat,
 *      as the server judges it now (`restrictingOtherProjects`): a running
 *      project, a closed project whose restricted folder the chat drew on, and
 *      a project that is gone. A project closed since the answer is not listed.
 *
 * Not linked anywhere; the `/dev` server layout 404s it outside development.
 */

import type { FC, ReactNode } from 'react'
import { AnswerCitations } from '@/features/chat/components/AnswerCitations'
import { AnswerSourcesRow } from '@/features/chat/components/AnswerSourcesRow'
import type { RestrictingOtherProject } from '@/adapters/api/conversations-client'
import { OtherProjectsNotice } from '@/features/chat/components/OtherProjectsNotice'
import { buildCitationModel } from '@/features/chat/lib/citations'
import type { CitationProject, CitationSource } from '@/features/chat/types'

const at = new Date('2026-10-06T14:30:00')

const GRAZ: CitationProject = { id: '22222222-0000-4000-8000-000000000002', name: 'Wohnbau Graz', status: 'closed' }
const LINZ: CitationProject = { id: '33333333-0000-4000-8000-000000000003', name: 'Schule Linz', status: 'active' }

/** What the server says restricts the chat now: Graz only through a restricted folder, and a project since deleted. */
const RESTRICTING: RestrictingOtherProject[] = [
  { id: GRAZ.id, name: GRAZ.name },
  { id: LINZ.id, name: LINZ.name },
  { id: '44444444-0000-4000-8000-000000000004', name: null },
]

const source = (
  number: number,
  fileName: string,
  page: number,
  title: string,
  project?: CitationProject
): CitationSource => ({
  id: `${number}`,
  content: `[KB] ${fileName}${project ? ` (${project.name})` : ''}, p.${page}`,
  citationKey: `${fileName}${project ? ` (${project.name})` : ''}, p.${page}`,
  fileName,
  collection: project ? `proj_${project.id.slice(0, 8)}` : 'proj_this',
  title,
  origin: 'kb',
  kind: 'projekt',
  shelf: 'project',
  sourceType: 'knowledge_layer',
  page,
  number,
  isCited: true,
  timestamp: at,
  snippet: 'Die Traufe ist hinterlüftet ausgeführt, Konterlattung 5/8 …',
  ...(project ? { project } : {}),
})

const CITATIONS: CitationSource[] = [
  source(1, 'Ausführungsplan Dach.pdf', 4, 'Ausführungsplan Dach'),
  source(2, 'Detail Traufe.pdf', 3, 'Detail Traufe', GRAZ),
  source(3, 'Detail Attika.pdf', 2, 'Detail Attika', LINZ),
]

const Block: FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <section className="flex flex-col gap-2">
    <h2 className="text-sm font-semibold">{title}</h2>
    {children}
  </section>
)

export default function OtherProjectsDevPage() {
  const documents = buildCitationModel({ citations: CITATIONS })
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-4 sm:p-8" data-testid="other-projects-preview">
      <div>
        <h1 className="text-lg font-semibold">A chat that drew on other projects</h1>
        <p className="text-muted-foreground mt-1 text-sm">ADR-0094: sources name their project; the composer names the projects that narrow the chat now, as the server judges it.</p>
      </div>
      <Block title="1. The sources">
        <AnswerCitations documents={documents} anchorPrefix="dev-other-projects">
          <AnswerSourcesRow documents={documents} anchorPrefix="dev-other-projects" routingDecision="shallow" />
        </AnswerCitations>
      </Block>
      <Block title="2. The notice">
        <div className="bg-card rounded-xl border p-3">
          <p className="px-1.5 py-1 text-sm">Wie haben wir die Traufe beim Holzbau in Graz gelöst?</p>
          <OtherProjectsNotice projects={RESTRICTING} />
        </div>
      </Block>
    </main>
  )
}
