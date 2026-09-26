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
  JobOutput,
  NewTaskDefinition,
  TaskDefinition,
  TaskPlan,
  TaskRun,
} from '@/lib/db/schema'
import { DELEGATABLE_TASK_KINDS } from '@/lib/db/schema'
import { createTaskThread, submitAgentRun } from '@/lib/jobs/service'
import { JobSubmitError, JobSubmitSkippedError } from '@/lib/jobs/backend-client'
import { minIntervalMinutesFromEnv, nextOccurrence, validateCron } from '@/lib/jobs/schedule'
import { emptySkillSnapshot } from '@/lib/jobs/types'
import { isEmptyPlanDocuments, type PlanDocuments } from '@/lib/runs/plan-documents'
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

/**
 * What it takes to hand Piloti work in a project.
 *
 * One constant, because a second list is a second policy: commissioning a
 * research run from a chat question and delegating „@Piloti prüf das" are the
 * same act — a person spending the project's budget and adding to its record —
 * and they must never drift into two different answers to the same question.
 */
export const COMMISSION_PERMISSIONS = ['project:edit', 'project:documents:write'] as const

/**
 * What one task kind runs on.
 *
 * There is no `skill` field any more. It named a skill to resolve, freeze and
 * paste into the prompt under „Verwende dabei den folgenden Skill verbindlich
 * und vollständig" — a body in front of the model with no `use_skill` call and
 * no judgment, which is forcing however the person arrived at it. A kind that
 * wants a playbook NAMES it in its instruction, the same `/name` a person
 * types in chat, and the model decides.
 */
