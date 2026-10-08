/**
 * What a closed project knows about itself (docs/design/closed-project-experience.md):
 * the closing extraction has the backend read the project's own documents once,
 * and writes what it finds as suggestions a person confirms. Fingerprint values
 * land as profile assumptions (`agent_suggested`, `unconfirmed`, the evidence as
 * the reason); decisions land as memory rows (`distillation`, `source_grounded`).
 *
 * Authorization is the caller's `requireProjectAccess` (`project:memory:write` or `project:edit`),
 * which refuses a closed project: the write has to happen while it is active.
 * The BFF checks every value against the vocabulary and drops anything without
 * evidence, so one stray token cannot fail the whole profile patch.
 *
 * What it writes is unrestricted (every member reads the profile, and the
 * memory rows carry no folder restriction), so it may come only from files
 * every member may open: the BFF names them (`extractableFileNames`), the
 * backend reads no other, and evidence naming any other file is dropped here
 * before anything is written, whatever the backend answered.
 */

import 'server-only'
import { NotFoundError } from '@/lib/api/errors'
import { getBackendUrl } from '@/lib/backend-proxy'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import { maskChatText } from '@/lib/upload-screening/service'
import { patchProjectProfile } from '@/lib/project-profile/profile-service'
import { salvageProjectProfile } from '@/lib/project-profile/salvage'
import { emptyProjectProfile } from '@/lib/project-profile/patch-engine'
import type { ProjectPrimitiveValue, ProjectProfile, ProjectProfilePatchOperation } from '@/lib/project-profile/types'
import { createProjectMemoryItemForProject, listProjectMemory } from '@/lib/projects/memory-service'
import { findProjectInOrg } from '@/lib/projects/repository'
import {
  EXPERIENCE_KNOWN_DECISIONS_MAX,
  EXPERIENCE_KNOWN_DECISION_MAX_CHARS,
  experienceResponseSchema,
  type ExperienceDecision,
  type ExperienceEvidence,
  type ExperienceFingerprintItem,
  type ExperienceRequest,
  type ExperienceResponse,
  type ExperienceVocabulary,
  type ExperienceVocabularyEntry,
  type ProjectExperienceResult,
} from './types'
import { extractableFileNames } from './readable-files'
import { experienceVocabulary } from './vocabulary'

/**
 * Three model calls over at most 24 000 characters. Kept under the ~100 s the
 * edge proxy gives a request (profile-service.ts): past it the dialog sees a
 * 504 while the write would still land, so a slower extraction is abandoned
 * here and the person asks again.
 */
const EXTRACTION_TIMEOUT_MS = 90_000

const UNAVAILABLE: ProjectExperienceResult = { suggested: 0, drafted: 0, documentsRead: [], error: 'backend_unavailable' }
const NO_DOCUMENTS: ProjectExperienceResult = { suggested: 0, drafted: 0, documentsRead: [], error: 'no_documents' }

/**
 * The items whose evidence names a file the extraction was allowed to read,
 * each with only that evidence. One left with none is dropped: an
 * unrestricted suggestion must not rest on a file not every member may open.
 */
function readFrom<Item extends { evidence: ExperienceEvidence[] }>(items: Item[], readable: ReadonlySet<string>): Item[] {
  return items.flatMap((item) => {
    const evidence = item.evidence.filter((entry) => readable.has(entry.fileName))
    return evidence.length > 0 ? [{ ...item, evidence }] : []
  })
}

/** Keys a person answered, flat or per building: `bauweise@bw1` confirms `bauweise`. */
function confirmedFactKeys(profile: ProjectProfile): Set<string> {
  return new Set(
    Object.entries(profile.facts)
      .filter(([, fact]) => fact.value !== null)
      .map(([key]) => key.split('@')[0] ?? key)
  )
}

/** One fingerprint value as the profile stores it, or null when it is not an allowed token. */
function storedValue(key: string, entry: ExperienceVocabularyEntry, value: string | string[]): ProjectPrimitiveValue | null {
  const tokens = typeof value === 'string' ? [value] : value
  const allowed = new Set(entry.options.map((option) => option.token))
  if (!tokens.every((token) => allowed.has(token))) return null
  if (entry.multiple) return [...new Set(tokens)]
  const token = tokens.length === 1 ? tokens[0] : undefined
  if (token === undefined) return null
  // The Gebäudeklasse is a number in the profile, as the intake derives it.
  return key === 'gebaeudeklasse' ? Number(token) : token
}

function entryOf(vocabulary: ExperienceVocabulary, key: string): ExperienceVocabularyEntry | undefined {
  return Object.entries(vocabulary).find(([name]) => name === key)?.[1]
}

/**
 * Where a value was read: `Datei, S. n: „quote"`, the page omitted when the
 * document has none. Masked against the office's „Sensible Daten" policy
 * (ADR-0086) like a memory note: the profile is read by every member and rides
 * every turn, and a Bescheid's quote can name its addressee.
 */
async function reasonOf(organizationId: string, evidence: ExperienceEvidence): Promise<string> {
  const where = evidence.page ? `${evidence.fileName}, S. ${evidence.page}` : evidence.fileName
  return (await maskChatText(organizationId, `${where}: „${evidence.quote}"`)).text
}

