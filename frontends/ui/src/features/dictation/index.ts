/**
 * Voice dictation for the chat composer: the facade. The composer imports the
 * button and the insertion rule from here and nothing else; recording,
 * support detection and the call to `/api/dictation` stay inside.
 * `docs/architecture/voice-dictation.md` has the design and its open questions.
 */

export {
  DictationButton,
  DictationControl,
  type DictationButtonProps,
  type DictationControlProps,
} from './components/DictationButton'
export type { DictationState } from './hooks/use-dictation'
export { insertTranscript, type ComposerCaret, type InsertedTranscript } from './lib/insert-transcript'
