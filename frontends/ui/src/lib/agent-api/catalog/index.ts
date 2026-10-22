/**
 * Every operation Piloti's MCP server offers (ADR-0122): one list, built from
 * one file per domain so the domains grow without touching each other.
 *
 * `agent-reachability.spec.ts` holds this list to the routes: every route a
 * person can call is here, or exempt with a reason.
 */

import { AGENT_DOMAINS, type AgentOperation, type OperationExample } from '../operation'
import { bimOperations } from './bim'
import { collaborationOperations } from './collaboration'
import { consultOperations } from './consult'
import { conversationsOperations } from './conversations'
import { documentsOperations } from './documents'
import { foldersOperations } from './folders'
import { knowledgeOperations } from './knowledge'
import { mailOperations } from './mail'
import { organizationOperations } from './organization'
import { platformOperations } from './platform'
import { projectsOperations } from './projects'
import { reviewOperations } from './review'
import { skillsOperations } from './skills'
import { tasksOperations } from './tasks'

/**
 * Every operation's name, as a type: `exposure.config.ts` is keyed by it, so an
 * entry for a name no operation has, or an operation without an entry, does not compile.
 */
export type OperationName = (
  | typeof projectsOperations
  | typeof documentsOperations
  | typeof foldersOperations
  | typeof mailOperations
  | typeof reviewOperations
  | typeof conversationsOperations
  | typeof consultOperations
  | typeof collaborationOperations
  | typeof tasksOperations
  | typeof skillsOperations
  | typeof knowledgeOperations
  | typeof bimOperations
  | typeof organizationOperations
  | typeof platformOperations
)[number]['name']

const unordered: readonly AgentOperation[] = [
  ...projectsOperations,
  ...documentsOperations,
  ...foldersOperations,
  ...mailOperations,
  ...reviewOperations,
  ...conversationsOperations,
  ...consultOperations,
  ...collaborationOperations,
  ...tasksOperations,
  ...skillsOperations,
  ...knowledgeOperations,
  ...bimOperations,
  ...organizationOperations,
  ...platformOperations,
]

/**
 * Domain order, then name: `tools/list` SHOULD answer in a deterministic order
 * (MCP 2026-07-28), and a stable order keeps a client's prompt cache warm.
 */
export const AGENT_OPERATIONS: readonly AgentOperation[] = [...unordered].sort(
  (a, b) =>
    AGENT_DOMAINS.indexOf(a.domain) - AGENT_DOMAINS.indexOf(b.domain) || a.name.localeCompare(b.name),
)

const byName = new Map(AGENT_OPERATIONS.map((op) => [op.name, op]))

/**
 * Old operation names, each to the name that replaced it, accepted for one release (October 2026, the
 * agent-surface terminology pass: one English word per concept, `task` for a task definition and
 * `task run` for one attempt, `allow` for a held upload). Two readers still hold old names: an
 * `operation` proposal filed before the rename (its payload names the operation) and an agent that
 * remembers a name from an earlier conversation. Neither is listed or searchable under the old name.
 * `task-run-list` (one task's runs) merged into `project-task-run-list`, which takes the task as its
 * `taskId` filter (ADR-0131). Delete this map in the release after.
 */
/**
 * An old name that also fixes part of the input: the office shelf twins merged into their shelf
 * operation (ADR-0131 rule 5), so `office-shelf-document-list` is `document-list` with
 * `query.scope: office_shelf`. The input is a default; the caller's own values win.
 */
export interface RenamedWithInput {
  readonly to: string
  readonly input: OperationExample
}

const OFFICE_QUERY = { query: { scope: 'office_shelf' } } as const
const OFFICE_BODY = { body: { scope: 'office_shelf' } } as const

export const RENAMED_OPERATIONS: Readonly<Record<string, string | RenamedWithInput>> = {
  'job-list': 'task-list',
  'job-get': 'task-get',
  'job-create': 'task-create',
  'job-update': 'task-update',
  'job-delete': 'task-delete',
  'job-run': 'task-run-start',
  'job-run-list': 'project-task-run-list',
  'task-run-list': 'project-task-run-list',
  'task-review': 'task-run-review',
  'run-commission': 'task-run-commission',
  'run-get': 'task-run-get',
  'run-cancel': 'task-run-cancel',
  'run-document-add': 'task-run-document-add',
  'run-write-now': 'task-run-write-now',
  'document-quarantine-release': 'document-quarantine-allow',
  'document-quarantine-release-request': 'document-quarantine-allow-request',
  'project-document-list': 'document-list',
  'office-shelf-document-list': { to: 'document-list', input: OFFICE_QUERY },
  'office-shelf-document-summary': { to: 'document-summary-get', input: OFFICE_QUERY },
  'office-shelf-document-lookup': { to: 'document-by-name-resolve', input: OFFICE_BODY },
  'office-shelf-document-name-probe': { to: 'document-name-match', input: OFFICE_BODY },
  'office-shelf-document-revision-probe': { to: 'document-revision-candidates', input: OFFICE_BODY },
  'office-shelf-document-search': { to: 'document-search', input: OFFICE_BODY },
  'office-shelf-document-upload': { to: 'document-upload', input: { body: { fields: { scope: 'office_shelf' } } } },
  'office-shelf-document-delete': 'document-delete',
  // `params.versionId` still reaches the route, which reads it as `?versionId=`.
  'document-version-file-get': 'document-file-get',
}

/** The current name an old one leads to. */
export function renamedTo(name: string): string | undefined {
  const renamed = RENAMED_OPERATIONS[name]
  return typeof renamed === 'string' ? renamed : renamed?.to
}

/**
 * The operation `name` names, by its current name or a {@link RENAMED_OPERATIONS} one. `task-list` was
 * the project's task runs before the rename and is the project's tasks after it; an old proposal for it
 * cannot exist (it only reads), so the one ambiguous name resolves to its new meaning.
 */
export function findOperation(name: string): AgentOperation | undefined {
  const current = byName.get(name)
  if (current) return current
  const renamed = RENAMED_OPERATIONS[name]
  if (typeof renamed !== 'object') return byName.get(renamed ?? '')
  const op = byName.get(renamed.to)
  return op && { ...op, inputDefaults: renamed.input }
}
