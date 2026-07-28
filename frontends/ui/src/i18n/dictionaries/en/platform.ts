/** The platform owner's cross-organization dashboard (ADR-0016). */
export const platform = {
  title: 'Platform',
  subtitle: 'Cross-organization overview for the platform owner.',
  loading: 'Loading platform…',
  loadError: 'Could not load the platform overview.',
  loadErrorHint: 'Something went wrong while fetching the data. Please try again.',
  retry: 'Retry',
  nav: {
    label: 'Platform sections',
    overview: 'Overview',
    quality: 'Answer quality',
    knowledge: 'Base knowledge',
    norms: 'Norm catalog',
    workflows: 'Workflow templates',
    maintenance: 'Maintenance',
  },
  sections: {
    overview: {
      title: 'Overview',
      subtitle: 'Every organization on the platform, with projects and LLM spend.',
    },
    quality: {
      title: 'Answer quality',
      subtitle: 'How well answers are grounded — and the execution timeline behind any turn that was not.',
    },
    knowledge: {
      title: 'Base knowledge',
      subtitle: 'The shared OIB corpus every project grounds its answers on.',
    },
    norms: {
      title: 'Norm catalog',
      subtitle: 'Which legal sources bind, how they are ranked, and where they live in RIS.',
    },
    workflows: {
      title: 'Workflow templates',
      subtitle: 'Templates published into every organization’s gallery.',
    },
    maintenance: {
      title: 'Maintenance',
      subtitle: 'Vector-store upkeep. Only needed when retrieval and the corpus have drifted apart.',
    },
  },
  stats: {
    organizations: 'Organizations',
    projects: 'Projects',
    spendToday: 'Spend today',
    spendMonth: 'Spend this month',
    requestsMonth: '{count} requests this month',
  },
  orgs: {
    title: 'Organizations',
    description: 'Every organization on the platform, biggest spender first. Costs come from the LLM usage ledger.',
    colOrganization: 'Organization',
    colProjects: 'Projects',
    colToday: 'Today',
    colMonth: 'This month',
    colCreated: 'Created',
    platformBadge: 'Platform',
    empty: 'No organizations yet.',
  },
  trend: {
    title: 'Spend trend',
    description: 'Platform-wide LLM spend per day over the last 30 days (UTC), from the usage ledger.',
    requests: '{count} requests',
    empty: 'No usage recorded in the last 30 days.',
  },
  team: {
    title: 'Platform team',
    description: 'Members of the GRID Platform organization. Roles here grant platform-wide access — invite with care.',
    auditLogs: 'Audit logs',
    auditError: 'Could not open the audit log viewer.',
  },
  notOwner: {
    title: 'Platform access required',
    description: 'This dashboard is exclusive to the platform owner.',
  },
  knowledge: {
    title: 'Base knowledge',
    description:
      'The shared OIB corpus every project grounds on. Upload a PDF to ingest it immediately; uploaded documents can be removed again. A sync re-ingests new or changed source files.',
    explainer:
      'Base knowledge: the binding OIB directives and further foundations Piloti checks every answer against.',
    upload: 'Upload PDF',
    uploading: 'Uploading & ingesting…',
    uploadSuccess: '{name} ingested into the base corpus',
    uploadFailed: 'Ingestion of {name} failed',
    uploadTimeout: '{name} is still ingesting — refresh in a minute',
    sync: 'Sync corpus',
    syncing: 'Syncing…',
    syncDone: 'Sync finished: {added} added/changed of {total} files',
    syncFailed: 'Corpus sync failed',
    search: 'Filter documents…',
    empty: 'No documents match.',
    delete: 'Remove',
    deleteTitle: 'Remove {name}?',
    deleteDescription:
      'This deletes the uploaded PDF, its registry entry, and all of its indexed content. Chats can no longer ground on it.',
    deleteConfirm: 'Remove document',
    deleteCancel: 'Cancel',
    deleteSuccess: '{name} removed from the base corpus',
    deleteFailed: 'Could not remove {name}',
    // Removing a repo-shipped base document (excluded from the active corpus).
    corpusDelete: 'Remove from corpus',
    corpusDeleteTitle: 'Remove {name} from the corpus?',
    corpusDeleteDescription:
      'This removes a shipped base law from the active corpus: its indexed content is deleted and it will not be re-ingested on the next sync. Piloti will no longer check answers against it.',
    corpusDeleteConfirm: 'Remove from corpus',
    corpusDeleteSuccess: '{name} removed from the corpus',
    loadError: 'The knowledge base could not be loaded.',
    retry: 'Try again',
    chunkCount: '{count} chunks',
    // Drag-and-drop upload zone.
    dropTitle: 'Drop a PDF or ZIP here',
    dropHint: 'or click to choose a file — a ZIP may hold many PDFs at once',
    dropActive: 'Release to upload',
    // Background-processing banner + ZIP member summary.
    processing: 'Processing — this can take a minute…',
    processingHint: 'You can keep working; new documents appear below as they finish. It is safe to wait.',
    indexingProgress: 'Indexing {done} of {total} document(s)…',
    indexingDone: 'Indexed',
    indexingPending: 'Indexing…',
    pollTimeoutTitle: 'Processing is taking longer than expected',
    pollTimeoutDescription:
      'The upload is still being indexed in the background. Refresh to check its current status.',
    pollTimeoutRefresh: 'Refresh',
    uploadPending: '{name} received — indexing in the background',
    zipQueued: 'ZIP received: {accepted} PDF(s) queued, {rejected} skipped',
    zipRejectedTitle: 'Skipped from the ZIP',
    // Grouped sections.
    bindingTitle: 'Binding OIB foundations',
    bindingHint: 'The official OIB directives and related base laws — the authoritative building law Piloti must follow.',
    otherTitle: 'Further base documents',
    otherHint: 'Other norms, laws and supporting documents in the base corpus.',
    // Dokumentart classifier.
    docClassLabel: 'Document type',
    docClassFor: 'Document type for {name}',
    docClassFilterAll: 'All document types',
    docClassUpdated: 'Document type of {name} set to “{label}”',
    docClassUpdateFailed: 'Could not change the document type of {name}',
    // Display title (rename).
    displayTitleFor: 'Display name for {name}',
    displayTitleEdit: 'Rename {name}',
    displayTitlePlaceholder: 'Display name (leave empty to reset)',
    displayTitleSave: 'Save name',
    displayTitleCancel: 'Cancel rename',
    displayTitleUpdated: 'Renamed {name}',
    displayTitleUpdateFailed: 'Could not rename {name}',
    // Row actions.
    viewPdf: 'View PDF',
    noMatch: 'No documents match your filter.',
    clearFilters: 'Clear filters',
  },
  profiler: {
    title: 'Agent Profiler',
    description:
      'Per-conversation execution timeline — how long the agent spent on each step (graph node, LLM call, tool call), across every organization.',
    loadError: 'Could not load the profiler data.',
    retry: 'Retry',
    search: 'Search by conversation or title…',
    empty: 'No profiled conversations yet.',
    capped: 'Showing the {count} most recently active conversations.',
    colConversation: 'Conversation',
    colOrg: 'Organization',
    colTurns: 'Turns',
    colDuration: 'Total time',
    colLastActive: 'Last active',
    detailEmpty: 'Select a conversation to see its timeline.',
    detailLoading: 'Loading timeline…',
    detailLoadError: 'Could not load this conversation’s timeline.',
    turn: 'Turn',
    turnFailed: 'failed',
    spanCount: '{count} spans',
    noSpans: 'No spans recorded for this turn.',
  },
  maintenance: {
    title: 'Vector maintenance',
    description:
      'Remove orphaned vectors — indexed chunks left behind by past deletes, whose document no longer exists. They are invisible in the app but can still surface in retrieval. Safe to run any time; it only removes chunks with no live document.',
    reconcile: 'Reconcile orphaned vectors',
    reconciling: 'Reconciling…',
    confirmTitle: 'Reconcile orphaned vectors?',
    confirmDescription:
      'This scans every collection and deletes indexed chunks whose document no longer exists. Documents you can still see are never touched. This cannot be undone, but a removed document can be re-uploaded.',
    confirm: 'Run reconcile',
    cancel: 'Cancel',
    resultRemoved: 'Removed {chunks} orphaned chunk(s) across {collections} collection(s)',
    resultClean: 'No orphaned vectors found',
    resultCleanDetail: 'No orphaned vectors found across {collections} collection(s)',
    resultFailures: '{count} collection(s) could not be reconciled',
    failed: 'Reconcile failed',
  },
  workflowTemplates: {
    title: 'Workflow templates',
    explainer:
      'Curated research briefs published into every organization’s Workflows gallery. A published template appears for every org; selecting it there only pre-fills the workflow builder — it never runs automatically.',
    new: 'New template',
    // JSON import dropzone.
    dropTitle: 'Import a template (JSON)',
    dropActive: 'Release to import',
    dropHint: 'Drop or click to load a template JSON file — it opens the editor pre-filled as a draft.',
    importLoaded: 'Template file loaded — review and save.',
    importInvalid: 'That file is not a valid template export.',
    // List states.
    empty: 'No templates yet. Create one or import a JSON file.',
    loadError: 'The templates could not be loaded.',
    retry: 'Try again',
    manualCadence: 'On demand',
    // Row badges + actions.
    published: 'Published',
    draft: 'Draft',
    publishAria: 'Publish “{name}” to every organization',
    unpublishAria: 'Unpublish “{name}”',
    export: 'Export as JSON',
    edit: 'Edit',
    delete: 'Delete',
    // Provenance tint labels (shared by the form + the list).
    provenance: {
      law: 'Regulation',
      project: 'Project',
      office: 'Office',
      auto: 'General',
    },
    // Toasts.
    createSuccess: 'Template created.',
    updateSuccess: 'Template updated.',
    publishSuccess: 'Template published to every organization.',
    unpublishSuccess: 'Template unpublished.',
    publishFailed: 'The publish state could not be changed.',
    saveFailed: 'The template could not be saved.',
    deleteSuccess: 'Template deleted.',
    deleteFailed: 'The template could not be deleted.',
    // Delete confirmation.
    deleteTitle: 'Delete “{name}”?',
    deleteDescription:
      'This removes the template from every organization’s gallery. Workflows already created from it are unaffected. This cannot be undone.',
    deleteConfirm: 'Delete template',
    deleteCancel: 'Cancel',
    form: {
      createTitle: 'New workflow template',
      editTitle: 'Edit workflow template',
      subtitle: 'Author the brief in German and English — the gallery shows the viewer’s language.',
      provenanceLabel: 'Category tint',
      sortOrderLabel: 'Sort order',
      sortOrderHint: 'Lower numbers appear first in the gallery.',
      dataSourcesLabel: 'Additional data sources',
      dataSourcesHint:
        'The base knowledge layer is always included. Pick any extra sources a run should draw on.',
      sourcesLoading: 'Loading sources…',
      sourcesAll: 'No additional sources available.',
      scheduleLabel: 'Suggested schedule',
      scheduleHint: 'A default cadence the adopting user can keep or change.',
      presetLabel: 'Cadence',
      timezoneLabel: 'Timezone',
      cronLabel: 'Custom cron (5 fields)',
      cronHint: 'Minute Hour Day-of-month Month Day-of-week.',
      presets: {
        hourly: 'Every hour',
        daily: 'Daily at 06:00',
        weekly: 'Weekly, Monday 06:00',
        monthly: 'Monthly, 1st at 06:00',
        custom: 'Custom schedule',
      },
      locale: {
        de: 'German',
        en: 'English',
      },
      nameLabel: 'Name',
      descriptionLabel: 'Short description',
      categoryLabel: 'Category label',
      categoryHint: 'Short uppercase pill shown on the card, e.g. “Compliance”.',
      objectiveLabel: 'Objective',
      contextLabel: 'Background & context',
      questionsLabel: 'Research questions',
      questionsHint: 'One question per line.',
      outputFormatLabel: 'Output requirements',
      previewLabel: 'Compiled brief (what the agent receives)',
      previewEmpty: 'Fill in the objective to see the compiled brief.',
      publishLabel: 'Published',
      publishHint: 'When on, this template is visible in every organization’s gallery.',
      requiredError: 'Both languages need at least a name, description, category and objective.',
      cancel: 'Cancel',
      save: 'Save template',
      saving: 'Saving…',
    },
  },
  /**
   * Citation health (citation_events ledger): how often citation verification
   * had to intervene on a research turn, and why.
   */
  citations: {
    title: 'Citation health',
    description:
      'How often citation verification had to intervene on a research turn — and what it caught. Every research turn writes one row; defects are recorded alongside it.',
    loadError: 'Could not load citation health.',
    findingsTitle: 'What to do',
    findingsDescription:
      'Derived from the findings in this window — most urgent first. Each entry names the likely cause and the next step.',
    findings: {
      retrieval_unavailable: {
        title: 'A retrieval integration is down',
        meaning:
          '{turns} research turn(s) captured no source at all. When retrieval returns nothing there is nothing to cite, and the turn fails instead of answering.',
        action:
          'Check the reported tool ({subject}) and its data-source configuration — API key, base URL, network reachability. Fix this before anything else on this list; every other finding is downstream of it.',
        actionNoSubject:
          'Check the data-source configuration of the research tools — API key, base URL, network reachability. Fix this before anything else on this list.',
      },
      answers_ungrounded: {
        title: 'Answers are shipping without a source',
        meaning:
          '{turns} answer(s) ({share}% of turns) went out with the visible “Without source citation” note — sources were retrieved, but nothing the model cited survived verification.',
        action:
          'Open the flagged turns below and check whether the corpus actually covers the question. If it does, the citation contract in the writer prompt is the culprit; if it does not, the base knowledge for {subject} needs the missing documents.',
        actionNoSubject:
          'Open the flagged turns below and check whether the corpus actually covers the question. If it does, the citation contract in the writer prompt is the culprit; if it does not, the base knowledge needs the missing documents.',
      },
      citations_invented: {
        title: 'The model cites sources that were never retrieved',
        meaning:
          '{citations} citation(s) across {turns} turn(s) were removed, and {share}% of removals were sources absent from the retrieval registry — the model is citing from memory.',
        action:
          'This is a prompt/model problem, not a retrieval one. Tighten the citation rules in the researcher prompt (cite only from retrieved passages) and re-check the model configured for the affected organizations. Verification is currently the only thing catching it.',
      },
      quotes_fabricated: {
        title: 'Quoted passages do not appear in the sources',
        meaning:
          '{quotes} quoted span(s) across {turns} turn(s) ({share}% of turns) matched no retrieved passage — the classic “real section, invented wording” pattern.',
        action:
          'Spot-check the flagged turns against the cited document. If the quotes are genuinely correct, the fuzzy match threshold is too strict; if they are not, the model is fabricating wording and needs a stricter quoting instruction.',
      },
      citation_format_unparsed: {
        title: 'Citations are being written in a format the verifier cannot parse',
        meaning:
          'On {turns} turn(s) ({share}% of turns) nothing the model wrote survived parsing, and a source had to be attached automatically.',
        action:
          'Compare the citation syntax in the researcher prompt with what verification expects. A format drift here silently discards correct citations, so the answer looks less grounded than it is.',
      },
      organization_outlier: {
        title: 'One organization is much worse than the rest',
        meaning:
          '{subject} has a {share}% finding rate against a platform average of {platformShare}% ({turns} flagged turns).',
        action:
          'Look at that organization specifically rather than the pipeline: base knowledge coverage, uploaded project documents, and their configured model. A platform-wide change would be the wrong fix.',
      },
      sources_missing: {
        title: 'Specific sources are cited but not held',
        meaning:
          '{sources} distinct source(s) were cited across {turns} turn(s) and none of them is in the base corpus or the norm catalog. The most-cited is {subject}.',
        action:
          'Work the “Sources to add” list below. {automatic} of them are RIS pointers that only need their legal rank confirmed; the rest are documents whose PDF you have to supply.',
      },
      sources_unretrievable: {
        title: 'Sources the platform HAS are not reaching answers',
        meaning:
          '{sources} cited source(s) across {turns} turn(s) are already in the corpus, yet retrieval never returned them — starting with {subject}.',
        action:
          'Do NOT re-upload these. Check indexing instead: run a corpus sync, then reconcile the vector store. If they stay unretrievable, the chunking or the embedding of those documents is at fault.',
      },
      duplicates_only: {
        title: 'Most removals are only duplicates',
        meaning: '{share}% of removed citations were duplicates of a citation already present in the same answer.',
        action:
          'No action needed — this is cosmetic deduplication, not a grounding failure. Do not read the “citations removed” figure as a quality problem while this dominates.',
      },
      all_clear: {
        title: 'Nothing needs your attention',
        meaning: '{turns} research turns in this window, {share}% of them without a single finding.',
        action: 'Nothing to do. Come back if the trend above starts climbing.',
      },
    },
    export: 'Export diagnostics',
    windowAria: 'Time window',
    windowDays: 'Last {count} days',
    unattributed: 'Unattributed',
    turnId: 'Turn',
    itemCount: '{count} affected',
    empty: {
      title: 'No research turns recorded yet',
      description:
        'Citation health fills up as soon as research turns run. Nothing recorded in this window means nothing to review.',
    },
    stats: {
      cleanRate: 'Clean turns',
      cleanRateHint: '{clean} of {turns} turns without a finding',
      ungrounded: 'Without source citation',
      ungroundedHint: 'Answers shipped without a verified citation',
      removed: 'Citations removed',
      removedHint: 'Individual citations the verifier could not confirm',
      quotes: 'Unverified quotes',
      quotesHint: 'Quoted spans found in no retrieved passage',
    },
    trend: {
      title: 'Defects per day',
      description: 'Research turns with a citation finding, per UTC day over the last {days} days.',
      turns: '{count} turns',
      empty: 'No citation findings in this window.',
    },
    missingTitle: 'Sources to add',
    missingDescription:
      'Specific sources answers keep citing that verification could not confirm, checked against what the platform actually holds. Most-cited first.',
    missingCited: 'cited on {turns} turn(s) · {organizations} organization(s)',
    missingCaveat:
      'Each button opens the manager that owns the add flow, with the identifier copied to your clipboard. Adding is deliberately not silent: an uploaded PDF has to come from you, and a norm-catalog entry needs its legal rank and Bundesland confirmed before the agent may quote it as binding.',
    missingStatus: {
      absent: 'not held by the platform',
      present: 'already held — retrieval did not surface it',
    },
    missingKinds: {
      document: 'Document',
      ris: 'RIS',
      web: 'Web',
    },
    missingActions: {
      upload_to_base_knowledge: 'Add to base knowledge',
      add_to_norm_catalog: 'Add to norm catalog',
      investigate_retrieval: 'Check indexing',
      none: 'Outside the corpus',
    },
    reasonsTitle: 'Why citations were dropped',
    reasonsDescription: 'The verifier’s own reason for each removal, most frequent first.',
    reasonsEmpty: 'No removals in this window.',
    sourcesTitle: 'Sources in play on flagged turns',
    sourcesDescription: 'Retrieval origins and tools that were active on turns with a finding.',
    sourcesEmpty: 'No source metadata for flagged turns in this window.',
    orgsTitle: 'By organization',
    orgsDescription: 'Most affected first. A high rate on few turns is noise; a high rate on many is a problem.',
    orgsEmpty: 'No organizations recorded in this window.',
    colTurns: 'Turns',
    colDefects: 'Flagged',
    colDefectRate: 'Rate',
    recentTitle: 'Most recent findings',
    recentDescription: 'The newest flagged turns. The turn id matches the agent profiler above.',
    recentEmpty: 'No findings in this window.',
    kinds: {
      answer_ungrounded: 'Without source citation',
      citations_removed: 'Citations removed',
      quote_unverified: 'Quote not verifiable',
      registry_empty: 'No sources captured',
      citation_fallback: 'Citation supplied automatically',
      confidence_capped: 'Confidence capped',
    },
    reasons: {
      url_not_in_registry: 'URL not among the retrieved sources',
      citation_key_not_in_registry: 'Document not among the retrieved sources',
      unverifiable: 'No verifiable target in the citation',
      duplicate: 'Duplicate of another citation',
      ungrounded: 'Answer not grounded in a citation',
      quote_unverified: 'Quote not verifiable',
    },
    dimensions: {
      origin: 'Origin',
      tool: 'Tool',
    },
    agents: {
      shallow: 'Quick research',
      deep: 'Deep research',
    },
  },
}
