/**
 * @vitest-environment node
 *
 * The boot line, and the pin that keeps its two implementations identical.
 *
 * `src/lib/boot.ts` is canonical; `server.js` carries a hand-written CommonJS
 * copy because it cannot import a TS module (its header says why, and the
 * signed-envelope builder above it is duplicated for the same reason). A copy
 * that nothing compares is a copy that drifts, and the drift here is silent:
 * two containers of the same deployment would print two different answers to
 * "what is running", which is precisely the question the line exists to settle.
 *
 * So this spec does not read the copy's source and assert on a regex. It
 * EXTRACTS the function body and runs it, against the same table the canonical
 * implementation is run over. `bootLogLine` is written pure and self-contained
 * to make that possible; if someone reaches out of it for a module-scope
 * helper, `new Function` throws and this spec says so.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { bootFlags, bootLine, deployedSha, formatBootLine, UNKNOWN_SHA } from '@/lib/boot'

/** Env cases both implementations must agree on, byte for byte. */
const CASES: Array<{ name: string; env: Record<string, string>; expected: string }> = [
  {
    name: 'an unstamped image with nothing configured — the compose defaults',
    env: {},
    expected: '[boot] sha=unknown skills=false collaboration=false enforceFlags=false agentDocs=true',
  },
  {
    name: 'a published image with every gate on',
    env: {
      GRID_GIT_SHA: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c', // pragma: allowlist secret
      GRID_SKILLS_ENABLED: 'true',
      GRID_COLLABORATION_ENABLED: 'true',
      GRID_ENFORCE_FEATURE_FLAGS: 'true',
      GRID_AGENT_AUTHORED_DOCUMENTS_ENABLED: 'true',
    },
    expected:
      '[boot] sha=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c skills=true collaboration=true enforceFlags=true agentDocs=true', // pragma: allowlist secret
  },
  {
    name: 'filing withdrawn fleet-wide — the one gate that is off by being SET',
    env: { GRID_GIT_SHA: 'abc1234', GRID_AGENT_AUTHORED_DOCUMENTS_ENABLED: 'false' },
    expected: '[boot] sha=abc1234 skills=false collaboration=false enforceFlags=false agentDocs=false',
  },
  {
    name: 'the other falsey spellings agentAuthoredDocumentsEnvEnabled accepts',
    env: { GRID_AGENT_AUTHORED_DOCUMENTS_ENABLED: 'OFF' },
    expected: '[boot] sha=unknown skills=false collaboration=false enforceFlags=false agentDocs=false',
  },
  {
    name: 'an opt-in gate is not turned on by "1" — only the exact word true',
    env: { GRID_SKILLS_ENABLED: '1', GRID_COLLABORATION_ENABLED: 'yes' },
    expected: '[boot] sha=unknown skills=false collaboration=false enforceFlags=false agentDocs=true',
  },
  {
    name: 'whitespace and case, as an env_file or a copy-paste produces them',
    env: { GRID_GIT_SHA: '  deadbeef  ', GRID_ENFORCE_FEATURE_FLAGS: ' TRUE ' },
    expected: '[boot] sha=deadbeef skills=false collaboration=false enforceFlags=true agentDocs=true',
  },
  {
    name: 'an empty GRID_GIT_SHA is an unstamped image, not an empty sha',
    env: { GRID_GIT_SHA: '' },
    expected: '[boot] sha=unknown skills=false collaboration=false enforceFlags=false agentDocs=true',
  },
]

describe('the boot line', () => {
  it.each(CASES)('formats $name', ({ env, expected }) => {
    const typed = env as unknown as NodeJS.ProcessEnv
    expect(formatBootLine({ sha: deployedSha(typed), flags: bootFlags(typed) })).toBe(expected)
    expect(bootLine(typed)).toBe(expected)
  })

  it('names an unstamped image `unknown` rather than leaving the field empty', () => {
    // An empty value would read as "sha=" in a log and look like a truncation.
    expect(deployedSha({} as NodeJS.ProcessEnv)).toBe(UNKNOWN_SHA)
    expect(bootLine({} as NodeJS.ProcessEnv)).toContain(`sha=${UNKNOWN_SHA}`)
  })

  it('keeps every field on ONE line — the operator greps for it', () => {
    for (const { env } of CASES) {
      expect(bootLine(env as unknown as NodeJS.ProcessEnv).split('\n')).toHaveLength(1)
    }
    expect(bootLine({} as NodeJS.ProcessEnv).startsWith('[boot] ')).toBe(true)
  })
})

describe("server.js's CommonJS copy of the boot line", () => {
  const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8')

  /** Pull `bootLogLine` out of the gateway's source and make it callable. */
  const extracted = (): ((env: Record<string, string>) => string) => {
    const start = source.indexOf('function bootLogLine(env) {')
    expect(start, 'server.js no longer has the bootLogLine this spec pins').toBeGreaterThan(-1)
    const bodyStart = source.indexOf('{', start)
    // Balanced-brace scan: the function contains braces of its own, so
    // indexOf('}') would cut it in the middle of the optOut helper.
    let depth = 0
    let end = -1
    for (let i = bodyStart; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    expect(end, 'unbalanced braces while extracting bootLogLine').toBeGreaterThan(-1)
    return new Function(`${source.slice(start, end + 1)}; return bootLogLine`)() as (
      env: Record<string, string>
    ) => string
  }

  it('is called from the listen callback, so a booted gateway always prints it', () => {
    expect(source).toContain('console.log(bootLogLine(process.env))')
  })

  it.each(CASES)('agrees with lib/boot.ts on $name', ({ env, expected }) => {
    expect(extracted()(env)).toBe(expected)
  })
})
