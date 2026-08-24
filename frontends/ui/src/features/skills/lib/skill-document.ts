/**
 * Rendering a skill back into the SKILL.md document it is.
 *
 * The editor is a form — name, description, body, the reserved-metadata
 * switches — which is the right way to author one, but it leaves the actual
 * artefact invisible. A skill
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

/* ---------------------------------------------------------------------------
 * The other direction: reading a hand-written SKILL.md back into the fields.
 *
 * This is what lets the editor's advanced section be an EDITOR rather than a
 * viewer — paste a SKILL.md from anywhere and the form fills itself in. It is
 * deliberately a small, total parser rather than a YAML library: the document
 * shapes it has to accept are the ones `renderSkillDocumentParts` emits plus
 * what a person plausibly types by hand, and a full YAML engine would happily
 * accept nested structures this product has nowhere to put.
 *
 * Every failure is a named reason, never an exception — the section reports it
 * beside the text and applies nothing.
 * ------------------------------------------------------------------------ */

export type SkillDocumentParseError =
  | 'missing-frontmatter'
  | 'unterminated-frontmatter'
  | 'malformed-frontmatter'
  | 'missing-name'
  | 'missing-description'

export interface ParsedSkillDocument {
  name: string
  description: string
  body: string
  metadata: Record<string, string>
  /**
   * Frontmatter keys this product has nowhere to store (`license`,
   * `allowed-tools`, …). Reported rather than silently dropped: a skill pasted
   * from elsewhere often carries them, and losing them without a word is how an
   * author ends up believing they were saved.
   */
  ignoredKeys: string[]
}

export type SkillDocumentParseResult =
  | { ok: true; value: ParsedSkillDocument }
  | { ok: false; error: SkillDocumentParseError }

/** The three frontmatter keys the editor round-trips. */
const KNOWN_KEYS = new Set(['name', 'description', 'metadata'])

/** `key:` at the start of a line, with everything after it as the raw value. */
const KEY_LINE = /^([A-Za-z0-9][A-Za-z0-9_.-]*):[ \t]?(.*)$/
/** The same, indented — a member of the `metadata:` mapping. */
const NESTED_KEY_LINE = /^[ \t]+([A-Za-z0-9][A-Za-z0-9_.-]*):[ \t]?(.*)$/

function unquote(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/** Is this line inside a block scalar, i.e. indented or blank? */
function isBlockContinuation(line: string): boolean {
  return line.trim() === '' || /^[ \t]/.test(line)
}

/**
 * Collect the indented lines of a `>`/`|` block scalar.
 *
 * Folded (`>`) joins them with spaces, literal (`|`) with newlines — the two
 * meanings YAML gives the indicators, and the reason the renderer's `>-` output
 * survives a round trip as one string rather than as wrapped lines.
 */
function readBlockScalar(
  lines: string[],
  start: number,
  folded: boolean,
): { value: string; next: number } {
  const collected: string[] = []
  let index = start
  while (index < lines.length && isBlockContinuation(lines[index])) {
    collected.push(lines[index].trim())
    index += 1
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
  return { value: folded ? collected.join(' ').trim() : collected.join('\n'), next: index }
}

export function parseSkillDocument(raw: string): SkillDocumentParseResult {
  const lines = raw.replace(/^﻿/, '').split(/\r?\n/)

  let cursor = 0
  while (cursor < lines.length && lines[cursor].trim() === '') cursor += 1
  if (cursor >= lines.length || lines[cursor].trim() !== '---') {
    return { ok: false, error: 'missing-frontmatter' }
  }
  cursor += 1

  const open = cursor
  let close = -1
  for (let index = open; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      close = index
      break
    }
  }
  if (close === -1) return { ok: false, error: 'unterminated-frontmatter' }

  const frontmatter = lines.slice(open, close)
  const scalars: Record<string, string> = {}
  const metadata: Record<string, string> = {}
  const ignoredKeys: string[] = []

  let index = 0
  while (index < frontmatter.length) {
    const line = frontmatter[index]
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      index += 1
      continue
    }
    const match = KEY_LINE.exec(line)
    // Anything that is neither a comment nor a top-level `key:` at this point
    // is an indentation we do not understand — a nested mapping, a sequence, a
    // stray continuation. Refuse rather than guess: half-applying a document is
    // worse than applying none of it.
    if (!match) return { ok: false, error: 'malformed-frontmatter' }

    const [, key, rest] = match
    index += 1

    if (key === 'metadata' && rest.trim() === '') {
      while (index < frontmatter.length) {
        const nested = frontmatter[index]
        if (nested.trim() === '') {
          index += 1
          continue
        }
        const nestedMatch = NESTED_KEY_LINE.exec(nested)
        if (!nestedMatch) break
        metadata[nestedMatch[1]] = unquote(nestedMatch[2])
        index += 1
      }
      continue
    }

    let value: string
    const indicator = rest.trim()
    if (indicator.startsWith('>') || indicator.startsWith('|')) {
      const block = readBlockScalar(frontmatter, index, indicator.startsWith('>'))
      value = block.value
      index = block.next
    } else {
      value = unquote(rest)
    }

    if (KNOWN_KEYS.has(key)) scalars[key] = value
    else if (!ignoredKeys.includes(key)) ignoredKeys.push(key)
  }

  const name = (scalars.name ?? '').trim()
  const description = (scalars.description ?? '').trim()
  if (!name) return { ok: false, error: 'missing-name' }
  if (!description) return { ok: false, error: 'missing-description' }

  return {
    ok: true,
    value: {
      name,
      description,
      body: lines.slice(close + 1).join('\n').trim(),
      metadata,
      ignoredKeys,
    },
  }
}
