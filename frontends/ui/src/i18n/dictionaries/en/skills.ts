/**
 * Agent Skills: the organization's skill library, its editor, and the `/` invocation
 * surface in the chat composer.
 *
 * A skill knows nothing about time. Everything about running a prompt on a
 * timer — including which skill (if any) it attaches and what a run produces —
 * lives in the `jobs` namespace.
 */
export const skills = {
  title: 'Skills',
  subtitle:
    'Reusable instructions your organization writes once, then invokes with “/” in chat or attaches to a job. Editing one never changes a job that already uses it — the job keeps the snapshot it saved.',
  tryAgain: 'Try again',

  toolbox: {
    ownHeading: 'Your skills',
    newSkill: 'New skill',
    loadError: 'Your skills could not be loaded.',
    empty: {
      title: 'No skills yet',
      description:
        'Write one for your organization. A skill is a name, a description saying when it applies, and the instruction itself.',
      action: 'New skill',
    },
    origin: {
      // Said on the card only when it is true. A skill that IS in play needs no
      // label saying so — the switch already shows it.
      disabled: 'Switched off',
    },
    scope: {
      chatOnly: 'Chat agent only',
      deepOnly: 'Deep research only',
    },
    actions: {
      edit: 'Edit',
      delete: 'Delete',
      viewBody: 'View instruction',
      enabledAria: 'Use the skill “{name}” in this organization',
    },
  },

  // What Piloti curates for every organization — the top of the page, because
  // switching one of ours on beats starting from a blank editor.
  curated: {
    heading: 'Featured skills',
    origin: 'Curated by Piloti',
    count: '{active} of {total} on',
    hint: 'Skills Piloti maintains for your organization. Switch one on and the agent may use it; switch it off and it disappears from the “/” menu and from what the agent can pick.',
    actions: {
      enabledAria: 'Use the Piloti skill “{name}” in this organization',
    },
  },

  actions: {
    delete: 'Delete',
  },

  editor: {
    review: {
      heading: 'Skill check',
      subtitle:
        'A reviewer reads the skill the way an agent will and says what would stop it being picked. Advisory — it never blocks saving.',
      action: 'Check this skill',
      running: 'Checking…',
      clean: 'Nothing to flag. The description says what the skill does and when to use it.',
      // Deliberately not "looks good": the reviewer did not run.
      unavailable: 'The check could not run just now. Nothing was assessed — try again in a moment.',
      fields: {
        name: 'Name',
        description: 'Description',
        body: 'Instructions',
      },
    },
    preview: {
      heading: 'SKILL.md',
      subtitle: 'Exactly what gets stored, and exactly what an agent reads.',
      level1: 'Always loaded',
      level1Hint:
        'Every skill contributes this much to the agent’s context on every turn — which is why the description has to say when the skill applies.',
      level2: 'Loaded on activation',
      level2Hint:
        'These instructions reach the agent only if it decides to use this skill, so length costs nothing until then.',
      descriptionPlaceholder: 'What this skill does, and when to use it.',
      emptyBody: 'No instructions yet.',
    },
    createTitle: 'New skill',
    editTitle: 'Edit skill',
    createSubtitle:
      'Author a reusable skill in the agentskills.io format: a name, a description and the instruction body.',
    editSubtitle: 'Adjust the skill. Jobs that already use it keep their saved snapshot.',
    nameLabel: 'Name',
    namePlaceholder: 'e.g. oib-fire-check',
    nameHint: 'Lowercase and hyphens. It is exactly what people type after “/” in chat.',
    nameRequired: 'A name is required.',
    nameTooLong: 'Skill names are at most 64 characters.',
    nameInvalid:
      'Skill names must be lowercase a-z/0-9 separated by single hyphens (no leading, trailing or consecutive hyphens).',
    descriptionLabel: 'Description',
    descriptionPlaceholder: 'When should the agent use this skill?',
    descriptionHint:
      'This is what the agent triggers on: it reads this sentence — never the instruction — and decides from it whether to load the skill. So say WHAT the skill does and WHEN it should apply, in the words your colleagues actually use.',
    descriptionRequired: 'A description is required.',
    descriptionTooLong: 'Descriptions are at most 1024 characters.',
    bodyLabel: 'Instruction',
    bodyPlaceholder: 'The full instruction the agent follows when this skill runs.',
    bodyHint:
      'Markdown. These instructions only reach the agent once it loads the skill, so their length costs nothing until then.',
    bodyRequired: 'The instruction body is required.',
    bodyTooLong: 'Instruction bodies are at most 32000 characters.',
    markdown: {
      h1: 'Heading 1',
      h2: 'Heading 2',
      h3: 'Heading 3',
      bold: 'Bold (ctrl + B)',
      italic: 'Italic (ctrl + I)',
      code: 'Inline code',
      codeBlock: 'Code block',
      bulletList: 'Bullet list',
      numberedList: 'Numbered list',
      taskList: 'Task list',
      link: 'Insert link',
      quote: 'Quote',
      table: 'Insert table',
      edit: 'Text only',
      split: 'Text and preview',
      preview: 'Preview only',
      fullscreen: 'Fullscreen',
    },
    agents: {
      heading: 'Availability',
      hint: 'Which agents may use this skill. Both, by default.',
      chat: {
        label: 'Chat agent',
        hint: 'Answers questions in chat. This is where you invoke the skill with “/”.',
      },
      deep: {
        label: 'Deep research agent',
        hint: 'Runs the long-form research in the background and writes the report.',
      },
    },
    raw: {
      heading: 'Advanced: edit the SKILL.md directly',
      subtitle: 'Paste or edit the whole document — the fields above are rewritten from it.',
      documentLabel: 'SKILL.md document',
      apply: 'Apply',
      reset: 'Reset',
      applied: 'Document applied.',
      ready: 'The document is valid. “Apply” writes it into the fields above.',
      unchanged: 'Unchanged — identical to the fields above.',
      ignored: 'GRID cannot store these fields and drops them on apply: {keys}.',
      errors: {
        'missing-frontmatter':
          'The document does not start with a “---” block. A SKILL.md always opens with YAML frontmatter.',
        'unterminated-frontmatter': 'The frontmatter block is never closed with “---”.',
        'malformed-frontmatter':
          'The frontmatter has a line that is not “key: value”. Apart from “metadata”, nested structures are not supported here.',
        'missing-name': 'The frontmatter has no “name”.',
        'missing-description': 'The frontmatter has no “description”.',
      },
    },
    cards: {
      heading: 'Preferred output cards',
      hint: 'The agent will prefer these when the content suits — a preference, not a rule.',
      searchPlaceholder: 'Search cards, e.g. comparison or escape route',
      empty: 'No preference — the agent picks the card that fits the answer.',
      noMatches: 'No card matches that search.',
      removeAria: 'Remove card type “{type}” from the preference',
    },
    enabledLabel: 'Enabled',
    enabledHint:
      'Off: the skill disappears from the “/” menu and from what the agent can pick. Jobs that already use it keep running from their saved snapshot.',
    save: 'Save skill',
    saving: 'Saving…',
    cancel: 'Cancel',
    createSuccess: 'Skill created.',
    updateSuccess: 'Skill saved.',
    saveError: 'The skill could not be saved.',
    deleteTitle: 'Delete skill',
    deleteDescription:
      'This removes “{name}” from the library. Jobs that already use it keep their saved snapshot, so they keep running unchanged.',
    deleteConfirm: 'Delete skill',
  },

  // The `/` invocation surface in the chat composer.
  composer: {
    picker: {
      resultsAria: 'Available skills',
      // The empty state is the one place we can teach what a skill IS, so it
      // says where they come from rather than just reporting a count of zero.
      empty: 'No skills available yet',
      emptyHint: 'Skills your organization adds appear here. Manage them under Skills.',
      noResults: 'No skill matches “{query}”',
      noResultsHint: 'Skills are matched on their name and on what they say they are for.',
      loading: 'Loading skills',
      builtin: 'Built-in',
      keyboardHint: '↑↓ to choose · ↵ to insert · esc to dismiss',
    },
    // The chip shown under the composer once a skill is invoked.
    invoked: {
      label: 'Skill',
      hint: 'Its instructions load at the start of this turn.',
      remove: 'Remove the {name} skill from this message',
    },
    // How an activated skill is reported on the answer.
    activated: {
      one: '1 skill used',
      other: '{count} skills used',
      title: 'Skills used for this answer',
      // States the mechanism plainly: the description is always in context, the
      // instructions were pulled in only because the skill was activated.
      explainer:
        'The assistant sees every skill’s name and description at the start of a turn, and loads the full instructions only for the ones it activates. These were activated.',
    },
  },
}
