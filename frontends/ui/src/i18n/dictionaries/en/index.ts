/**
 * English dictionary — the canonical shape.
 *
 * Every other locale must structurally match this object (enforced by the
 * `Dictionary` type in ../index.ts). Each namespace lives in its own file so
 * feature work can extend a namespace without touching unrelated strings.
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
import { legal } from './legal'

export const en = {
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
  legal,
} as const
