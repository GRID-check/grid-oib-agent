/**
 * The id a turn's answer is stored under, the same on both tiers.
 *
 * When the socket is gone at the moment an answer finishes, the backend
 * persists it itself, under `deterministic_assistant_message_id` in
 * `frontends/aiq_api/src/aiq_api/websocket_reconnect.py`:
 * uuid5(NAMESPACE_URL, `grid:assistant:<conversation>:<parent>`), where the
 * parent is the id the client sent the question under (its `wsParentId`). A
 * client that comes back and replays the finished turn writes the same answer
 * again. Under the same id, the second write collides on `messages.id` and
 * no-ops, and the finished-answer recovery recognises the answer it already
 * has. Under a fresh uuid it was a second copy of the answer.
 */

import { v5 as uuidv5 } from 'uuid'

/** RFC 4122's URL namespace, Python's `uuid.NAMESPACE_URL`. */
const NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'

export function turnAnswerId(conversationId: string, wsParentId: string): string {
  return uuidv5(`grid:assistant:${conversationId}:${wsParentId}`, NAMESPACE_URL)
}
