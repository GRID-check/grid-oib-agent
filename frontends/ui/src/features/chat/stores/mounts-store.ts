/**
 * ONE mounts state — the projects this conversation may read (ADR-0054).
 *
 * The scope chip's count, the "Im Blick" row, the Wissensbasis tree's project
 * level and the notices in the transcript are four renderings of this slice and
 * of nothing else. That is the design's central promise (`workspace-chat-ui.md`
 * §3): every mount produces three simultaneous signals, and the only way to
 * guarantee it is that there is nothing else for them to disagree about.
 *
 * ## The server owns the cap, and this owns nothing
 *
 * `cap` is read from `GET …/mounts`, never declared here. The cap has exactly
 * one implementation (the mounts service) and a client constant would be a
 * second one that disagreed the first time it moved. The same rule applies to
 * refusals: the BFF re-authorizes `project:chat` on every mount, so this slice
 * states an intent and reports what came back.
 *
 * ## Refusals are stored as CODES, not sentences
 *
 * A store is locale-free. What is kept is `{ code, projectName }`; the words
 * are the component's job in whichever locale is reading. A store that held
 * German would render German to an English reader, which is the defect
 * `turn-events.ts` documents on the live line.
 *
 * ## Notices are a history, not a status
 *
 * `mountNotices` only ever grows within a conversation. Undoing a mount does
 * not delete its notice — the mount HAPPENED and the transcript is a record —
 * it flips `undone`, and the sentence changes. Switching conversations resets
 * the whole slice, because a notice belongs to the thread it landed in.
 */

import type { StateCreator } from 'zustand'
import { mountsClient, MountRefusedError, type Mount } from '@/adapters/api'
import type { MountEvent } from '../lib/mount-events'
import type { ChatStore } from '../types'

/** How a project came to be in view — the notice's sentence turns on it. */
export type MountReason = 'agent' | 'user' | 'fromProject'

/** One notice in the transcript. Keyed so React can tell two of them apart. */
export interface MountNoticeEntry {
  id: string
  projectId: string
  projectName: string
  by: MountReason
  /** The reader took it back out. The notice stays and says so. */
  undone?: boolean
  /** The undo itself failed — the control stays, a retry is one press away. */
  undoFailed?: boolean
}

/** A mount the office refused, in the two facts a sentence needs. */
export interface MountRefusal {
  code: 'cap' | 'no_access' | 'not_found' | 'unavailable'
  /** Absent when the refusal never named a project. */
  projectName?: string
  /** Only on `cap`, and only when the server stated it. */
  cap?: number
}

export type MountsSlice = {
  /** Projects in view, in mount order. Empty in a project chat, always. */
  mounts: Mount[]
  /**
   * How many projects one conversation may read at once, as the SERVER stated
   * it. `0` until the first list lands — which is why `canMountMore` is a
   * function of `mountsLoaded` and not of this number alone.
   */
  mountCap: number
  /** Which conversation the list above belongs to. Null before the first load. */
  mountsConversationId: string | null
  /** True while the list is being fetched — the tree shows skeleton rows. */
  mountsLoading: boolean
  /** Project ids whose mount or unmount is in flight. */
  mountsPending: string[]
  /** The last refusal, until something clears it. */
  mountRefusal: MountRefusal | null
  /** Every mount this conversation has seen, in the order it happened. */
  mountNotices: MountNoticeEntry[]

  /** Fetch the mounts and the cap for one conversation. */
  loadMounts: (conversationId: string) => Promise<void>
  /**
   * Show this conversation one more project. Returns whether it worked, so a
   * caller that has its own next step (the picker, the `?mount=` consumer) can
   * branch on the outcome without reading the store back.
   */
  mountProject: (
    conversationId: string,
    projectId: string,
    /** For the REFUSAL's sentence only — a success is named by the server. */
    projectName?: string,
    by?: MountReason
  ) => Promise<boolean>
  /** Take a project back out of view. `noticeId` marks its notice undone. */
  unmountProject: (
    conversationId: string,
    projectId: string,
    noticeId?: string
  ) => Promise<boolean>
  /** Apply what the agent's `open_project` reported mid-turn. */
  applyMountEvent: (event: MountEvent) => void
  /** The reader has seen the refusal. */
  clearMountRefusal: () => void
  /** Leaving the conversation, or the surface. */
  resetMounts: () => void
}

export const initialMountsState = {
  mounts: [] as Mount[],
  mountCap: 0,
  mountsConversationId: null as string | null,
  mountsLoading: false,
  mountsPending: [] as string[],
  mountRefusal: null as MountRefusal | null,
  mountNotices: [] as MountNoticeEntry[],
}

/** Ids only, so a chip that is already in view never doubles. */
const withMount = (mounts: readonly Mount[], mount: Mount): Mount[] =>
  mounts.some((entry) => entry.projectId === mount.projectId)
    ? mounts.map((entry) => (entry.projectId === mount.projectId ? mount : entry))
    : [...mounts, mount]

const noticeId = (projectId: string): string =>
  `mount:${projectId}:${Date.now().toString(36)}`

/**
 * The refusal a thrown error states.
 *
 * Anything that is not a {@link MountRefusedError} is `unavailable`: a network
 * failure and a 500 are the same fact to the reader — it did not happen, and it
 * was not their doing.
 */
const refusalOf = (error: unknown, projectName?: string): MountRefusal => {
  if (error instanceof MountRefusedError) {
    return {
      code: error.code,
      projectName,
      ...(error.cap !== undefined ? { cap: error.cap } : {}),
    }
  }
  return { code: 'unavailable', projectName }
}

