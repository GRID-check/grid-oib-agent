#!/usr/bin/env node
/**
 * Content guard for CMS-authored blog entries.
 *
 * Keystatic writes MDX straight from the browser, so nobody runs a build before
 * the commit lands. `astro check` does not help: it type-checks components but
 * never resolves the image references inside MDX, so a broken one stays green
 * until `astro build` dies on a Rollup "failed to resolve import" trace that
 * means nothing to whoever wrote the post.
 *
 * This catches both failure modes at check time, with a message an author can
 * act on:
 *   1. an image reference that points at no file
 *   2. an image with no alt text
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const blogRoot = resolve(webRoot, 'src/content/blog')
const publicRoot = resolve(webRoot, 'public')

/** `![alt](src "title")` — the only image syntax Keystatic emits. */
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g
const FRONTMATTER_COVER = /^cover:\s*(.+?)\s*$/m

function findMdx(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return findMdx(full)
    return entry.name.endsWith('.mdx') ? [full] : []
  })
}

/** Resolve a reference the way Astro will: `/…` against public/, else relative. */
function resolveRef(ref, mdxPath) {
  if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:')) return null
  const clean = decodeURIComponent(ref.split('#')[0].split('?')[0])
  return clean.startsWith('/')
    ? resolve(publicRoot, `.${clean}`)
    : resolve(dirname(mdxPath), clean)
}

const problems = []
const files = findMdx(blogRoot).sort()

for (const file of files) {
  const rel = relative(webRoot, file)
  const source = readFileSync(file, 'utf8')
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  const frontmatter = match ? match[1] : ''
  const body = match ? match[2] : source

  const cover = frontmatter.match(FRONTMATTER_COVER)?.[1]?.replace(/^['"]|['"]$/g, '')
  if (cover) {
    const target = resolveRef(cover, file)
    if (target && !existsSync(target)) {
      problems.push(`${rel}: cover image not found — "${cover}"`)
    }
  }

  for (const [, alt, ref] of body.matchAll(MARKDOWN_IMAGE)) {
    const target = resolveRef(ref, file)
    if (target && !existsSync(target)) {
      problems.push(`${rel}: image not found — "${ref}"`)
    }
    if (!alt.trim()) {
      problems.push(`${rel}: image "${ref}" has no alt text`)
    }
  }
}

if (problems.length > 0) {
  console.error(`\nContent check failed (${problems.length}):\n`)
  for (const problem of problems) console.error(`  ✗ ${problem}`)
  console.error(
    '\nImages uploaded in Keystatic live under src/content/blog/_images/<slug>/ and\n' +
      'are referenced as ../_images/<slug>/<file>. Fill in the alt text box on the\n' +
      'image block before publishing.\n'
  )
  process.exit(1)
}

console.log(`Content check passed (${files.length} entries).`)
