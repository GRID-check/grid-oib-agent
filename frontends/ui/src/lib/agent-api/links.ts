import 'server-only'
/**
 * Links into the app on what the door answers: a project, a document, a task
 * run, a conversation or a held mail carries `url`, the page a person opens to see it, so an
 * outside agent can hand the person a link to what it found (PostHog's MCP puts
 * `_posthogUrl` on its rows for the same reason).
 *
 * An operation opts in with `links` in its catalog entry, naming the kind of
 * object its answer holds; this module is the one table from that kind to the
 * page. Document and conversation pages are the sharing registry's own deep
 * links, the ones the inbox and the share dialog already open, so a moved page
 * moves here too. The objects linked are the answer itself when it is one
 * (`project-get`, a run's view), or else the rows one level in: a bare list,
 * each array of the page (`{ documents, nextCursor }`) and each wrapped object
 * (`{ document }`, `{ run }`). Nothing deeper, so an object of another kind
 * nested in a row is never given this kind's link.
 *
 * Only on the door, and only absolute: the UI navigates with its own relative
 * paths and never reads `url` from these routes. Without a pinned origin
 * (`configuredAppOrigin`, never the request's Host) there is no link at all,
 * rather than a relative path an agent cannot open.
 */

import { describeResource } from '@/lib/sharing/registry'
import type { OperationInput } from './dispatch'
import type { AgentOperation, LinkKind } from './operation'

type Row = Record<string, unknown>

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** The project the call names: the path's `[id]` under `/api/projects/[id]`, else its `projectId`. */
function callProjectId(op: AgentOperation, input: OperationInput): string | null {
  if (op.path.startsWith('/api/projects/[id]')) return text(input.params?.id)
  const query = isRow(input.query) ? input.query : {}
  const body = isRow(input.body) ? input.body : {}
  return text(query.projectId) ?? text(body.projectId)
}

/** The row's own project when it states one (null included: the office shelf), else the call's. */
function projectOf(row: Row, callProject: string | null): string | null {
  return 'projectId' in row ? text(row.projectId) : callProject
}

const enc = encodeURIComponent

interface Page {
  /** The id that makes an object this kind: present means it is one. */
  readonly idOf: (row: Row) => string | null
  /** The app path of the object, or null when the answer lacks what the page needs. */
  readonly path: (id: string, row: Row, callProject: string | null) => string | null
}

const PAGES: Readonly<Record<LinkKind, Page>> = {
  project: {
    idOf: (row) => text(row.id),
    path: (id) => `/app/projects/${enc(id)}`,
  },
  document: {
    idOf: (row) => text(row.id),
    // Without a project the document is the office shelf's, and the registry opens the shelf.
    path: (id, row, callProject) => describeResource('document').deepLink(id, { projectId: projectOf(row, callProject) }),
  },
  'task-run': {
    // A run's own view says `runId`, a run row in a list `id`.
    idOf: (row) => text(row.runId) ?? text(row.id),
    path: (id, row, callProject) => {
      const project = projectOf(row, callProject)
      if (!project) return null
      // The run block in its thread (`?run=` rides along, as `taskThreadHref` writes it);
      // a run that never had a thread waits on the project's task list.
      const conversation = text(row.conversationId)
      if (conversation) return `/app/projects/${enc(project)}/chat?session=${enc(conversation)}&run=${enc(id)}`
      const task = text(row.taskId)
      return `/app/projects/${enc(project)}/automation?tab=tasks${task ? `&task=${enc(task)}` : ''}`
    },
  },
  conversation: {
    // An ask names its conversation `conversationId`; a conversation is its own `id`.
    idOf: (row) => text(row.conversationId) ?? text(row.id),
    path: (id, row, callProject) => describeResource('conversation').deepLink(id, { projectId: projectOf(row, callProject) }),
  },
  'inbound-mail': {
    // A held mail is decided on its own page in the project's E-Mail-Eingang (ADR-0134): the
    // page an outside agent hands the person, since only they file it.
    idOf: (row) => text(row.id),
    path: (id, row, callProject) => {
      const project = projectOf(row, callProject)
      return project ? `/app/projects/${enc(project)}/files/mail/${enc(id)}` : null
    },
  },
}

function linked(row: Row, page: Page, callProject: string | null, origin: string): Row {
  if ('url' in row) return row
  const id = page.idOf(row)
  const path = id ? page.path(id, row, callProject) : null
  return path ? { ...row, url: `${origin}${path}` } : row
}

/**
 * `body` with a `url` on each object of `op.links`' kind; `body` unchanged when
 * the operation declares no links, no origin is pinned, or nothing matches.
 */
export function withLinks(op: AgentOperation, input: OperationInput, body: unknown, origin: string | null): unknown {
  if (!op.links || !origin) return body
  const page = PAGES[op.links]
  const callProject = callProjectId(op, input)
  const link = (value: unknown) => (isRow(value) ? linked(value, page, callProject, origin) : value)
  if (Array.isArray(body)) return body.map(link)
  if (!isRow(body)) return body
  if (page.idOf(body)) return link(body)
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [key, Array.isArray(value) ? value.map(link) : link(value)]),
  )
}
