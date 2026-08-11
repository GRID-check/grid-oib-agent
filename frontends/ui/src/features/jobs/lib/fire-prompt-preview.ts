/**
 * Client mirror of the server's fire-prompt builder (`buildFirePrompt`,
 * `@/lib/jobs/service` — `server-only`, so the UI cannot import it).
 *
 * The job builder's "What the agent receives" pane must be WYSIWYG-honest:
 * this text is what actually gets submitted at fire time. Both sides must
 * produce byte-identical output, so the template below is transcribed from
 * service.ts and pinned by `fire-prompt-preview.spec.ts` against the server
 * module (the spec runs in the node environment and imports the real service).
 * If one side changes, the pinned spec fails until the other follows.
 *
 * A job is a PROMPT; the skill is optional. With no skill attached the output
 * is the trimmed prompt and nothing else — no `Skill:`/`Beschreibung:` block
 * and no dangling fences.
 */

import type { SkillSnapshot } from '@/adapters/api/skills-client'

/** What the builder needs: the job's prompt and its attached skill, if any. */
export interface FirePromptInput {
  prompt: string
  skill: SkillSnapshot | null
}

/** The deterministic prompt a run is submitted with. */
export function buildFirePromptPreview({ prompt, skill }: FirePromptInput): string {
  const text = prompt.trim()
  if (!skill) return text
  return [
    text,
    '',
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
