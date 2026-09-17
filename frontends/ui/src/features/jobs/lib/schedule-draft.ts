/**
 * A schedule the wizard should open pre-filled.
 *
 * The one way a task becomes a schedule. „Das hat funktioniert — mach das jeden
 * Montag" is the highest-confidence moment in the whole section: the person has
 * just read a result they liked, and the cost of turning it into a standing
 * instruction should be one click from there, not a walk to another tab and a
 * retyped prompt.
 *
 * Deliberately only the two fields a person WROTE. A task's frozen plan carries
 * the compiled prompt — skill body included — and the wire projection does not
 * ship it (`lib/tasks/list-projection.ts` says why). What crosses is the title
 * and the requester's own sentence, which is what they would have typed into
 * the wizard anyway.
 */
export interface ScheduleDraft {
  name: string
  prompt: string
}
