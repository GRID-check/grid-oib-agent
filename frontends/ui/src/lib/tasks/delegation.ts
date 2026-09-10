import 'server-only'
/**
 * Delegating work: a task row, and the run that carries it out (ADR-0051).
 *
 * `jobs` was the only trigger a task had. The roadmap named two more —
 * "a chat handoff (@Piloti prüf das bis Freitag) becomes another; an event
 * becomes a third" — and this module is the first of them, plus the one the
 * document lifecycle raises when a reviewer sends back work nobody is sitting
 * in a conversation waiting for.
 *
 * ## It is not a second queue
 *
 * The execution path is unchanged: `submitAgentRun` (`lib/jobs/service.ts`)
 * builds the same context, mints the same signed envelope and calls the same
 * `submitJob`; the worker is the same worker; the outcome comes back through the
 * same `/api/internal/jobs/[jobId]/outcome` route and closes the row through the
 * same `completeTaskForRun`. What differs is only what assembled the spec — a
 * job row before, a person's sentence now.
 *
 * ## Why a delegated task has no `job_runs` row
 *
 * `job_runs.schedule_id` is NOT NULL and its RLS predicate requires the row to
 * name a `jobs` row (migration 0043). Giving every "@Piloti prüf das" a hidden
 * job row would put a scheduled-job entry in the project's Aufträge list for a
 * sentence somebody typed once, and making the column nullable would move the
 * tenant boundary of a table this change has no business touching. So the task
 * row IS the record: it already carries the backend job id (its unique index is
 * what the worker reports against), the frozen plan, the requester and the
 * lifecycle. The outcome route looks a run up first and falls back to the task,
 * which is the one branch this arrangement costs.
 *
 * ## The kinds, and what runs each
 *
 * {@link TASK_ENGINES} is the whole mapping, as data. Every kind runs as a
 * `chat` output, so the work lands in a real conversation the team can open,
 * read and keep typing into — which is also where a `document` or `revision`
 * task's draft card appears. A kind whose engine is a SKILL names it and nothing
 * else; a kind whose engine is a tool says so in its prompt. Adding a kind is a
 * member of `DELEGATABLE_TASK_KINDS` plus a row here.
 */

