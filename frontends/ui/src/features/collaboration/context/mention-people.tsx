'use client'

/**
 * Who the people mentioned in this thread ARE.
 *
 * A rendered mention carries only what the server stored with the message —
 * `{ targetId, display }` — because that is what decided who was notified, and the
 * two must not be able to disagree. But a pill worth pressing needs the person
 * behind the id: their email, their avatar, whether they can even read this
 * thread.
 *
 * Provided by context rather than threaded as props, for one reason: the only
 * component that needs it (`MentionText`) sits three layers below the only
 * component that has it (`ChatArea` → `MessageRenderer` → `UserMessage` →
 * `MentionText`), and every layer in between would have to carry a prop it has no
 * use for.
 *
 * **Absence is a supported state.** Disabled, or with no provider at all — a
 * private thread, a unit test, the report renderer — `useMentionPerson` returns
 * null and a mention stays exactly the quiet chip it is today. Collaboration
 * furniture does not appear in a conversation that has none (spec NF-8).
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { JSX } from 'react'

import { AGENT_MENTION_ID } from '@/lib/mentions/types'
import type { PersonPeekPerson } from '../components/PersonPeek'

/** What a mention pill can say about its target once resolved. */
export interface ResolvedMentionPerson {
  person: PersonPeekPerson
  isAgent: boolean
  isYou: boolean
  /** Whether they can read this conversation, or undefined when unknown. */
  isParticipant?: boolean
}

interface MentionPeopleValue {
  resolve: (targetId: string) => ResolvedMentionPerson | null
}

const MentionPeopleContext = createContext<MentionPeopleValue | null>(null)

export interface MentionPeopleProviderProps {
  /** Everyone who can reach the conversation (the shared-thread roster). */
  participants: readonly PersonPeekPerson[]
  /** The reader, so a mention of them is marked as such. */
  currentUserId?: string | null
  /** How the assistant is named in this locale — `mentions.picker.agentName`. */
  agentName: string
  /**
   * Off in a conversation with no collaboration (spec NF-8). A prop rather than a
   * conditional mount, so the caller's JSX has one shape: disabled resolves
   * nothing, which is byte-for-byte the no-provider behaviour.
   */
  enabled?: boolean
  children: ReactNode
}

export function MentionPeopleProvider({
  participants,
  currentUserId,
  agentName,
  enabled = true,
  children,
}: MentionPeopleProviderProps): JSX.Element {
  const value = useMemo<MentionPeopleValue | null>(() => {
    if (!enabled) return null

    const byId = new Map(participants.map((person) => [person.userId, person]))
    return {
      resolve: (targetId) => {
        if (targetId === AGENT_MENTION_ID) {
          return {
            person: { userId: AGENT_MENTION_ID, name: agentName },
            isAgent: true,
            isYou: false,
          }
        }

        // Someone who has since lost access, or was never in the roster. The pill
        // stays plain: the display name travels with the message, but claiming
        // anything about their access would be a guess.
        const person = byId.get(targetId)
        if (!person) return null

        return {
          person,
          isAgent: false,
          isYou: Boolean(currentUserId) && targetId === currentUserId,
          isParticipant: true,
        }
      },
    }
  }, [enabled, participants, currentUserId, agentName])

  return <MentionPeopleContext.Provider value={value}>{children}</MentionPeopleContext.Provider>
}

/**
 * Resolve one mention target. Null when the provider is absent or disabled, or the
 * person cannot be placed — all three meaning "render the plain chip".
 */
export function useMentionPerson(targetId: string): ResolvedMentionPerson | null {
  const context = useContext(MentionPeopleContext)
  return context ? context.resolve(targetId) : null
}