export const createMountsSlice: StateCreator<
  ChatStore,
  [['zustand/devtools', never]],
  [],
  MountsSlice
> = (set, get) => ({
  ...initialMountsState,

  loadMounts: async (conversationId: string) => {
    if (!conversationId) return
    // A write is in flight for THIS conversation: the list would be a snapshot
    // taken beside it, and whichever landed last would win. That race is real
    // and reachable — `?mount=` creates the conversation and mounts into it, and
    // the surface asks for the list the moment that conversation exists. The
    // write updates the same state when it resolves, so skipping here loses
    // nothing.
    if (
      get().mountsConversationId === conversationId &&
      get().mountsPending.length > 0
    ) {
      return
    }
    // A conversation switch drops the previous thread's mounts BEFORE the fetch
    // rather than after it: a stale chip standing over a new conversation is a
    // claim about what that conversation may read, and it would be wrong.
    if (get().mountsConversationId !== conversationId) {
      set(
        { ...initialMountsState, mountsConversationId: conversationId, mountsLoading: true },
        false,
        'loadMounts/switch'
      )
    } else {
      set({ mountsLoading: true }, false, 'loadMounts/start')
    }

    try {
      const { mounts, cap } = await mountsClient.list(conversationId)
      // The conversation may have moved on while this was in flight.
      if (get().mountsConversationId !== conversationId) return
      set({ mounts, mountCap: cap, mountsLoading: false }, false, 'loadMounts/done')
    } catch {
      if (get().mountsConversationId !== conversationId) return
      // No refusal is raised for a failed LIST: the reader asked for nothing,
      // and a sentence about a fetch they did not start is noise. The tree
      // simply shows what it knows, which is nothing.
      set({ mountsLoading: false }, false, 'loadMounts/failed')
    }
  },

  mountProject: async (conversationId, projectId, projectName, by = 'user') => {
    if (!conversationId || !projectId) return false
    set(
      {
        mountsConversationId: conversationId,
        mountsPending: [...get().mountsPending, projectId],
        mountRefusal: null,
      },
      false,
      'mountProject/start'
    )

    try {
      const mount = await mountsClient.mount(conversationId, projectId)
      const state = get()
      const already = state.mounts.some((entry) => entry.projectId === mount.projectId)
      set(
        {
          mounts: withMount(state.mounts, mount),
          mountsPending: state.mountsPending.filter((id) => id !== projectId),
          // Re-mounting an already-mounted project is idempotent by contract,
          // so it is not a second event and gets no second notice.
          mountNotices: already
            ? state.mountNotices
            : [
                ...state.mountNotices,
                {
                  id: noticeId(mount.projectId),
                  projectId: mount.projectId,
                  projectName: mount.projectName,
                  by,
                },
              ],
        },
        false,
        'mountProject/done'
      )
      return true
    } catch (error) {
      set(
        {
          mountsPending: get().mountsPending.filter((id) => id !== projectId),
          mountRefusal: refusalOf(error, projectName),
        },
        false,
        'mountProject/refused'
      )
      return false
    }
  },

  unmountProject: async (conversationId, projectId, entryId) => {
    if (!conversationId || !projectId) return false
    set(
      { mountsPending: [...get().mountsPending, projectId] },
      false,
      'unmountProject/start'
    )

    try {
      await mountsClient.unmount(conversationId, projectId)
      const state = get()
      set(
        {
          mounts: state.mounts.filter((entry) => entry.projectId !== projectId),
          mountsPending: state.mountsPending.filter((id) => id !== projectId),
          // The notice STAYS. The mount happened, and a transcript that edits
          // its own history is not a record of anything.
          mountNotices: state.mountNotices.map((entry) =>
            entry.id === entryId || (!entryId && entry.projectId === projectId)
              ? { ...entry, undone: true, undoFailed: false }
              : entry
          ),
        },
        false,
        'unmountProject/done'
      )
      return true
    } catch {
      const state = get()
      set(
        {
          mountsPending: state.mountsPending.filter((id) => id !== projectId),
          // The chip does NOT vanish: it is still in view, because the server
          // still says so. The notice carries the failure so the control stays.
          mountNotices: state.mountNotices.map((entry) =>
            entry.id === entryId || (!entryId && entry.projectId === projectId)
              ? { ...entry, undoFailed: true }
              : entry
          ),
        },
        false,
        'unmountProject/failed'
      )
      return false
    }
  },

  applyMountEvent: (event) => {
    const state = get()
    if (event.status === 'refused') {
      set(
        {
          mountRefusal: {
            code: event.code,
            ...(event.cap !== undefined ? { cap: event.cap } : {}),
          },
        },
        false,
        'applyMountEvent/refused'
      )
      return
    }

    if (state.mounts.some((entry) => entry.projectId === event.projectId)) return
    set(
      {
        mounts: withMount(state.mounts, {
          projectId: event.projectId,
          projectName: event.projectName,
          mountedBy: 'agent',
          mountedAt: new Date().toISOString(),
        }),
        mountNotices: [
          ...state.mountNotices,
          {
            id: noticeId(event.projectId),
            projectId: event.projectId,
            projectName: event.projectName,
            by: 'agent',
          },
        ],
      },
      false,
      'applyMountEvent/mounted'
    )
  },

  clearMountRefusal: () => set({ mountRefusal: null }, false, 'clearMountRefusal'),

  resetMounts: () => set({ ...initialMountsState }, false, 'resetMounts'),
})

/** Whether one more project may be shown. Unknown cap ⇒ not yet. */
export const canMountMore = (state: {
  mounts: readonly Mount[]
  mountCap: number
}): boolean => state.mountCap > 0 && state.mounts.length < state.mountCap
