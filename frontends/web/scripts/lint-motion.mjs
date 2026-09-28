#!/usr/bin/env node
/**
 * Fails the check when the motion tokens in CSS and in TypeScript disagree.
 *
 * The tokens exist twice because two runtimes read them: CSS custom properties
 * in src/styles/global.css for stylesheets and Tailwind utilities, and
 * src/lib/motion.ts for GSAP and the Web Animations API. Neither can import the
 * other at build time without a generator, so this check is what keeps them one
 * set. Node 22 strips the types from motion.ts on import.
 */
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8')
const { DURATION, EASE, STAGGER, TRAVEL } = await import('../src/lib/motion.ts')

const cssVars = new Map(
  [...css.matchAll(/--(duration|ease|stagger|travel)-([a-z]+):\s*([^;]+);/g)].map((m) => [
    `${m[1]}-${m[2]}`,
    m[3].trim(),
  ])
)

const want = new Map([
  ...Object.entries(DURATION).map(([k, v]) => [`duration-${k}`, `${v}ms`]),
  ...Object.entries(EASE).map(([k, v]) => [`ease-${k}`, `cubic-bezier(${v.join(', ')})`]),
  ...Object.entries(STAGGER).map(([k, v]) => [`stagger-${k}`, `${v}ms`]),
  ...Object.entries(TRAVEL).map(([k, v]) => [`travel-${k}`, `${v}px`]),
])

const problems = []
for (const [name, value] of want) {
  const got = cssVars.get(name)
  if (got === undefined) problems.push(`--${name} is in motion.ts but not in global.css`)
  else if (got !== value) problems.push(`--${name}: global.css says ${got}, motion.ts says ${value}`)
}
for (const name of cssVars.keys()) {
  if (!want.has(name)) problems.push(`--${name} is in global.css but not in motion.ts`)
}

if (problems.length) {
  console.error('Motion tokens out of step (src/styles/global.css vs src/lib/motion.ts):')
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
console.log(`motion tokens: ${want.size} in step`)
