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
import { officeShelf } from './office-shelf'
import { bim } from './bim'
import { knowledge } from './knowledge'
import { research } from './research'
import { skills } from './skills'
import { jobs } from './jobs'
import { tasks } from './tasks'
import { runs } from './runs'
import { members } from './members'
import { onboarding } from './onboarding'
import { organization } from './organization'
import { platform } from './platform'
import { presence } from './presence'
import { capture } from './capture'
import { shortcuts } from './shortcuts'
import { legal } from './legal'
import { answerExport } from './answer-export'
import { diagrams } from './diagrams'
import { feedback } from './feedback'
import { feedbackExport } from './feedback-export'
import { uploadBatches } from './upload-batches'
import { references } from './references'
import { projectIntake } from './project-intake'
import { intakeProfileStep } from './intake-profile-step'
import { intakeQuestionsStep } from './intake-questions-step'
import { intakeReadingStep } from './intake-reading-step'
import { intakeFilingStep } from './intake-filing-step'
import { intakeProjectStep } from './intake-project-step'
import { intakeShell } from './intake-shell'
import { notifications } from './notifications'
import { inboundMail } from './inbound-mail'
import { mailThread } from './mail-thread'
import type { Dictionary } from '../index'

export const de: Dictionary = {
  common,
  nav,
  presence,
  capture,
  profile,
  shortcuts,
  settings,
  errors,
  projects,
  chat,
  collaboration,
  files,
  officeShelf,
  bim,
  knowledge,
  research,
  skills,
  jobs,
  tasks,
  runs,
  members,
  onboarding,
  organization,
  platform,
  legal,
  answerExport,
  diagrams,
  feedback,
  feedbackExport,
  uploadBatches,
  references,
  projectIntake,
  intakeProfileStep,
  intakeQuestionsStep,
  intakeReadingStep,
  intakeFilingStep,
  intakeProjectStep,
  intakeShell,
  notifications,
  inboundMail,
  mailThread,
}
