'use client'

/**
 * The Outlook archive this tab is sending (ADR-0085), kept outside React.
 *
 * A send of twenty gigabytes takes hours, and the person goes on working
 * meanwhile: to the chat, to another project. Held in a component, the send
 * would end with the first soft navigation that unmounted it. Held here, it ends
 * only when the tab does, and the browser asks before that happens
 * (`beforeunload`). Any import dialog that opens again reads where it stands.
 *
 * One send per tab: the server allows one open import per person and project,
 * and three parts in flight already fill a line.
 *
 * The file a send started from is remembered in this browser by name, size and
 * modification time, so that resuming with a file that only looks the same (a
 * new export under the old name, a `.pst` Outlook wrote to meanwhile) is refused
 * here instead of mixing two archives' parts into one unreadable file.
 */

import { sendMailArchive, type SendProgress } from '@/lib/mail-import/client'
import type { MailImportUploadPlan } from '@/lib/mail-import/types'

export interface MailImportSend {
  projectId: string
  importId: string
  filename: string
  sentBytes: number
  totalBytes: number
  phase: SendProgress['phase']
}

export interface MailImportSendFailure {
  projectId: string
  /** `start` when the server refused to begin (or resume) the send, `send` when it broke off after. */
  stage: 'start' | 'send'
  error: unknown
}

export interface MailImportSendState {
  send: MailImportSend | null
  failure: MailImportSendFailure | null
}

/** This tab is already sending an archive (of another project); a second send waits for it. */
export class MailImportSendBusyError extends Error {
  constructor() {
    super('This tab is already sending an archive.')
    this.name = 'MailImportSendBusyError'
  }
}

/** Whether this tab is sending an archive, of any project. */
export function isMailImportSending(): boolean {
  return controller !== null
}

const IDLE: MailImportSendState = { send: null, failure: null }

let state: MailImportSendState = IDLE
let controller: AbortController | null = null
const listeners = new Set<() => void>()

function set(next: MailImportSendState): void {
  state = next
  for (const listener of listeners) listener()
}

export function subscribeMailImportSend(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function mailImportSendSnapshot(): MailImportSendState {
  return state
}

export function mailImportSendServerSnapshot(): MailImportSendState {
  return IDLE
}

function warnBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault()
  // Older browsers show the prompt only when this is set.
  event.returnValue = ''
}

/**
 * Send `file` by `plan`, to the end or until it fails or is cancelled. Settles
 * either way; a failure is kept in the state for the dialog to word.
 */
export async function runMailImportSend(projectId: string, plan: MailImportUploadPlan, file: File): Promise<void> {
  if (controller) throw new MailImportSendBusyError()
  const abort = new AbortController()
  controller = abort
  rememberFile(plan.import.id, file)
  const base = { projectId, importId: plan.import.id, filename: file.name }
  set({ send: { ...base, sentBytes: 0, totalBytes: file.size, phase: 'sending' }, failure: null })
  window.addEventListener('beforeunload', warnBeforeUnload)
  let failure: MailImportSendFailure | null = null
  try {
    await sendMailArchive(projectId, plan, file, (progress) => set({ send: { ...base, ...progress }, failure: null }), abort.signal)
    forgetFile(plan.import.id)
  } catch (error) {
    if (!abort.signal.aborted) failure = { projectId, stage: 'send', error }
  } finally {
    window.removeEventListener('beforeunload', warnBeforeUnload)
    controller = null
    set({ send: null, failure })
  }
}

/** Stop the send of `importId` when this tab is the one sending it. */
export function abortMailImportSend(importId: string): void {
  if (state.send?.importId === importId) controller?.abort()
}

/** Record a failure that happened before any send began (a refused start). */
export function failMailImportSend(projectId: string, error: unknown): void {
  set({ send: state.send, failure: { projectId, stage: 'start', error } })
}

export function clearMailImportSendFailure(): void {
  if (state.failure) set({ send: state.send, failure: null })
}

const FILE_KEY = 'piloti.mailImport.file.'

function fingerprint(file: File): string {
  return `${file.size}:${file.lastModified}`
}

function rememberFile(importId: string, file: File): void {
  try {
    window.localStorage.setItem(FILE_KEY + importId, fingerprint(file))
  } catch {
    // Storage blocked (a private window): resuming then checks name and size only.
  }
}

function forgetFile(importId: string): void {
  try {
    window.localStorage.removeItem(FILE_KEY + importId)
  } catch {
    // As above.
  }
}

/** False when this browser started `importId` from a different file; true when it matches or it cannot tell. */
export function isSameMailImportFile(importId: string, file: File): boolean {
  try {
    const known = window.localStorage.getItem(FILE_KEY + importId)
    return known === null || known === fingerprint(file)
  } catch {
    return true
  }
}
