/**
 * One thing a person can do in Piloti, described for an agent (ADR-0122).
 *
 * An operation is not a new door. It names a route the UI already calls
 * (`method` + `path`), says in words an agent can act on when to call it and
 * what comes back, and states the input as zod so it can be shown as JSON
 * Schema. The route stays the gate: its `authz` declaration, its rate limit,
 * its tenant slot and its own body parsing apply to an agent exactly as they
 * apply to a browser. The catalog only makes the door findable.
 *
 * The shape follows PostHog's MCP catalog, which is the reference for this
 * record: kebab-case `<entity>-<verb>` names under 52 characters, a short
 * summary for search, a description that names the next call, and annotations
 * that say whether a call reads, writes or destroys.
 */

import type { z } from 'zod'
import type { OperationInput } from './dispatch'

export type BodyEncoding = 'json' | 'multipart' | 'raw'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** A route handler as `lib/api/handler.ts` builds one. */
export type RouteHandler = (
  request: Request,
  context?: { params?: Promise<Record<string, string | string[]>> },
) => Promise<Response>

/** What `import('@/app/api/…/route')` resolves to, as far as the dispatcher reads it. */
export type RouteModule = Partial<Record<HttpMethod, RouteHandler>>

/** The areas of the workspace, in the order `tools` lists them. */
export const AGENT_DOMAINS = [
  'projects',
  'documents',
  'folders',
  'mail',
  'review',
  'conversations',
  'collaboration',
  'tasks',
  'skills',
  'knowledge',
  'bim',
  'organization',
  'platform',
] as const

export type AgentDomain = (typeof AGENT_DOMAINS)[number]

export interface AgentOperation {
  /** `<entity>-<verb>`, kebab-case, at most 52 characters, unique. */
  readonly name: string
  readonly domain: AgentDomain
  /** One line for `tools` and `search`. */
  readonly summary: string
  /**
   * When to call it, what it returns, and what to call next. Written for the
   * model: the description is the only guidance that reaches it.
   */
  readonly description: string
  readonly method: HttpMethod
  /** The route's path as its folder spells it: `/api/projects/[id]/members`. */
  readonly path: `/api/${string}`
  /**
   * The route module, imported lazily: `() => import('@/app/api/projects/[id]/members/route')`.
   * The dispatcher calls its `method` export, so the call runs the browser's
   * handler. `agent-reachability.spec.ts` holds the import to `path`.
   */
  readonly load: () => Promise<RouteModule>
  /** The dynamic segments, one key per `[name]` in `path`. */
  readonly params?: z.ZodObject<z.ZodRawShape>
  /** Query string parameters. */
  readonly query?: z.ZodObject<z.ZodRawShape>
  /** The JSON body the route parses, reused from the route's own schema where it is exported. */
  readonly body?: z.ZodTypeAny
  /**
   * How `body` reaches the route (default `json`). `multipart`: the agent sends
   * `{ files: [{ name, mimeType, contentBase64 }], fields? }` (`upload-wire.ts`)
   * and the dispatcher builds the `FormData` the UI's uploader builds. `raw`:
   * the agent sends `{ contentBase64 }` and the route receives those bytes as
   * `application/octet-stream`. The route's own parsing is the gate either way.
   */
  readonly bodyEncoding?: BodyEncoding
  /**
   * The media types a binary answer may have (a PDF, a Word file, a BCF zip).
   * Absent: the route answers JSON or text. A binary answer reaches an MCP
   * client as a `resource` content item, up to `MAX_INLINE_BYTES`.
   */
  readonly binaryResponse?: readonly string[]
  /**
   * A call that changes nothing. Defaults to `method === 'GET'`; a POST that
   * searches or computes says `true`.
   */
  readonly readOnly?: boolean
  /**
   * A call a person would confirm in the UI: it deletes, revokes or releases
   * something. Defaults to `method === 'DELETE'`.
   */
  readonly destructive?: boolean
  /** Calling it twice with the same input leaves the same state. Defaults to GET, PUT and DELETE. */
  readonly idempotent?: boolean
  /**
   * The route reads the `If-Match` header (the project profile's PUT), so the
   * agent's top-level `ifMatch` is offered and sent as that header. Only these
   * operations take it; a route that wants the version in its body declares
   * `ifMatch` in the body schema, and a top-level one anywhere else is refused.
   */
  readonly ifMatchHeader?: true
  /**
   * One to three realistic inputs, for an operation whose input is hard to get
   * right from the schema alone (nested bodies, patches, uploads). Shown in
   * `describe-operation` and as the input schema's JSON Schema `examples`;
   * `agent-reachability.spec.ts` holds each to the operation's own schemas.
   */
  readonly examples?: readonly OperationExample[]
  /**
   * An operation that widens who may do what (`access`: sharing, folder
   * access, project roles, role definitions), touches the organization's
   * secrets (`secret`: LLM provider keys), or turns a security or compliance
   * control down or off (`control`: zero data retention, upload screening, a
   * held file let through, a legal hold lifted, retention shortened). An agent
   * may call it for a person who holds
   * the right, under the extra guards ADR-0122 names: the organization opted
   * in, the client was granted the step-up scope, the person confirms, and
   * Piloti in-product only ever proposes it.
   */
  readonly sensitivity?: Sensitivity
  /**
   * The call runs only on the person's own yes: a decision a model must not
   * make for them however the call reached the door (ADR-0122, amendment "a
   * decision only the person makes"). An outside agent's call is put to the
   * person in their own chat when the client can ask them (`confirmation.ts`),
   * and is refused, never run, when it cannot: the refusal hands the agent
   * `decideAt`, the page where the person makes the decision themselves.
   * Piloti in-product only ever proposes a write, so the person's acceptance of
   * the card is the yes. For writes only (`confirmation.spec.ts` holds the
   * catalog to it); the client is told to confirm it (`destructiveHint`).
   */
  readonly requiresPersonConfirmation?: PersonConfirmation
  /**
   * A read whose answer can carry content of every project the person may
   * read, not only the one a call names (ADR-0122, "Shared conversations").
   * `always`: whatever the call names (similar passages search every project
   * the person reads). `unlessScoped`: unless the call names a project (the
   * conversation list without `projectId`). Piloti's read gate refuses it in a
   * solo conversation of a project: the record there covers that project only.
   */
  readonly spansProjects?: SpansProjects
  /**
   * Input the call is given when the caller does not say otherwise: set only on
   * the operation an old name resolves to (`RENAMED_OPERATIONS` with `input`),
   * so `office-shelf-document-list` still reads the office shelf as
   * `document-list` with `scope: office_shelf`. The caller's own values win.
   */
  readonly inputDefaults?: OperationExample
  /**
   * The kind of object the answer holds, when a person can open it in the app:
   * the door adds `url`, that object's page, to the answer itself or to each
   * row one level in (`links.ts`), where the deployment pins its origin.
   */
  readonly links?: LinkKind
}

