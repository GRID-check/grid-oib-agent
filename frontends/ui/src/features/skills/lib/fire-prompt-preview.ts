/**
 * Client mirror of the server's fire-prompt builder (`buildFirePrompt`,
 * `@/lib/skills/service` — `server-only`, so the UI cannot import it).
 *
 * The schedule editor's "What the agent receives" pane must be WYSIWYG-honest:
 * this text is what actually gets submitted at fire time. Both sides must
 * produce byte-identical output, so the template below is transcribed from
 * service.ts and pinned by `fire-prompt-preview.spec.ts` against the server
 * module (the spec runs in the node environment and imports the real service).
 * If one side changes, the pinned spec fails until the other follows.
 */

import type { SkillSnapshot } from '@/adapters/api/skills-client'

/** The deterministic prompt embedding the snapshot's full body. */
export function buildFirePromptPreview(snapshot: SkillSnapshot): string {
  return [
    'Führe den folgenden Skill verbindlich und vollständig aus.',
    '',
    '---',
    '',
    `Skill: ${snapshot.name}`,
    `Beschreibung: ${snapshot.description}`,
    '',
    snapshot.body,
    '---',
  ].join('\n')
}