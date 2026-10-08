/**
 * @vitest-environment node
 *
 * The Steckbrief's people never reach the agent (ADR-0090). They are personal
 * data of people who mostly never gave it — former staff, external planners —
 * and the agent's context is sent to a model on every turn.
 *
 * Kept out by construction: the people live in their own table, and nothing
 * that assembles what the agent is told may read it. This spec walks every
 * module that builds the agent's context, and the agent's own service-token
 * routes, and fails on an import of the people's table or service. A new
 * context builder belongs on the list below.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(process.cwd(), 'src')

/** What builds the agent's context, or answers the agent: directories and single files. */
const CONTEXT_BUILDERS = [
  'lib/project-profile',
  'lib/turn-context',
  'app/api/internal',
  'app/api/auth/websocket-scope',
  'lib/collection-scope-request.ts',
  'lib/jobs/service.ts',
  'lib/tasks/delegation.ts',
]

/** What reads or names the people. */
const PEOPLE = /steckbrief-(service|repository)|['"]@\/lib\/db\/schema\/project-people['"]|\bprojectPeople\b|project_people/

function sources(path: string): string[] {
  const full = join(ROOT, path)
  if (statSync(full).isFile()) return [full]
  return readdirSync(full, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file) && !/\.(spec|test)\.tsx?$/.test(file))
    .map((file) => join(full, file))
}

describe("the Steckbrief's people stay out of the agent's prompt", () => {
  it('no module that builds the agent context, nor any agent route, reads them', () => {
    const offenders = CONTEXT_BUILDERS.flatMap(sources).filter((file) => PEOPLE.test(readFileSync(file, 'utf8')))
    expect(offenders.map((file) => file.slice(ROOT.length + 1))).toEqual([])
  })

  it('the pattern would see an import if one were added', () => {
    expect(PEOPLE.test("import { listProjectPeople } from '@/lib/projects/steckbrief-repository'")).toBe(true)
    expect(PEOPLE.test('db.select().from(projectPeople)')).toBe(true)
  })
})