import { ForbiddenError, NotFoundError, UnprocessableError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { DelegatableTaskKind, Task, TaskPlan } from '@/lib/db/schema'
import { DELEGATABLE_TASK_KINDS } from '@/lib/db/schema'
import { submitAgentRun } from '@/lib/jobs/service'
import { JobSubmitError, JobSubmitSkippedError } from '@/lib/jobs/backend-client'
import { resolveSkillSnapshot } from '@/lib/skills/service'
import type { SkillSnapshot } from '@/lib/skills/types'
import { emptySkillSnapshot } from '@/lib/jobs/types'
import * as repository from './repository'
import { TASK_GOAL_MAX_CHARS } from './wire'

// Re-exported so a caller reaching for the bound has one place to look, while
// the DECLARATION stays in the wire module the route parses with.
export { TASK_GOAL_MAX_CHARS }

/**
 * How much of the version being revised is quoted into the revision prompt.
 *
 * A ceiling and not a summary: the run needs the document it is revising, and a
 * summarised document is a different document. Past this the prompt says so and
 * the run reads the rest from the working directory, which is where the bytes
 * are put for it.
 */
export const REVISION_SOURCE_MAX_CHARS = 60_000

/** What one task kind runs on. `skill` and `instruction` are alternatives. */
interface TaskEngine {
  /** A builtin or org skill to attach, resolved at delegation time and frozen. */
  readonly skill: string | null
  /**
   * The instruction the run is submitted with, in German because it is read by
   * the same agent the chat surface talks to. `goal` is the requester's own
   * sentence and is always quoted verbatim beside it.
   */
  readonly instruction: (goal: string) => string
  /** What the row is called in the inbox and in the task list. */
  readonly title: (goal: string) => string
}

const TASK_ENGINES: Record<DelegatableTaskKind, TaskEngine> = {
  /**
   * The compliance checker (`agents/compliance_checker/`), reached through the
   * `compliance_check` tool the chat agent already binds. No skill: the engine
   * is bounded and deterministic and needs no playbook on top of it.
   */
  compliance_check: {
    skill: null,
    instruction: (goal) =>
      [
        'Führe für dieses Projekt eine Normprüfung durch: rufe `compliance_check` auf und',
        'arbeite das Ergebnis zu einer Antwort aus, die je Punkt sagt, was erfüllt ist,',
        'was offen ist und woran das hängt. Nenne für jeden Befund die Fundstelle.',
        '',
        'Der Auftrag, wörtlich:',
        goal,
      ].join('\n'),
    title: (goal) => `Normprüfung: ${goal}`,
  },
  /**
   * The builtin Einreichcheck skill, whose "Done" section is literally the work
   * list. Attached by name and snapshotted, exactly as a job attaches one.
   */
  einreichcheck: {
    skill: 'einreichcheck',
    instruction: (goal) =>
      ['Prüfe die Vollständigkeit der Einreichung für dieses Projekt.', '', 'Der Auftrag, wörtlich:', goal].join('\n'),
    title: (goal) => `Einreichcheck: ${goal}`,
  },
  /**
   * Write a document. The RUN's answer IS the document, and the filing happens
   * at completion (`completeTaskForRun` → `fileAgentDocumentDraft`).
   *
   * It is deliberately NOT told to call `file_draft`. The job worker injects
   * three unsigned identity headers and never the signed envelope, so that tool
   * has no acting person and refuses — correctly, and by design
   * (`src/aiq_agent/tools/AGENTS.md`, "echo, never sign"). Telling the run to
   * call it would spend its budget on a refusal and then have it report a
   * failure for work it had actually done. The BFF is the party with a real
   * session at completion, so the BFF files.
   */
  document: {
    skill: null,
    instruction: (goal) =>
      [
        'Schreibe das beauftragte Dokument VOLLSTÄNDIG als deine Antwort, in Markdown,',
        'mit einer Überschrift (`# …`) am Anfang. Die Antwort IST das Dokument: keine',
        'Zusammenfassung davor, keine Rückfrage, kein „ich könnte".',
        'Piloti legt es danach als ENTWURF im Projekt ab und legt es zur Freigabe vor —',
        'behaupte nicht, es sei freigegeben.',
        '',
        'Der Auftrag, wörtlich:',
        goal,
      ].join('\n'),
    title: (goal) => `Dokument: ${goal}`,
  },
  /**
   * Revise a version a reviewer sent back.
   *
   * Its prompt carries the reviewer's words AND the prior version's own text,
   * because the run has neither a conversation to read them out of nor a person
   * to ask. As with `document`, the answer is the revised document and the
   * filing happens at completion — over the open draft of the SAME item, never
   * as a second one.
   */
  revision: {
    skill: null,
    instruction: (goal) =>
      [
        'Eine Person hat einen Entwurf zurückgegeben. Überarbeite ihn nach dem, was sie',
        'geschrieben hat, und gib das ÜBERARBEITETE DOKUMENT vollständig als deine',
        'Antwort aus, in Markdown, mit Überschrift. Die Antwort IST die neue Fassung:',
        'keine Liste der Änderungen, kein Kommentar davor.',
        'Piloti macht daraus die nächste Version desselben Dokuments und legt sie wieder',
        'zur Freigabe vor.',
        '',
        'Der Auftrag, wörtlich:',
        goal,
      ].join('\n'),
    title: (goal) => `Überarbeitung: ${goal}`,
  },
}

/** Whether a string is a kind a person may delegate. */
export function isDelegatableTaskKind(value: string): value is DelegatableTaskKind {
  return (DELEGATABLE_TASK_KINDS as readonly string[]).includes(value)
}

export interface DelegateTaskInput {
  projectId: string
  kind: DelegatableTaskKind
  /** What was asked, in the requester's own words. */
  goal: string
  /** When it is wanted. Recorded on the row; the scheduler enforces it later. */
  dueAt?: Date | null
  /** The version a `revision` task is about, and the reviewer's words. */
  subject?: TaskPlan['subject']
  /**
   * The text the run is revising, already read in the caller's own session and
   * bounded here. Quoted into the prompt rather than fetched by the worker,
   * because the worker holds no signed envelope and therefore acts as nobody —
   * the BFF is the only party in this chain with a real session at the moment
   * the task is created.
   */
  sourceText?: string | null
  /**
   * Whose permission the RUN acts under, when that is not the caller.
   *
   * The one case is a revision: the reviewer authorizes the delegation (it is
   * their decision), and the person whose permissions must carry the re-filing
   * is whoever filed the draft in the first place. Defaults to the caller, which
   * is what „@Piloti prüf das" means.
   */
  requester?: { userId: string; email: string | null }
}

/**
 * Create a task and put its run on the queue, as the caller.
 *
 * `project:edit`, the same permission a review is recorded under: delegating
 * work is a statement about the project's own record, made by somebody who may
 * change that record. It is deliberately NOT `project:skills:manage` — that
 * permission gates the recurring machinery a person sets up once, and asking for
 * it here would mean an architect who may edit a project could not ask Piloti to
 * check it.
 *
 * The row is written BEFORE the submission and patched after, so a submission
 * that fails leaves a `failed` task carrying the reason rather than nothing at
 * all — the opposite order would lose exactly the case a person most wants
 * explained.
 */
export async function delegateTask(
  session: AuthorizedSession,
  input: DelegateTaskInput,
): Promise<Task> {
  await requireProjectAccess(session, input.projectId, ['project:edit', 'project:documents:write'])

  const goal = input.goal.trim()
  if (!goal) throw new UnprocessableError('A task needs a goal')
  if (goal.length > TASK_GOAL_MAX_CHARS) {
    throw new UnprocessableError(`A goal is at most ${TASK_GOAL_MAX_CHARS} characters`)
  }
  if (input.kind === 'revision' && !input.subject) {
    throw new UnprocessableError('A revision task needs the version it is revising')
  }

  const engine = TASK_ENGINES[input.kind]
  const skill = engine.skill ? await resolveDelegatedSkill(engine.skill, session.organizationId) : null
  const prompt = [engine.instruction(goal), sourceBlock(input.sourceText), skillBlock(skill)]
    .filter(Boolean)
    .join('\n\n')
  const requester = input.requester ?? { userId: session.userId, email: session.email }

  const task = await repository.insertTask({
    organizationId: session.organizationId,
    projectId: input.projectId,
    kind: input.kind,
    title: engine.title(goal).slice(0, 200),
    plan: {
      prompt,
      skill: skill ?? emptySkillSnapshot(),
      dataSources: null,
      goal,
      subject: input.subject ?? null,
    },
    requesterUserId: requester.userId,
    requesterEmail: requester.email,
    status: 'queued',
    deadlineAt: input.dueAt ?? null,
  })

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'task.created',
    targetType: 'task',
    targetId: task.id,
    metadata: { projectId: input.projectId, kind: input.kind, trigger: 'delegated' },
  })

  return dispatchTask(task)
}

