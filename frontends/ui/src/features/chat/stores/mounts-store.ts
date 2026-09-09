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
import {
  mountsClient,
  MountRefusedError,
  type Mount,
  type MountRefusalCode,
} from '@/adapters/api'
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

/** A mount the office refused, in the facts its sentence needs. */
export interface MountRefusal {
  code: MountRefusalCode
  /** Absent when the refusal never named a project. */
  projectName?: string
  /** Only on `cap`, and only when the server stated it. */
  cap?: number
  /**
   * Only on `would_exclude`: the participants who would lose this conversation.
   * Empty is possible — the server names who it can — and the sentence has a
   * form for that, so the list is not a precondition for the notice.
   */
  excluded?: string[]
  /** Set when a SAMMLUNG is what was refused, so the sentence can name it. */
  setName?: string
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
  /**
   * Names of the projects the last mounted Sammlung left out, empty when none.
   *
   * It outlives the panel that raised it, unlike {@link mountRefusal}: the
   * refusal is also drawn inline in the tree, at the row that was pressed, so
   * dismissing the tree dismisses a sentence the reader has already read. This
   * one is drawn ONLY in the transcript, and clearing it on close would mean
   * the reader who mounted a Sammlung and shut the tree never learns that two
   * of its projects stayed out. It is replaced by the next mount attempt, and
   * dropped with the conversation.
   */
  mountSkipped: string[]
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
  /**
   * Show this conversation a whole **Sammlung** (spec GR-2).
   *
   * One call, one cap check, one refusal — decided over the whole set before
   * anything is written — and then the SAME notices a person's five clicks
   * would have produced, one per project, each undoable on its own. A set is a
   * gesture, not a unit of scope: once mounted, the conversation reads five
   * projects and knows nothing about how they arrived.
   */
  mountProjectSet: (
    conversationId: string,
    projectSetId: string,
    /** For the REFUSAL's sentence only — a success is named by the server. */
    setName?: string
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
  mountSkipped: [] as string[],
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
const refusalOf = (error: unknown, projectName?: string, setName?: string): MountRefusal => {
  if (error instanceof MountRefusedError) {
    return {
      code: error.code,
      projectName,
      // The server's own word for the set beats the caller's, which is only
      // what the row said before the call.
      ...(error.set?.name ?? setName ? { setName: error.set?.name ?? setName } : {}),
      ...(error.cap !== undefined ? { cap: error.cap } : {}),
      ...(error.excluded ? { excluded: error.excluded } : {}),
    }
  }
  return { code: 'unavailable', projectName, ...(setName ? { setName } : {}) }
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
        mountSkipped: [],
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

  mountProjectSet: async (conversationId, projectSetId, setName) => {
    if (!conversationId || !projectSetId) return false
    // `mountsPending` is keyed by project id everywhere else; a Sammlung has no
    // project id of its own, so its OWN id stands in. Every consumer asks the
    // same question of that list — "is this row busy" — and a set's row is
    // keyed by the set, so the two never collide.
    set(
      {
        mountsConversationId: conversationId,
        mountsPending: [...get().mountsPending, projectSetId],
        mountRefusal: null,
        mountSkipped: [],
      },
      false,
      'mountProjectSet/start'
    )

    try {
      const outcome = await mountsClient.mountSet(conversationId, projectSetId)
      const state = get()
      let mounts = state.mounts
      const notices = [...state.mountNotices]
      for (const mount of outcome.mounts) {
        // A member already in view is not a second mount and gets no second
        // notice — the same idempotence rule one project already follows.
        if (!mounts.some((entry) => entry.projectId === mount.projectId)) {
          notices.push({
            id: noticeId(mount.projectId),
            projectId: mount.projectId,
            projectName: mount.projectName,
            by: 'user',
          })
        }
        mounts = withMount(mounts, mount)
      }

      set(
        {
          mounts,
          mountNotices: notices,
          mountsPending: state.mountsPending.filter((id) => id !== projectSetId),
          // Skipped members are not a failure: the rest of the set IS in view,
          // and a throw here would have discarded the half that worked.
          mountSkipped: outcome.skipped.map((entry) => entry.projectName),
        },
        false,
        'mountProjectSet/done'
      )
      return true
    } catch (error) {
      set(
        {
          mountsPending: get().mountsPending.filter((id) => id !== projectSetId),
          mountRefusal: refusalOf(error, undefined, setName),
        },
        false,
        'mountProjectSet/refused'
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
            ...(event.excluded ? { excluded: event.excluded } : {}),
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

  // The refusal only. `mountSkipped` is not dismissed here — see its own note:
  // it is drawn in the transcript and nowhere else, so the gesture that closes
  // the tree is not a gesture that has read it.
  clearMountRefusal: () => set({ mountRefusal: null }, false, 'clearMountRefusal'),

  resetMounts: () => set({ ...initialMountsState }, false, 'resetMounts'),
})

/** Whether one more project may be shown. Unknown cap ⇒ not yet. */
export const canMountMore = (state: {
  mounts: readonly Mount[]
  mountCap: number
}): boolean => state.mountCap > 0 && state.mounts.length < state.mountCap
