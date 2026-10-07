/**
 * A source from another project (ADR-0093) keeps naming that project from the
 * wire to the stored message, the document model, the chip and the notice: the
 * reader sees where a passage came from, and the preview opens it in that
 * project rather than in the chat's own.
 */

import { describe, expect, it } from 'vitest'
import { encodeBackendSources } from '@/lib/conversations/agent-answer-metadata'
import { citationLabel, documentProjectId } from '../components/SourcePreview'
import { buildCitationModel } from './citations/build'
import { decodeCitations, encodeCitations } from './citations/persistence'
import { otherProjectsOf } from './other-projects'
import { citationFromWire, projectFromWire } from './wire-citation'
import type { ChatMessage, CitationSource, WireCitationSource } from '../types'

const GRAZ = { id: '22222222-0000-4000-8000-000000000002', name: 'Wohnbau Graz', status: 'closed' as const }
const at = new Date('2026-10-06T14:30:00')

const wire: WireCitationSource = {
  content: '[KB] Detail Traufe.pdf (Wohnbau Graz), p.3',
  citation_key: 'Detail Traufe.pdf (Wohnbau Graz), p.3',
  file_name: 'Detail Traufe.pdf',
  page: 3,
  collection: 'proj_22222222',
  shelf: 'project',
  kind: 'projekt',
  number: 1,
  project: GRAZ,
}

describe('a source from another project', () => {
  it('reads its project off the wire, and drops one that names no id', () => {
    expect(citationFromWire(wire).project).toEqual(GRAZ)
    expect(projectFromWire({ name: 'ohne id' })).toBeUndefined()
    expect(projectFromWire({ id: 'p', name: 'X', status: 'whatever' })).toEqual({ id: 'p', name: 'X', status: 'active' })
  })

  it('keeps it through the stored message, from the browser and from the agent', () => {
    const citation = citationFromWire(wire, { id: 'c1', timestamp: at })
    expect(decodeCitations(encodeCitations([citation]), at)?.[0].project).toEqual(GRAZ)
    expect(decodeCitations(encodeBackendSources([wire]), at)?.[0].project).toEqual(GRAZ)
  })

  it('names the project on the chip and resolves the document in that project', () => {
    const [document] = buildCitationModel({ citations: [citationFromWire(wire, { isCited: true })] })

    expect(document.project).toEqual(GRAZ)
    expect(citationLabel(document)).toBe(`${document.title} · Wohnbau Graz`)
    expect(documentProjectId(document, 'project-of-this-chat')).toBe(GRAZ.id)
  })

  it('leaves a source of the chat’s own project as it was', () => {
    const own = { ...wire, project: undefined, citation_key: 'Plan.pdf, p.1', file_name: 'Plan.pdf' }
    const [document] = buildCitationModel({ citations: [citationFromWire(own, { isCited: true })] })

    expect(citationLabel(document)).toBe(document.title)
    expect(documentProjectId(document, 'project-of-this-chat')).toBe('project-of-this-chat')
  })
})

describe('otherProjectsOf', () => {
  it('lists each other project the messages’ sources name once, in order of first appearance', () => {
    const LINZ = { id: 'linz', name: 'Schule Linz', status: 'active' as const }
    const cite = (project?: typeof GRAZ | typeof LINZ): CitationSource => ({
      ...citationFromWire({ ...wire, project }),
      timestamp: at,
    })
    const messages = [
      { citations: [cite(GRAZ), cite()] },
      { citations: [cite(LINZ), cite(GRAZ)] },
      {},
    ] as unknown as ChatMessage[]

    expect(otherProjectsOf(messages).map((project) => project.name)).toEqual(['Wohnbau Graz', 'Schule Linz'])
    expect(otherProjectsOf([])).toEqual([])
  })
})