/** What a door answer may link to: the objects with a page of their own in the app. */
export type LinkKind = 'project' | 'document' | 'task-run' | 'conversation' | 'inbound-mail'

export type SpansProjects = 'always' | 'unlessScoped'

/** An example input of an operation: `{ params, query, body }` as `call-operation` takes it. */
export interface OperationExample {
  readonly params?: Record<string, string>
  readonly query?: Record<string, unknown>
  readonly body?: unknown
}

/** How an operation that runs only on the person's yes sends them to decide it themselves. */
export interface PersonConfirmation {
  /**
   * The app page where the person makes this call's decision, for the call's
   * validated input: `/app/projects/<id>/files/mail/<mailId>` for one mail.
   * A path; the door prefixes the deployment's pinned origin.
   */
  readonly decideAt: (input: OperationInput) => `/app/${string}`
}

export const SENSITIVITIES = ['access', 'secret', 'control'] as const
export type Sensitivity = (typeof SENSITIVITIES)[number]

/**
 * The MCP tool annotations for `op` (specification, `ToolAnnotations`), every
 * hint stated rather than left to the spec's defaults: an absent
 * `destructiveHint` means "destructive", which would make every write look
 * like a delete to a client that asks its user before each one.
 */
export interface ToolAnnotations {
  readonly title: string
  readonly readOnlyHint: boolean
  readonly destructiveHint: boolean
  readonly idempotentHint: boolean
  /** Piloti's operations reach the organization's own workspace, a closed world. */
  readonly openWorldHint: false
}

export function annotationsOf(op: AgentOperation): ToolAnnotations {
  const readOnlyHint = op.readOnly ?? op.method === 'GET'
  return {
    title: op.summary,
    readOnlyHint,
    // A sensitive operation is always one the client confirms with the person, a read of
    // the organization's keys included, and so is one that runs only on the person's yes;
    // any other read never is.
    destructiveHint:
      op.sensitivity !== undefined ||
      op.requiresPersonConfirmation !== undefined ||
      (!readOnlyHint && (op.destructive ?? op.method === 'DELETE')),
    idempotentHint: readOnlyHint || (op.idempotent ?? (op.method === 'PUT' || op.method === 'DELETE')),
    openWorldHint: false,
  }
}

/** The `[name]` segments of a route path, in order. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/\[(?:\.\.\.)?([^\]]+)\]/g)].map((match) => match[1] as string)
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Two input slots merged, the caller's values over the defaults, one level into nested objects (`body.fields`). */
function mergeSlot(defaults: unknown, given: unknown): unknown {
  if (!isPlainObject(defaults)) return given
  if (given === undefined) return defaults
  if (!isPlainObject(given)) return given
  const merged: Record<string, unknown> = { ...defaults, ...given }
  for (const [key, value] of Object.entries(defaults)) {
    if (isPlainObject(value) && isPlainObject(given[key])) merged[key] = { ...value, ...given[key] }
  }
  return merged
}

/** `input` with an operation's {@link AgentOperation.inputDefaults} under it. */
export function withInputDefaults<T extends OperationExample>(input: T, defaults: OperationExample | undefined): T {
  if (!defaults) return input
  return {
    ...input,
    ...(defaults.params ? { params: mergeSlot(defaults.params, input.params) as Record<string, string> } : {}),
    ...(defaults.query ? { query: mergeSlot(defaults.query, input.query) as Record<string, unknown> } : {}),
    ...(defaults.body ? { body: mergeSlot(defaults.body, input.body) } : {}),
  }
}
