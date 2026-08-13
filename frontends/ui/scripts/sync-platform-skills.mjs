/**
 * Generates src/lib/skills/platform-skills.ts from the backend builtin skill
 * files under src/aiq_agent/skills/builtin (one SKILL.md per skill). Run from
 * the repo root:
 *
 *   node frontends/ui/scripts/sync-platform-skills.mjs         write
 *   node frontends/ui/scripts/sync-platform-skills.mjs --check verify CI
 *
 * The generated module is checked into git. It is consulted when a member
 * schedules a run of a builtin skill that the org has not cloned yet, keyed
 * by name; the snapshot carries the generated timestamp for the Runs table
 * detail column.
 *
 * NOTE ON STYLE: this file intentionally contains no backslash or backtick
 * characters and no 'star slash' sequence, because the file is produced by a
 * tool pipeline that escapes them; newlines and the backslash used in the
 * generated header are injected from char codes.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const uiRoot = join(here, '..')
const backendRoot = join(uiRoot, '..', '..', 'src', 'aiq_agent', 'skills', 'builtin')
const outFile = join(uiRoot, 'src', 'lib', 'skills', 'platform-skills.ts')

const LE = String.fromCharCode(10) // newline
const CR = String.fromCharCode(13) // carriage return
const BS = String.fromCharCode(92) // backslash
const BT = String.fromCharCode(96) // backtick

// A skill is a directory whose name is the skill name, containing SKILL.md.
// Its parent directory (research | synthesis) is the collection.
function collectSkills(dir, collection, out) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (!statSync(full).isDirectory()) continue
    if (existsSync(join(full, 'SKILL.md'))) {
      out.push({ collection, name: entry, file: join(full, 'SKILL.md') })
    } else {
      collectSkills(full, entry, out)
    }
  }
}

const skills = []
collectSkills(backendRoot, null, skills)

function parseFrontmatter(raw, file) {
  // Normalize CRLF and strip a UTF-8 BOM so Windows checkouts parse the same
  // as POSIX ones.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  raw = raw.replaceAll(CR + LE, LE)
  const lines = raw.split(LE)
  if (lines[0] !== '---') {
    throw new Error('missing frontmatter in ' + file)
  }
  // Indentation is the whole grammar here. A top-level key sits at column 0; the
  // lines BELOW it that are indented belong to it (a `>` block scalar's text, or
  // a nested mapping's entries). The previous version had no notion of this and
  // simply appended every line after `description:` until a blank one, so adding
  // any second top-level key — `metadata:` — silently swallowed that key and its
  // whole block into the description string.
  let name = null
  let description = null
  let metadata = null
  let contentStart = null
  let current = null // which top-level key the indented lines belong to

  const isIndented = (line) => /^\s+\S/.test(line)

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === '---') {
      contentStart = i + 1
      break
    }
    if (isIndented(line)) {
      const text = line.trim()
      if (text === '' || text.startsWith('#')) continue
      if (current === 'description') {
        description.push(text)
      } else if (current === 'metadata') {
        const separator = text.indexOf(':')
        if (separator <= 0) {
          throw new Error('malformed metadata entry ' + JSON.stringify(text) + ' in ' + file)
        }
        const key = text.slice(0, separator).trim()
        // Values may be quoted (`grid-schedulable: "false"`); unwrap one layer.
        const value = text
          .slice(separator + 1)
          .trim()
          .replace(/^(['"])(.*)\1$/, '$2')
        metadata[key] = value
      }
      continue
    }
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue

    const separator = line.indexOf(':')
    if (separator <= 0) {
      throw new Error('malformed frontmatter line ' + JSON.stringify(line) + ' in ' + file)
    }
    const key = line.slice(0, separator).trim()
    const inline = line.slice(separator + 1).trim()
    current = key
    if (key === 'name') {
      name = inline
    } else if (key === 'description') {
      // `description: >` (block scalar) or `description: text` on one line.
      description = inline === '' || inline === '>' || inline === '|' ? [] : [inline]
    } else if (key === 'metadata') {
      metadata = {}
    }
  }
  if (name === null || name === '') {
    throw new Error('missing name in frontmatter of ' + file)
  }
  if (description === null || description.length === 0) {
    throw new Error('missing description in frontmatter of ' + file)
  }
  if (contentStart === null) {
    throw new Error('unterminated frontmatter in ' + file)
  }
  const body = lines.slice(contentStart).join(LE).trim()
  return {
    name: name,
    description: description.join(' '),
    metadata: metadata ?? {},
    body: body,
  }
}

const rows = skills
  .map(function ({ collection, file }) {
    const parsed = parseFrontmatter(readFileSync(file, 'utf8'), file)
    return {
      name: parsed.name,
      description: parsed.description,
      metadata: parsed.metadata,
      body: parsed.body,
      collection: collection,
    }
  })
  .sort(function (a, b) {
    return a.name.localeCompare(b.name)
  })

const generatedAt = new Date().toISOString()
const sourcePath = relative(uiRoot, backendRoot).replaceAll(BS, '/')

// Generated header. The glob for SKILL.md is written without any star-slash.
const header = [
  '/**',
  ' * GENERATED FILE - DO NOT EDIT.',
  ' *',
  ' * Builtin platform skills mirrored from the backend',
  ' * (' + BT + sourcePath + BS + '**' + BS + 'SKILL.md' + BT + '), generated by',
  ' * ' + BT + 'frontends/ui/scripts/sync-platform-skills.mjs' + BT + ' at ' + generatedAt + '.',
  ' *',
  ' * This is the fallback source for scheduling builtin skills the org has not',
  ' * cloned; an org clone shadows the same name (see lib/skills/service.ts).',
  " * origin is always 'platform' (the DB skills.origin vocabulary has no",
  " * 'platform' value - only org-authored and platform-clone rows live there).",
  ' */',
  '',
  // Derived from the directories actually found, never hardcoded. It WAS
  // hardcoded to 'research' | 'synthesis', so adding a skill under a new
  // collection (bim/) emitted `collection: 'bim'` against a union that did not
  // contain it — `tsc` failed on the generated file itself. Nothing caught it
  // until the module was regenerated, because a stale module type-checks fine.
  'export type PlatformSkillCollection =\n  | ' +
    Array.from(new Set(skills.map((s) => s.collection)))
      .sort()
      .map((c) => "'" + c + "'")
      .join('\n  | '),
  '',
  'export type PlatformSkill = {',
  '  name: string',
  '  description: string',
  '  /** Frontmatter `metadata` verbatim — carries the reserved `grid-*` keys. */',
  '  metadata: Record<string, string>',
  '  body: string',
  '  collection: PlatformSkillCollection',
  '}',
  '',
  'export const PLATFORM_SKILLS: readonly PlatformSkill[] = [',
].join(LE)