interface TaskEngine {
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
   * A norm check run by the general agent.
   * No skill: the run works from the regulation corpus and project files
   * with the retrieval tools it already binds.
   */
  compliance_check: {
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
   * list — NAMED, the way a person would name it in the composer, never pasted
   * in. If the run reads the name and judges the skill wrong for this project,
   * that judgment is the point; a frozen body would have removed it.
   */
  einreichcheck: {
    instruction: (goal) =>
      [
        'Prüfe die Vollständigkeit der Einreichung für dieses Projekt — /einreichcheck.',
        '',
        'Der Auftrag, wörtlich:',
        goal,
      ].join('\n'),
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
  await requireProjectAccess(session, input.projectId, [...COMMISSION_PERMISSIONS])

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
  const prompt = [engine.instruction(goal), sourceBlock(input.sourceText)]
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
      // Always empty. The column records what a job was configured with, and
      // nothing configures one any more: a kind that wants a playbook names it
      // in `prompt`. Kept rather than dropped because legacy rows hold real
      // snapshots and the pair CHECK is theirs.
      skill: emptySkillSnapshot(),
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
    skillSnapshot: emptySkillSnapshot(),
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
 * What an escalated chat question needs to become a run of its own.
 *
 * No kind and no skill: the question IS the prompt, and the deep researcher is
 * the engine. `conversationId` is the thread the person asked in — an
 * escalation always has one, which is why this never mints a thread the way a
 * reviewer's send-back does.
 */
export interface CommissionResearchInput {
  projectId: string
  conversationId: string
  /** The question as the turn restated it for the researcher. It IS the prompt. */
  question: string
  /**
   * What the commissioning turn already established with the person — the
   * clarifier's exchange, verbatim. Composed BELOW the question, so the run
   * starts where the conversation got to instead of asking it all again — and
   * handed to the worker as the clarifier result, so the approved plan in it
   * binds the planner and the writer rather than reading as context.
   */
  context?: string | null
  /** The Rahmen: the sources the run may draw on. Null keeps the worker's default. */
  dataSources?: string[] | null
  /** The Unterlagen the reader named on the plan card. */
  documents?: PlanDocuments | null
}

/** Where the commissioned run narrates itself, for the turn that commissioned it. */
export interface CommissionedResearchRun {
  runId: string
  /** The run's message in the thread, or null when it could not be minted. */
  runMessageId: string | null
  conversationId: string
  /** `queued` never survives this call: `running` when the worker took it, `failed` when it refused. */
  status: TaskRun['status']
}

/**
 * Commission a research run from a question somebody asked in a thread
 * (ADR-0062: a run is one message in the thread that commissioned it).
 *
 * ## Why an escalated question is a run at all
 *
 * It was one already, in every way except the record: minutes of work, a
 * budget, a report that outlives the turn. What it lacked was a row, so it
 * could not be listed, stopped, filed, resumed or even named — the thread held
 * a stub sentence and a job id, and nothing else knew it existed. One row fixes
 * all of that at once, because every surface already reads runs.
 *
 * ## No definition
 *
 * A standing intent is something a person stated once and expects again; a
 * question asked in passing is not that. The row therefore carries no
 * `definitionId` — the column is nullable for exactly this case — and the run
 * is its own whole story: `plan.prompt` is the question, `title` is the
 * question shortened, and the Aufträge index shows it beside the scheduled
 * ones with nothing missing but a cadence it never had.
 *
 * ## The gate is the delegation gate
 *
 * `COMMISSION_PERMISSIONS`, the same list `delegateTask` asks for. Escalating a
 * question spends the project's budget and adds to its record exactly as
 * handing over a task does, and a second, softer answer here would be a way
 * around the first one.
 *
 * Never throws for a submission that failed: the run is a `failed` row with
 * the reason, and the block in the thread says so. It DOES throw when the
 * caller may not commission at all — that is the turn's answer to change, not
 * a run to record.
 */
export async function commissionResearchRun(
  session: AuthorizedSession,
  input: CommissionResearchInput,
): Promise<CommissionedResearchRun> {
  await requireProjectAccess(session, input.projectId, [...COMMISSION_PERMISSIONS])

  const question = input.question.trim()
  if (!question) throw new UnprocessableError('A research run needs a question')
  if (question.length > TASK_GOAL_MAX_CHARS) {
    throw new UnprocessableError(`A question is at most ${TASK_GOAL_MAX_CHARS} characters`)
  }

  const context = input.context?.trim()
  const documents = input.documents ?? null
  const plan: TaskPlan = {
    prompt: context ? `${question}\n\n${CONTEXT_HEADING}\n${context}` : question,
    skill: emptySkillSnapshot(),
    dataSources: input.dataSources ?? null,
    goal: question,
    subject: null,
    ...(context ? { context } : {}),
    ...(documents && !isEmptyPlanDocuments(documents) ? { documents } : {}),
  }
  const queued = await repository.insertRun({
    organizationId: session.organizationId,
    projectId: input.projectId,
    // No definition: see above.
    definitionId: null,
    kind: 'deep-research',
    title: researchTitle(question),
    plan,
    requesterUserId: session.userId,
    requesterEmail: session.email,
    trigger: 'delegated',
    triggeredBy: session.userId,
    status: 'queued',
    skillSnapshot: emptySkillSnapshot(),
  })

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'task.created',
    targetType: 'task',
    targetId: queued.id,
    metadata: { projectId: input.projectId, kind: 'deep-research', trigger: 'delegated' },
  })

  const run = await submitQueuedRun(queued, {
    thread: () => Promise.resolve(input.conversationId),
    output: 'deep-research',
  })
  return {
    runId: run.id,
    runMessageId: run.runMessageId,
    conversationId: run.conversationId ?? input.conversationId,
    status: run.status,
  }
}

/**
 * The question as a run's title: its first sentence, bounded.
 *
 * A title is read in a list, so it is the shortest thing that still names the
 * work. The question's own first sentence is that — no rewrite, because a
 * rewritten title is a second account of what was asked.
 */
/** What the composed prompt calls the block of things already settled. */
const CONTEXT_HEADING = 'Was in der Unterhaltung bereits geklärt wurde:'

function researchTitle(question: string): string {
  const firstSentence = question.split(/(?<=[.?!])\s/)[0]?.trim() || question
  const shown = firstSentence.length > 0 ? firstSentence : question
  return shown.length > 200 ? `${shown.slice(0, 199).trimEnd()}…` : shown
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
  // The thread the work was commissioned in. „@Piloti prüf das" belongs in the
  // conversation it was said in — that is where the person is looking, and
  // where the follow-up question will be asked. Only a delegation nobody typed
  // (a reviewer's send-back on a version filed outside any thread) needs a
  // place of its own, and then the definition's own thread is that place.
  return submitQueuedRun(run, {
    thread: () => (originConversationId ? Promise.resolve(originConversationId) : createTaskThread(definition)),
    // Every delegated kind runs as a chat output: the work lands in a real
    // thread, which is where a draft card and a follow-up question can live.
    output: 'chat',
  })
}

/** How a queued run reaches the worker: which thread it narrates in, and what runs it. */
interface DispatchTarget {
  /** The conversation the run's block goes in, resolved only once the submit begins. */
  thread: () => Promise<string | null>
  output: JobOutput
}

/**
 * Submit one queued run and record what came back — the half both callers share.
 *
 * Never throws, for the reason above: the failure has to survive as a row.
 */
async function submitQueuedRun(run: TaskRun, target: DispatchTarget): Promise<TaskRun> {
  let submitted: Awaited<ReturnType<typeof submitAgentRun>>
  try {
    const conversation = await target.thread()
    submitted = await submitAgentRun({
      organizationId: run.organizationId,
      projectId: run.projectId,
      userId: run.requesterUserId,
      ownerEmail: run.requesterEmail,
      // The run's own title („Normprüfung: …"), the same string the Aufträge
      // index shows, so the block in the thread and the card name one run alike.
      title: run.title,
      prompt: run.plan.prompt,
      skillSnapshot: run.skillSnapshot.name ? run.skillSnapshot : null,
      output: target.output,
      dataSources: run.plan.dataSources,
      runId: run.id,
      conversationId: conversation,
      clarifierResult: run.plan.context ?? null,
      documents: run.plan.documents ?? null,
    })
  } catch (error) {
    const detail =
      error instanceof JobSubmitSkippedError || error instanceof JobSubmitError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Unexpected error while preparing the run'
    console.error('[runs] could not submit run', run.id, error)
    return recordRun(run, { status: 'failed', error: detail.slice(0, 2000), finishedAt: new Date() })
  }
  // From here the job exists on the backend. A failure to record that is not
  // a failed run (#723): marking it `failed` told the reader the work had not
  // happened while it ran on, and during a database outage the `failed` write
  // threw as well. The worker's run ledger addresses the run by its id, so the
  // row catches up when the database is back.
  const { backendJobId, conversationId, runMessageId } = submitted
  return recordRun(run, { status: 'running', backendJobId, conversationId, runMessageId, startedAt: new Date() })
}

/**
 * Store what happened to a run, and return the row as it now is.
 *
 * Never throws: when the write fails, the run as this process knows it is
 * returned with the patch applied, and the failure is logged with the run's
 * id beside what could not be written.
 */
async function recordRun(run: TaskRun, patch: Partial<TaskRun>): Promise<TaskRun> {
  try {
    return (await repository.updateRun(run.id, run.organizationId, patch)) ?? run
  } catch (error) {
    console.error('[runs] could not record run', run.id, patch.status, patch.backendJobId ?? '', error)
    return { ...run, ...patch }
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
