/**
 * German dictionary.
 *
 * Each namespace is annotated with `typeof en.<ns>`, so any key added to the
 * English source that is missing here is a compile error — the two locales
 * can never structurally drift.
 */

import { common } from './common'
import { nav } from './nav'
import { profile } from './profile'
import { settings } from './settings'
import { errors } from './errors'
import { projects } from './projects'
import { chat } from './chat'
import { collaboration } from './collaboration'
import { files } from './files'
import { archiv } from './archiv'
import { bim } from './bim'
import { knowledge } from './knowledge'
import { research } from './research'
import { skills } from './skills'
import { members } from './members'
import { onboarding } from './onboarding'
import { organization } from './organization'
import { platform } from './platform'
import { presence } from './presence'
import { shortcuts } from './shortcuts'
import { legal } from './legal'
import type { Dictionary } from '../index'

export const de: Dictionary = {
  common,
  nav,
  presence,
  profile,
  shortcuts,
  settings,
  errors,
  projects,
  chat,
  collaboration,
  files,
  archiv,
  bim,
  knowledge,
  research,
  skills,
  members,
  onboarding,
  organization,
  platform,
  legal,
}
