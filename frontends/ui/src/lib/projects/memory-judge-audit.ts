/**
 * The restricted-memory judge's verdicts, in the audit trail (ADR-0084; AI Act).
 *
 * When a turn could have seen a restricted folder it did not read, a language
 * model judges whether a note Piloti keeps draws on it (`memory/restriction.py`).
 * Its answer decides who may read the note: "none" leaves the note open to the
 * whole project. That answer was only logged, so nobody could later ask which
 * notes a model opened. The agent now sends the verdict with the write, and
 * this records it with the item it was about: which note, which folders, and
 * the verdict. Never the note's text.
 *
 * An organization-wide finding a deployment refuses to store (the default) is
 * recorded too, against the organization: its "none" is what let the agent
 * offer it to the user as a card that writes it open, to the widest audience
 * memory has. `outcome` says which: `stored` or `refused`.
 *
 * The agent names collections; the trail names folders, resolved through the
 * one mapping (`sourceFoldersOfCollections`). A collection that no longer
 * resolves (its folder was opened since, or organization memory, which has no
 * project to resolve against) is recorded by its name rather than dropped.
 */

import 'server-only'
import { z } from 'zod'
import { recordAuditEvent, SYSTEM_ACTORS } from '@/lib/audit/service'
import { sourceFoldersOfCollections } from '@/lib/authz/folder-access'
import { PROJECT_MEMORY_JUDGE_VERDICTS, type ProjectMemoryItem } from '@/lib/db/schema'
import { findProjectInOrg } from './repository'

/** The `restrictionJudge` body field of `POST /api/internal/memory`. */
export const memoryJudgeVerdictSchema = z.object({
  verdict: z.enum(PROJECT_MEMORY_JUDGE_VERDICTS),
  // Bounded generously: the judge is shown at most 150 entries, and a write
  // must not fail because its audit record was large.
  judgedCollections: z.array(z.string().max(255)).max(1000),
  drawnCollections: z.array(z.string().max(255)).max(1000).default([]),
})

export type MemoryJudgeVerdict = z.infer<typeof memoryJudgeVerdictSchema>

type JudgedItem = Pick<
  ProjectMemoryItem,
  'id' | 'organizationId' | 'projectId' | 'restrictedFolderIds' | 'provenanceType' | 'sourceConversationId'
>

/**
 * An organization-wide finding this deployment refused to store
 * (`GRID_ALLOW_AGENT_ORG_MEMORY` unset, the default). The judge's "none" still
 * decided something: the finding stayed open, so the agent offered it to the
 * user as a card that writes it open, organization-wide or to the project.
 */
type RefusedWrite = Pick<ProjectMemoryItem, 'organizationId' | 'provenanceType' | 'sourceConversationId'>

/** What the verdict was about, as the trail names it. */
interface JudgedSubject {
  organizationId: string
  projectId: string | null
  targetType: 'project_memory_item' | 'organization'
  targetId: string
  outcome: 'stored' | 'refused'
  restrictedFolderIds: readonly string[]
  provenance: string
  conversationId: string | null
}

/** WorkOS keeps metadata values to 500 characters; the counts say when a list was cut. */
const joined = (values: readonly string[]): string => values.join(',').slice(0, 500)

async function folderOfCollection(subject: JudgedSubject, collections: readonly string[]): Promise<Map<string, string>> {
  if (!subject.projectId || collections.length === 0) return new Map()
  const project = await findProjectInOrg(subject.projectId, subject.organizationId)
  if (!project) return new Map()
  return sourceFoldersOfCollections(subject.organizationId, subject.projectId, project.collectionName, collections)
}

async function recordVerdict(subject: JudgedSubject, judge: MemoryJudgeVerdict): Promise<void> {
  try {
    const named = [...new Set([...judge.judgedCollections, ...judge.drawnCollections])]
    const folders = await folderOfCollection(subject, named)
    const asFolders = (collections: readonly string[]) =>
      [...new Set(collections.map((name) => folders.get(name) ?? name))].sort()
    const judged = asFolders(judge.judgedCollections)
    const drawn = asFolders(judge.drawnCollections)
    await recordAuditEvent({
      organizationId: subject.organizationId,
      actor: { userId: SYSTEM_ACTORS.memoryJudge, email: null },
      action: 'project.memory.restriction_judged',
      targetType: subject.targetType,
      targetId: subject.targetId,
      metadata: {
        projectId: subject.projectId ?? '',
        verdict: judge.verdict,
        outcome: subject.outcome,
        judgedFolders: joined(judged),
        judgedCount: judged.length,
        drawnFolders: joined(drawn),
        drawnCount: drawn.length,
        restrictedFolders: joined(subject.restrictedFolderIds),
        provenance: subject.provenance,
        conversationId: subject.conversationId ?? '',
      },
    })
  } catch (error) {
    // The note is written (or refused for its own reason); an audit line that
    // could not be assembled must not turn that into a different answer.
    console.error('[memory-judge-audit] could not record the judge verdict:', error)
  }
}

/** Record the judge's verdict on this item. Never throws. */
export async function recordMemoryJudgeVerdict(item: JudgedItem, judge: MemoryJudgeVerdict): Promise<void> {
  await recordVerdict(
    {
      organizationId: item.organizationId,
      projectId: item.projectId,
      targetType: 'project_memory_item',
      targetId: item.id,
      outcome: 'stored',
      restrictedFolderIds: item.restrictedFolderIds ?? [],
      provenance: item.provenanceType,
      conversationId: item.sourceConversationId,
    },
    judge
  )
}

/**
 * Record the judge's verdict on an organization-wide finding that was refused,
 * against the organization it was meant for: there is no item to name. Never
 * throws.
 */
export async function recordRefusedMemoryJudgeVerdict(refused: RefusedWrite, judge: MemoryJudgeVerdict): Promise<void> {
  await recordVerdict(
    {
      organizationId: refused.organizationId,
      projectId: null,
      targetType: 'organization',
      targetId: refused.organizationId,
      outcome: 'refused',
      restrictedFolderIds: [],
      provenance: refused.provenanceType,
      conversationId: refused.sourceConversationId,
    },
    judge
  )
}
