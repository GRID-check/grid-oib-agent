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
 * ## Why a delegation is a `once` definition
 *
 * A chat handover was never a different species of work from a scheduled
 * check; it is the same standing intent with a degenerate trigger. Migration
 * 0086 gave it the home that says so: `task_definitions` with
 * `trigger = 'once'` and no `due_at`, and one `task_runs` row for the attempt
 * being dispatched right now. Chat will be able to say „jeden Montag" by
 * writing a cron on that same row, not by inventing a job.
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
import type {
  DelegatableTaskKind,
  NewTaskDefinition,
  TaskDefinition,
  TaskPlan,
  TaskRun,
} from '@/lib/db/schema'
import { DELEGATABLE_TASK_KINDS } from '@/lib/db/schema'
import { createTaskThread, submitAgentRun } from '@/lib/jobs/service'
import { JobSubmitError, JobSubmitSkippedError } from '@/lib/jobs/backend-client'
import { minIntervalMinutesFromEnv, nextOccurrence, validateCron } from '@/lib/jobs/schedule'
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
   * A norm check run by the general agent (the purpose-built
   * `agents/compliance_checker/` tool is retired and no longer bound).
   * No skill: the run works from the regulation corpus and project files
   * with the retrieval tools it already binds.
   */
  compliance_check: {
    skill: null,
    instruction: (goal) =>
      [
        'Führe für dieses Projekt eine Normprüfung durch: arbeite mit `knowledge_search` und `read_passage`',
        'und arbeite das Ergebnis zu einer Antwort aus, die je Punkt sagt, was erfüllt ist,',
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

/** Cadence of a recurring delegation: what the scheduler will claim. */
export interface DelegateTaskCadence {
  /** 5-field cron, the schedule builder's own shape. */
  cron: string
  /** IANA zone; UTC when the caller named none. */
  timezone?: string
}

export interface DelegateTaskInput {
  projectId: string
  kind: DelegatableTaskKind
  /** What was asked, in the requester's own words. */
  goal: string
  /** When it is wanted. Recorded on the row; the scheduler enforces it later. */
  dueAt?: Date | null
  /**
   * Recurrence, when the requester asked for it („jeden Montag"). A definition
   * with a cadence is a `schedule`: no run is dispatched now, the scheduler
   * fires it. Gated on `project:skills:manage` — the permissioned act is the
   * recurrence, not the asking.
   */
  cadence?: DelegateTaskCadence | null
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
  /**
   * The thread the work was commissioned in, when a person was typing in one.
   *
   * A run is one message in that thread (ADR-0062), so „@Piloti prüf das bis
   * Freitag" answers where it was asked instead of in a conversation minted for
   * it that nobody knows to open. Absent for a delegation nobody typed — a
   * reviewer's send-back on a version with no origin — and then the definition's
   * own thread holds the run.
   */
  conversationId?: string | null
}

/**
 * What delegating produced: the standing definition, and the run that carries
 * it out — null when a cadence made it a schedule the scheduler will fire.
 */
export interface DelegateTaskResult {
  definition: TaskDefinition
  run: TaskRun | null
}

/**
 * Create a definition and, unless a cadence was asked for, its first run — then
 * put that run on the queue, as the caller.
 *
 * `project:edit` for the asking, the same permission a review is recorded
 * under: delegating work is a statement about the project's own record. A
 * CADENCE adds `project:skills:manage`, because recurrence is the stricter,
 * repeated-spend act (the same split the definition editor applies).
 *
 * The definition and the run are written BEFORE the submission and patched
 * after, so a submission that fails leaves a `failed` run carrying the reason
 * rather than nothing at all — the opposite order would lose exactly the case a
 * person most wants explained. A scheduled definition has no first run yet: the
 * scheduler owns every fire, so there is nothing to submit here.
 */
export async function delegateTask(
  session: AuthorizedSession,
  input: DelegateTaskInput,
): Promise<DelegateTaskResult> {
  await requireProjectAccess(session, input.projectId, ['project:edit', 'project:documents:write'])

  const goal = input.goal.trim()
  if (!goal) throw new UnprocessableError('A task needs a goal')
  if (goal.length > TASK_GOAL_MAX_CHARS) {
    throw new UnprocessableError(`A goal is at most ${TASK_GOAL_MAX_CHARS} characters`)
  }
  if (input.kind === 'revision' && !input.subject) {
    throw new UnprocessableError('A revision task needs the version it is revising')
  }
  if (input.cadence && input.dueAt) {
    throw new UnprocessableError('A task is either one-off (due) or recurring (cadence), never both')
  }

  // Permissions attach to the TRIGGER, the same rule the definition editor
  // uses: asking for work is `project:edit`; asking for it every Monday,
  // unattended and on repeat, is `project:skills:manage`. The denial is
  // reworded so the refusal names the permission in the sentence the model
  // relays — a bare "Forbidden." teaches the reader nothing actionable.
  //
  // `requireProjectAccess` answers a missing permission with NotFoundError, not
  // ForbiddenError, because a 404 does not leak the project's existence. The
  // caller already passed the same check for `project:edit`/
  // `project:documents:write` on this project, so a NotFoundError from THIS
  // call is specifically the skills:manage denial.
  if (input.cadence) {
    try {
      await requireProjectAccess(session, input.projectId, 'project:skills:manage')
    } catch (error) {
      if (error instanceof ForbiddenError || error instanceof NotFoundError) {
        throw new ForbiddenError(
          'Für wiederkehrende Aufträge fehlt die Berechtigung project:skills:manage.',
        )
      }
      throw error
    }
  }

  const engine = TASK_ENGINES[input.kind]
  const skill = engine.skill ? await resolveDelegatedSkill(engine.skill, session.organizationId) : null
  const prompt = [engine.instruction(goal), sourceBlock(input.sourceText), skillBlock(skill)]
    .filter(Boolean)
    .join('\n\n')
  const requester = input.requester ?? { userId: session.userId, email: session.email }
  const title = engine.title(goal).slice(0, 200)

  // Validate before computing the first occurrence: `nextOccurrence` parses
  // with the raw cron and timezone, so an invalid one throws the library's
  // internal error instead of the BadRequestError the caller can act on.
  const cadenceTimezone = input.cadence?.timezone ?? 'UTC'
  if (input.cadence) {
    validateCron(input.cadence.cron, cadenceTimezone, minIntervalMinutesFromEnv())
  }
  const nextRunAt = input.cadence
    ? nextOccurrence(input.cadence.cron, cadenceTimezone, new Date())
    : null

  const definitionValues: NewTaskDefinition = {
    organizationId: session.organizationId,
    projectId: input.projectId,
    kind: input.kind,
    title,
    plan: {
      prompt,
      skill: skill ?? emptySkillSnapshot(),
      dataSources: null,
      goal,
      subject: input.subject ?? null,
    },
    requesterUserId: requester.userId,
    requesterEmail: requester.email,
    trigger: input.cadence ? 'schedule' : 'once',
    enabled: true,
    scheduleCron: input.cadence?.cron ?? null,
    scheduleTimezone: cadenceTimezone,
    nextRunAt,
    dueAt: input.cadence ? null : (input.dueAt ?? null),
  }

  // A cadence is a STANDING definition: nothing runs until the scheduler
  // claims it, and the requester's chat answer has to say exactly that.
  if (input.cadence) {
    const definition = await repository.insertDefinition(definitionValues)
    await recordAuditEvent({
      organizationId: session.organizationId,
      actor: { userId: session.userId, email: session.email },
      action: 'task.created',
      targetType: 'task',
      targetId: definition.id,
      metadata: { projectId: input.projectId, kind: input.kind, trigger: 'schedule' },
    })
    return { definition, run: null }
  }

  // A one-off's run IS its attempt, so definition and run are one unit. Two
  // separate inserts could commit the definition and then fail the run, leaving
  // an enabled one-off nothing will ever fire; the retry would duplicate it.
  const { definition, run } = await repository.insertDefinitionWithRun(definitionValues, {
    organizationId: session.organizationId,
    projectId: input.projectId,
    kind: input.kind,
    title,
    plan: definitionValues.plan,
    requesterUserId: requester.userId,
    requesterEmail: requester.email,
    trigger: 'delegated',
    triggeredBy: session.userId,
    status: 'queued',
    skillSnapshot: skill ?? emptySkillSnapshot(),
  })

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'task.created',
    targetType: 'task',
    targetId: run.id,
    metadata: { projectId: input.projectId, kind: input.kind, trigger: 'delegated' },
  })

  return { definition, run: await dispatchRun(definition, run, input.conversationId ?? null) }
}