/**
 * The assumption operations for the fingerprint values the extraction found:
 * one per key, skipping a key a person confirmed, a key the vocabulary does not
 * know, a value outside the vocabulary and a value without a quote.
 */
async function fingerprintOperations(
  organizationId: string,
  fingerprint: ExperienceFingerprintItem[],
  vocabulary: ExperienceVocabulary,
  knownKeys: ReadonlySet<string>,
  updatedAt: string
): Promise<ProjectProfilePatchOperation[]> {
  const operations = new Map<string, ProjectProfilePatchOperation>()
  for (const item of fingerprint) {
    const entry = entryOf(vocabulary, item.key)
    const [evidence] = item.evidence
    if (!entry || !evidence || knownKeys.has(item.key) || operations.has(item.key)) continue
    const value = storedValue(item.key, entry, item.value)
    if (value === null) continue
    operations.set(item.key, {
      op: 'add',
      path: `/assumptions/${item.key}`,
      value: {
        value,
        status: 'unconfirmed',
        reason: await reasonOf(organizationId, evidence),
        source: 'agent_suggested',
        updatedAt,
      },
    })
  }
  return [...operations.values()]
}

/** The project's active decisions and constraints, as the pen must not draft them again. */
async function knownDecisionsOf(projectId: string, organizationId: string): Promise<string[]> {
  const items = await listProjectMemory(projectId, { organizationId })
  return items
    .filter((item) => item.kind === 'decision' || item.kind === 'constraint')
    .slice(0, EXPERIENCE_KNOWN_DECISIONS_MAX)
    .map((item) => item.content.slice(0, EXPERIENCE_KNOWN_DECISION_MAX_CHARS))
}

/** Store each decision that names its evidence; one without is not source-grounded and is dropped. */
async function writeDecisions(projectId: string, decisions: ExperienceDecision[]): Promise<number> {
  let drafted = 0
  for (const decision of decisions) {
    if (decision.evidence.length === 0) continue
    const item = await createProjectMemoryItemForProject(projectId, {
      kind: decision.kind,
      content: decision.content,
      confidence: 'medium',
      provenanceType: 'distillation',
      verification: 'source_grounded',
      evidence: decision.evidence.map((evidence) => ({ fileName: evidence.fileName, page: evidence.page || null })),
    })
    if (item) drafted += 1
  }
  return drafted
}

/**
 * One call to the backend's extractor. Null when it could not be reached, did
 * not answer 200, or answered something that is not the contract: all three
 * leave the project untouched.
 */
async function askBackend(body: ExperienceRequest): Promise<ExperienceResponse | null> {
  let response: Response
  try {
    response = await fetch(`${getBackendUrl()}/v1/internal/project-experience`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-grid-internal-token': process.env.GRID_INTERNAL_API_TOKEN ?? '',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
    })
  } catch (error) {
    console.warn('[project-experience] Backend unreachable:', error)
    return null
  }
  if (!response.ok) {
    console.warn('[project-experience] Backend returned', response.status)
    return null
  }
  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    return null
  }
  const parsed = experienceResponseSchema.safeParse(raw)
  if (!parsed.success) {
    console.warn('[project-experience] Backend answered outside the contract')
    return null
  }
  return parsed.data
}

/**
 * Read the project's own documents and write what they say as suggestions:
 * fingerprint values as profile assumptions, decisions as memory rows. Nothing
 * is confirmed here; a person does that.
 */
export async function extractProjectExperience(
  session: AuthorizedSession,
  projectId: string
): Promise<ProjectExperienceResult> {
  // As the memory routes beside it: the memory permission or the project-edit umbrella.
  await requireProjectAccess(session, projectId, ['project:memory:write', 'project:edit'])
  const project = await findProjectInOrg(projectId, session.organizationId)
  if (!project) throw new NotFoundError()

  const profile = salvageProjectProfile(project.profile).profile ?? emptyProjectProfile()
  const knownKeys = confirmedFactKeys(profile)
  const vocabulary = experienceVocabulary()
  const fileNames = await extractableFileNames(session.organizationId, projectId, project.collectionName)
  if (fileNames.length === 0) return NO_DOCUMENTS
  const readable = new Set(fileNames)
  const response = await askBackend({
    organizationId: session.organizationId,
    projectId,
    collection: project.collectionName,
    fileNames,
    vocabulary,
    knownFacts: [...knownKeys],
    knownDecisions: await knownDecisionsOf(projectId, session.organizationId),
  })
  if (!response) return UNAVAILABLE
  if (response.error) return { suggested: 0, drafted: 0, documentsRead: [], error: response.error }

  const operations = await fingerprintOperations(
    session.organizationId,
    readFrom(response.fingerprint, readable),
    vocabulary,
    knownKeys,
    new Date().toISOString()
  )
  if (operations.length > 0) await patchProjectProfile(session, projectId, operations)
  const drafted = await writeDecisions(projectId, readFrom(response.decisions, readable))
  const documentsRead = response.documentsRead.filter((name) => readable.has(name))
  return { suggested: operations.length, drafted, documentsRead, error: null }
}
