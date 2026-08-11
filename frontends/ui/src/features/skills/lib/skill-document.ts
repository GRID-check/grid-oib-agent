/**
 * Rendering a skill back into the SKILL.md document it is.
 *
 * The editor is a form — name, description, body, two switches — which is the
 * right way to author one, but it leaves the actual artefact invisible. A skill
 * IS a SKILL.md file: YAML frontmatter carrying `name`, `description` and
 * `metadata`, followed by the Markdown instructions
 * (https://agentskills.io/specification). Being able to see that document is
 * what makes the rest of the model legible — which half is always in the
 * agent's context, which half is loaded only on activation, and what the
 * reserved `grid-*` keys the switches write actually are.
 *
 * Pure and deterministic: the same skill always renders byte-for-byte the same
 * document, so the preview beside the form IS what gets stored and what an
 * agent reads. Same WYSIWYG contract the schedule snapshot keeps.
 */

/** The parts of a skill that appear in its document. */
export interface SkillDocumentInput {
  name: string
  description: string
  body: string
  metadata?: Record<string, string>
}

/** The document, split at the seam that matters for progressive disclosure. */
export interface SkillDocumentParts {
  /**
   * The frontmatter block including its `---` fences. Loaded for EVERY skill at
   * the start of every turn — this is what the agent matches a request against.
   */
  frontmatter: string
  /**
   * The Markdown instructions. Loaded ONLY when the skill is activated, so its
   * length costs nothing until then.
   */
  body: string
}

/**
 * Quote a YAML scalar only where it needs it.
 *
 * Values that could be read back as another type (`false`, `12`, `null`, `yes`)
 * or that carry YAML-significant punctuation are quoted; ordinary words are
 * left bare, because a document full of unnecessary quotes reads as generated
 * rather than as something a person could have written by hand.
 */
function yamlScalar(value: string): string {
  const needsQuotes =
    value === '' ||
    /^[\s]|[\s]$/.test(value) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(value) ||
    /^[-+]?\d+(\.\d+)?$/.test(value) ||
    /[:#{}[\],&*?|<>=!%@`"']/.test(value) ||
    value.includes('\n')
  if (!needsQuotes) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * A long description as a folded block scalar (`>-`), which is how the shipped
 * skills are written and how a 1024-character description stays readable in a
 * file. Wrapped at a comfortable width; the folding is cosmetic, since YAML
 * joins the lines back into one string on read.
 */
function foldedScalar(value: string, indent = '  ', width = 88): string {
  const words = value.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return `>-\n${lines.map((entry) => `${indent}${entry}`).join('\n')}`
}

/** The threshold past which a description is folded rather than kept inline. */
const INLINE_DESCRIPTION_MAX = 72

export function renderSkillDocumentParts({
  name,
  description,
  body,
  metadata = {},
}: SkillDocumentInput): SkillDocumentParts {
  const lines: string[] = ['---']
  lines.push(`name: ${yamlScalar(name)}`)

  const trimmedDescription = description.trim()
  lines.push(
    trimmedDescription.length > INLINE_DESCRIPTION_MAX
      ? `description: ${foldedScalar(trimmedDescription)}`
      : `description: ${yamlScalar(trimmedDescription)}`,
  )

  // Sorted, so the same skill never renders two different documents because a
  // form wrote its keys in a different order.
  const keys = Object.keys(metadata).sort()
  if (keys.length > 0) {
    lines.push('metadata:')
    for (const key of keys) {
      lines.push(`  ${key}: ${yamlScalar(metadata[key])}`)
    }
  }

  lines.push('---')

  return { frontmatter: lines.join('\n'), body: body.trim() }
}

/** The whole document, frontmatter and body, as it is stored and read. */
export function renderSkillDocument(input: SkillDocumentInput): string {
  const { frontmatter, body } = renderSkillDocumentParts(input)
  return body ? `${frontmatter}\n\n${body}\n` : `${frontmatter}\n`
}