/**
 * Submit a queued run and record what came back.
 *
 * Never throws: a run that could not be submitted is a `failed` row with the
 * reason on it, which is what the requester's inbox and the task list can both
 * read. Throwing would leave the caller — the chat tool, or a lifecycle effect
 * running inside a reviewer's request — to invent a second way of saying the
 * same thing.
 */
async function dispatchRun(
  definition: TaskDefinition,
  run: TaskRun,
  originConversationId: string | null,
): Promise<TaskRun> {
  try {
    // The thread the work was commissioned in. „@Piloti prüf das" belongs in the
    // conversation it was said in — that is where the person is looking, and
    // where the follow-up question will be asked. Only a delegation nobody typed
    // (a reviewer's send-back on a version filed outside any thread) needs a
    // place of its own, and then the definition's own thread is that place.
    const conversation = originConversationId ?? (await createTaskThread(definition))
    const { backendJobId, conversationId, runMessageId } = await submitAgentRun({
      organizationId: run.organizationId,
      projectId: run.projectId,
      userId: run.requesterUserId,
      ownerEmail: run.requesterEmail,
      // The run's own title („Normprüfung: …"), the same string the Aufträge
      // index shows, so the block in the thread and the card name one run alike.
      title: run.title,
      prompt: run.plan.prompt,
      skillSnapshot: run.skillSnapshot.name ? run.skillSnapshot : null,
      // Every delegated kind runs as a chat output: the work lands in a real
      // thread, which is where a draft card and a follow-up question can live.
      output: 'chat',
      dataSources: run.plan.dataSources,
      runId: run.id,
      conversationId: conversation,
    })
    return (
      (await repository.updateRun(run.id, run.organizationId, {
        status: 'running',
        backendJobId,
        conversationId,
        runMessageId,
        startedAt: new Date(),
      })) ?? run
    )
  } catch (error) {
    const detail =
      error instanceof JobSubmitSkippedError || error instanceof JobSubmitError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Unexpected error while preparing the run'
    console.error('[runs] could not submit the run for definition', definition.id, error)
    return (
      (await repository.updateRun(run.id, run.organizationId, {
        status: 'failed',
        error: detail.slice(0, 2000),
        finishedAt: new Date(),
      })) ?? run
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
