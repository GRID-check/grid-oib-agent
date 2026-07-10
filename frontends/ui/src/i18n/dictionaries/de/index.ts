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
import { landing } from './landing'
import { projects } from './projects'
import { chat } from './chat'
import { files } from './files'
import { research } from './research'
import { members } from './members'
import { onboarding } from './onboarding'
import { organization } from './organization'
import { platform } from './platform'
import { presence } from './presence'
import { shortcuts } from './shortcuts'
import type { Dictionary } from '../index'

export const de: Dictionary = {
  common,
  nav,
  presence,
  profile,
  shortcuts,
  settings,
  errors,
  landing,
  projects,
  chat,
  files,
  research,
  members,
  onboarding,
  organization,
  platform,
}