const rowLines = rows
  .map(function (s) {
    return [
      '  {',
      "    name: '" + s.name + "',",
      '    description: ' + JSON.stringify(s.description) + ',',
      '    metadata: ' + JSON.stringify(s.metadata) + ',',
      '    body: ' + JSON.stringify(s.body) + ',',
      "    collection: '" + s.collection + "',",
      '  },',
    ].join(LE)
  })
  .join(LE)

const footer = [
  ']',
  '',
  'export function listPlatformSkills(): readonly PlatformSkill[] {',
  '  return PLATFORM_SKILLS',
  '}',
  '',
  'export function findPlatformSkill(',
  '  name: string',
  '): PlatformSkill | null {',
  '  return PLATFORM_SKILLS.find((s) => s.name === name) ?? null',
  '}',
  '',
].join(LE)

const generated = header + LE + rowLines + LE + footer

// The header embeds a per-run ISO timestamp, so the check masks that line
// out on both sides before comparing.
const TIMESTAMP_MARKER = '.mjs' + BT + ' at '
const maskTimestamp = function (text) {
  return text
    .split(LE)
    .map(function (line) {
      return line.includes(TIMESTAMP_MARKER) ? '' : line
    })
    .join(LE)
}

if (process.argv.includes('--check')) {
  if (!existsSync(outFile)) {
    console.error('missing ' + outFile + '; run sync-platform-skills.mjs')
    process.exit(1)
  }
  if (maskTimestamp(readFileSync(outFile, 'utf8')) !== maskTimestamp(generated)) {
    console.error('platform-skills.ts is stale; run sync-platform-skills.mjs')
    process.exit(1)
  }
  console.log('ok: platform skills up to date')
} else {
  writeFileSync(outFile, generated)
  console.log('wrote ' + outFile + ' (' + rows.length + ' skills)')
}
