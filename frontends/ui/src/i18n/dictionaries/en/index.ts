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

export const en = {
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
} as const