/**
 * Submit a queued task's run and record what came back.
 *
 * Never throws: a task whose run could not be submitted is a `failed` row with
 * the reason on it, which is what the requester's inbox and the task list can
 * both read. Throwing would leave the caller — the chat tool, or a lifecycle
 * effect running inside a reviewer's request — to invent a second way of saying
 * the same thing.
 */
async function dispatchTask(task: Task): Promise<Task> {
  try {
    const { backendJobId, conversationId } = await submitAgentRun({
      organizationId: task.organizationId,
      projectId: task.projectId,
      userId: task.requesterUserId,
      ownerEmail: task.requesterEmail,
      prompt: task.plan.prompt,
      skillSnapshot: task.plan.skill.name ? task.plan.skill : null,
      // Every delegated kind runs as a chat output: the work lands in a real
      // thread, which is where a draft card and a follow-up question can live.
      output: 'chat',
      dataSources: task.plan.dataSources,
      conversationTitle: task.title,
      jobId: null,
    })
    return (
      (await repository.updateTask(task.id, task.organizationId, {
        status: 'running',
        backendJobId,
        conversationId,
        startedAt: new Date(),
      })) ?? task
    )
  } catch (error) {
    const detail =
      error instanceof JobSubmitSkippedError || error instanceof JobSubmitError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Unexpected error while preparing the run'
    console.error('[tasks] could not submit the run for task', task.id, error)
    return (
      (await repository.updateTask(task.id, task.organizationId, {
        status: 'failed',
        error: detail.slice(0, 2000),
        finishedAt: new Date(),
      })) ?? task
    )
  }
}

/**
 * The document being revised, quoted into the prompt.
 *
 * Fenced, so the model can tell the document from the instruction around it, and
 * truncated with a sentence that says so — a silently cut document reads as one
 * that ends mid-paragraph, and the model then "fixes" an ending nobody wrote.
 */
function sourceBlock(text: string | null | undefined): string {
  const body = (text ?? '').trim()
  if (!body) return ''
  const cut = body.length > REVISION_SOURCE_MAX_CHARS
  const shown = cut ? body.slice(0, REVISION_SOURCE_MAX_CHARS) : body
  return [
    'Die bisherige Fassung, wörtlich:',
    '',
    '```markdown',
    shown,
    '```',
    ...(cut ? ['', 'Diese Fassung ist hier gekürzt; der Rest steht unverändert im Projekt.'] : []),
  ].join('\n')
}

/** The attached skill's frozen snapshot, or a refusal naming it. */
async function resolveDelegatedSkill(name: string, organizationId: string): Promise<SkillSnapshot> {
  try {
    return await resolveSkillSnapshot(name, organizationId)
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) {
      throw new UnprocessableError(`The skill "${name}" is not available to this organization`)
    }
    throw error
  }
}

/**
 * The skill body, appended the way `buildFirePrompt` appends it.
 *
 * The same words in the same order, because the run is submitted the same way a
 * job's is and a second wording would be a second contract for the model to
 * learn. It is a small duplication of `buildFirePrompt` and a deliberate one:
 * that function is pinned byte-for-byte against the job builder's WYSIWYG
 * preview (`features/skills/lib/fire-prompt-preview.ts`), and a delegated task
 * has no preview pane to keep in step with.
 */
function skillBlock(skill: SkillSnapshot | null): string {
  if (!skill) return ''
  return [
    '---',
    '',
    'Verwende dabei den folgenden Skill verbindlich und vollständig.',
    '',
    `Skill: ${skill.name}`,
    `Beschreibung: ${skill.description}`,
    '',
    skill.body,
    '---',
  ].join('\n')
}
