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
import type { Dictionary } from '../index'

export const de: Dictionary = {
  common,
  nav,
  profile,
  settings,
  errors,
  landing,
  projects,
  chat,
  files,
  research,
  members,
  onboarding,
}
