/** The platform owner's cross-organization dashboard (ADR-0016). */
export const platform = {
  title: 'Platform',
  subtitle: 'Cross-organization overview for the platform owner.',
  loading: 'Loading platform…',
  loadError: 'Could not load the platform overview.',
  // Generic empty state for `SectionCard`, whose `emptyTitle` prop is optional.
  // Every caller happens to pass one today, which is why the fallback pointing
  // at a key that did not exist went unnoticed.
  empty: {
    title: 'Nothing here yet',
  },
  loadErrorHint: 'Something went wrong while fetching the data. Please try again.',
  retry: 'Retry',
  /**
   * Platform → base knowledge, rebuilt on the shared admin primitives
   * (SectionCard + DataToolbar + Table + Sheet + Pagination). Only the copy the
   * new shape introduced lives here; the wording that survived the rebuild —
   * upload, sync, delete, doc-class, rename — stays in `platform.knowledge`, so
   * a single sentence is never worded two ways.
   */
  knowledgeAdmin: {
    // Upload is an action now, not a permanently open dropzone.
    addDocuments: 'Add documents',
    hideUpload: 'Hide upload',
    // Corpus summary strip.
    summaryDocuments: 'Documents',
    summaryIndexed: 'Indexed',
    summaryPending: 'Indexing',
    summaryChunks: 'Indexed sections',
    // Toolbar.
    searchLabel: 'Filter documents',
    searchClear: 'Clear filter',
    scopeLabel: 'Scope',
    scopeAll: 'All documents',
    // Table.
    colDocument: 'Document',
    colType: 'Document type',
    colState: 'Status',
    colChunks: 'Sections',
    sortBy: 'Sort by {column}',
    binding: 'Binding',
    selectAll: 'Select all documents on this page',
    selectRow: 'Select {name}',
    openDetail: 'Open details for {name}',
    range: '{from}–{to} of {total}',
    previous: 'Previous',
    next: 'Next',
    // Selection / bulk actions.
    selectedCount: '{count} selected',
    clearSelection: 'Clear',
    bulkReclassify: 'Change document type',
    bulkReclassifyDone: 'Document type of {count} document(s) set to “{label}”',
    bulkReclassifyFailed: 'Document type of {count} document(s) could not be changed',
    bulkDelete: 'Remove',
    bulkDeleteTitle: 'Remove {count} documents?',
    bulkDeleteDescription:
      'Uploaded documents are deleted together with all of their indexed content; documents shipped with the corpus are excluded from it and will not be re-ingested on the next sync. Answers can no longer ground on any of them.',
    bulkDeleteConfirm: 'Remove {count} documents',
    bulkDeleteDone: '{count} documents removed',
    bulkDeleteFailed: '{count} documents could not be removed',
    // Detail sheet.
    detailClose: 'Close',
    detailOrigin: 'Origin',
    detailChunks: 'Indexed sections',
    detailSize: 'Size',
    detailIngestedAt: 'Indexed on',
    origin: {
      corpus: 'Shipped with the corpus',
      uploaded: 'Uploaded',
      index_only: 'Index only — no source file',
    },
    // Empty state.
    emptyTitle: 'No base documents yet',
    emptyDescription:
      'Add a PDF, or a ZIP holding many at once — every project grounds its answers on this corpus.',
  },
  norms: {
    title: 'Norm catalog',
    description:
      'Curated pointers to Austrian building law that the agent cites — unlike base knowledge, which holds the full texts they are checked against.',
    entryCount: '{count} entries.',
    entryCountOne: '1 entry.',
    loadError: 'Could not load the norm catalog.',
    add: 'New entry',
    save: 'Save registry',
    saved: 'Registry saved.',
    saveError: 'Could not save the registry.',
    invalid: 'Registry validation failed.',
    unsaved: 'Unsaved',
    federal: 'Federal',
    empty: {
      title: 'No entries in the catalog yet',
      description: 'Add the first legal pointer the agent is allowed to cite.',
    },
    noMatches: {
      title: 'No entry matches these filters',
      description: 'Clear the search, or pick a different rank or scope.',
    },
    conflict: {
      title: 'The catalog changed elsewhere',
      description:
        'Someone saved a newer version while you were editing, so your changes were not written. Reload to continue from the current catalog — this discards them.',
      reload: 'Discard and reload',
      toast: 'The catalog changed elsewhere — reload before saving.',
    },
    search: {
      placeholder: 'Search title, short name, ID…',
      label: 'Search norm entries',
      clear: 'Clear search',
    },
    filters: {
      rank: 'Rank',
      allRanks: 'All ranks',
      scope: 'Scope',
      allScopes: 'All scopes',
      reviews: 'Open reviews ({count})',
    },
    ranks: {
      bundesgesetz: 'Federal act',
      landesgesetz: 'State act',
      verordnung: 'Ordinance',
      behoerdliche_info: 'Authority information (e.g. MA 37)',
      norm_extern: 'External norm (ÖNORM/TRVB — no full text)',
    },
    rankShort: {
      bundesgesetz: 'Federal act',
      landesgesetz: 'State act',
      verordnung: 'Ordinance',
      behoerdliche_info: 'Authority info',
      norm_extern: 'External norm',
    },
    columns: {
      norm: 'Norm',
      rank: 'Rank',
      scope: 'Scope',
      document: 'Document',
      verified: 'Verified',
    },
    row: {
      open: 'Edit {title}',
      noFullText: 'no full text',
      unverified: 'unverified',
      staleHint: 'Verification missing or older than 12 months',
      verifiedHint: 'Last verified',
      review: 'Open review',
    },
    pagination: {
      range: '{from}–{to} of {total}',
      previous: 'Previous',
      next: 'Next',
    },
    sheet: {
      newTitle: 'New entry',
      editTitle: 'Edit entry',
      description: 'Changes reach the catalog only once you save it.',
      close: 'Close editor',
      apply: 'Apply',
      cancel: 'Cancel',
      delete: 'Delete',
    },
    /**
     * Step 1 of the authoring flow. The rank decides everything downstream, so
     * it is asked first — in plain language, not in enum labels.
     */
    kinds: {
      legend: 'What kind of source is this?',
      hint: 'The kind decides what the catalog needs from you and where the agent files the entry.',
      required: 'Pick the kind of source — everything else follows from it.',
      bundesgesetz: {
        label: 'Federal act',
        description: 'Applies across Austria. Found in RIS.',
      },
      landesgesetz: {
        label: 'State building act',
        description: 'The building law of one federal state. Found in RIS.',
      },
      verordnung: {
        label: 'Ordinance or directive',
        description: 'Made binding by ordinance — e.g. an OIB directive. Found in RIS.',
      },
      behoerdliche_info: {
        label: 'Authority guidance',
        description: 'Practice guidance from an authority (e.g. an MA 37 leaflet). Not law, not in RIS.',
      },
      norm_extern: {
        label: 'External standard',
        description: 'ÖNORM, TRVB, EU standard — usually without accessible full text. Not in RIS.',
      },
    },
    steps: {
      find: 'Find the norm in RIS',
      findHint: 'Search and pick a hit — document number, links and verification date fill themselves.',
      source: 'Title and source',
      sourceHint: 'This kind has no RIS entry, so the link is the source of truth.',
      usage: 'How the agent uses it',
      usageHint: 'These fields change the answers the agent gives.',
      advanced: 'Advanced',
      advancedHint:
        'Rarely needed. Every stored field stays editable here — including the ones the RIS search fills.',
    },
    delete: {
      title: 'Delete entry?',
      description: 'The entry leaves the catalog. It takes effect only once you save.',
      confirm: 'Delete',
      cancel: 'Cancel',
    },
    fields: {
      id: 'Catalog ID',
      idHint: 'Stable key of the entry. Derived from the short name; change it only before the first save.',
      idPlaceholder: 'e.g. oib-rl2-2023',
      idDerived: 'Catalog ID: {id} — change it under Advanced.',
      short: 'Short name (abbreviation)',
      shortHint: 'How the agent names this source in an answer, e.g. “OIB-RL 2”.',
      shortPlaceholder: 'e.g. OIB-RL 2',
      title: 'Title',
      titleHint: 'The full title as the source itself carries it.',
      titleRisHint: 'Taken from the RIS hit — shorten it if the version suffix is not wanted in citations.',
      titlePlaceholder: 'Full title of the norm',
      rank: 'Rank',
      bundesland: 'Federal state',
      bundeslandHint: 'Canonical name (e.g. Wien) — leave empty if it applies nationwide',
      bundeslandRequired: 'Canonical name (e.g. Wien). A state act cannot be placed without it.',
      bundeslandPlaceholder: 'Wien',
      application: 'RIS application (Anwendung)',
      applicationHint:
        'Which RIS body of law is searched: BrKons = consolidated federal law, LrKons = consolidated state law. Filled in from the kind.',
      applicationPlaceholder: 'e.g. LrKons / BrKons',
      relevance: 'Relevance',
      relevanceHint: 'How strongly the agent should weigh this source, e.g. high / medium.',
      relevancePlaceholder: 'e.g. high',
      topics: 'Topics',
      topicsHint: 'Comma-separated — the agent reaches for this entry on these subjects.',
      topicsPlaceholder: 'Fire safety, escape routes',
      aliases: 'Aliases',
      aliasesHint: 'Comma-separated — alternative names the entry is also recognised under',
      aliasesPlaceholder: 'OIB 2, Richtlinie 2',
      documentNumber: 'Document number (Dokumentnummer)',
      documentNumberHint:
        'The RIS identifier of exactly this version, e.g. NOR40251234. Normally filled in by the RIS search.',
      documentNumberPlaceholder: 'NOR40251234',
      verifiedAt: 'Verified on',
      verifiedAtHint: 'Date of the last RIS check. Set by the search — older than 12 months counts as stale.',
      verifiedAtPlaceholder: 'YYYY-MM-DD',
      citationUrl: 'Citation link (this version)',
      citationUrlHint: 'Points at exactly this RIS version — the address the agent puts under a citation.',
      citationUrlPlaceholder: 'https://ris.bka.gv.at/Dokument.wxe?…',
      fullLawUrl: 'Full-text link (version in force)',
      fullLawUrlHint: 'Points at the consolidated text currently in force — for reading on in the act.',
      fullLawUrlPlaceholder: 'https://ris.bka.gv.at/GeltendeFassung.wxe?…',
      sourceUrl: 'Source link (outside RIS)',
      sourceUrlHint: 'Direct link to the source itself, e.g. an MA 37 leaflet or an Austrian Standards page.',
      sourceUrlPlaceholder: 'https://www.wien.gv.at/…',
      urlPlaceholder: 'https://…',
      bindingNote: 'Legal note for the agent',
      bindingNoteBadge: 'Goes into the agent’s prompt',
      bindingNoteHint:
        'This text is inserted verbatim into the agent’s prompt. Put here what the full texts cannot say — e.g. that the WBTV makes the OIB directives binding in Vienna. Leave empty if nothing special applies.',
      bindingNotePlaceholder: 'e.g. Made binding in Vienna by § 118 (3) BO via the WBTV 2015.',
      reviewNote: 'Review note',
      reviewNoteHint: 'Internal review task — never appears in the prompt',
      titleQuery: 'Stored RIS query',
      titleQueryHint: 'The query a later re-verification starts from.',
      titleQueryPlaceholder: 'RIS title search',
      gesetzesnummer: 'Law number (Gesetzesnummer)',
      gesetzesnummerHint:
        'The RIS-internal number of the act across all its versions, e.g. 20001234. Narrows down ambiguous titles.',
      gesetzesnummerPlaceholder: 'e.g. 20001234',
      expect: 'Expected in the title',
      expectHint: 'Only hits whose title contains this text are offered.',
      exclude: 'Excluded from the title',
      excludeHint: 'Comma-separated — hits carrying these words are dropped (e.g. Entwurf).',
      excludePlaceholder: 'comma-separated',
      optional: 'optional',
    },
    errors: {
      required: 'Required',
      duplicateId: 'The ID “{id}” is already taken',
      lawNeedsRis: 'No RIS hit taken over yet — search for the norm and pick a version.',
      needApplication: 'A law needs a RIS application',
      needDocumentNumber: 'A law needs a document number from RIS',
      needBundesland: 'A state act needs the federal state it belongs to',
    },
    verify: {
      searchLabel: 'Title in RIS',
      searchHint: 'Type the title the way RIS carries it — you then pick the right version from the hits.',
      searchPlaceholder: 'e.g. Bauordnung für Wien',
      scope: 'Searched in: {application}',
      action: 'Search RIS',
      candidate: 'Apply {title}',
      missingInput: 'A title and a RIS application are needed to search',
      noHits: 'No RIS matches found',
      noCandidates: 'No candidates',
      failed: 'RIS verification failed',
      applied: 'Candidate applied',
      appliedTitle: 'Applied:',
      confirmedTitle: 'Taken over from RIS',
      again: 'Search again',
      stale: 'Last verified more than 12 months ago — search again.',
      seedTitle: 'RIS query stored on the entry',
      seedHint: 'Disambiguators the next verification reuses. Usually nothing to do here.',
      notInRis: 'Not in RIS — maintain the source as a plain link.',
    },
  },
  /**
   * Platform → workflows, rebuilt on the shared admin primitives (SectionCard +
   * DataToolbar + Table + Sheet). Scoped as `platform.workflowsSection` so the
   * component can bind the namespace once and call short keys.
   */
  workflowsSection: {
    title: 'Workflow templates',
    explainer:
      'Curated research briefs published into every organization’s Workflows gallery. A published template appears for every org; selecting it there only pre-fills the workflow builder — it never runs automatically.',
    new: 'New template',
    import: 'Import JSON',
    // Import is a deliberate action now: the dropzone lives behind this dialog
    // instead of sitting above the list on every visit.
    importTitle: 'Import a template',
    importDescription:
      'Load a template JSON export. It opens the editor pre-filled as an unpublished draft — nothing is saved until you save it.',
    dropTitle: 'Drop a JSON file here',
    dropActive: 'Release to import',
    dropHint: 'Or click to choose a file.',
    importCancel: 'Cancel',
    importLoaded: 'Template file loaded — review and save.',
    importInvalid: 'That file is not a valid template export.',
    // Toolbar.
    search: 'Filter templates…',
    searchLabel: 'Filter templates',
    searchClear: 'Clear filter',
    filterLabel: 'Publish state',
    filterAll: 'All states',
    filterPublished: 'Published only',
    filterDraft: 'Drafts only',
    // Table.
    columns: {
      name: 'Template',
      category: 'Category',
      provenance: 'Tint',
      dataSources: 'Data sources',
      cadence: 'Cadence',
      published: 'Published',
      actions: 'Actions',
    },
    rowActions: 'Actions for “{name}”',
    editAria: 'Edit “{name}”',
    manualCadence: 'On demand',
    noCategory: '—',
    baseKnowledgeOnly: 'Base knowledge only',
    moreSources: '+{count}',
    // Section states.
    loadError: 'The templates could not be loaded.',
    emptyTitle: 'No templates yet',
    emptyDescription:
      'Author a research brief here and publish it to put it in front of every organization.',
    noMatchTitle: 'No template matches',
    noMatchDescription: 'Nothing matches this search and publish-state filter.',
    clearFilters: 'Clear filters',
    range: '{from}–{to} of {total}',
    previous: 'Previous',
    next: 'Next',
    // Publish toggle.
    published: 'Published',
    draft: 'Draft',
    publishAria: 'Publish “{name}” to every organization',
    unpublishAria: 'Unpublish “{name}”',
    publishSuccess: 'Template published to every organization.',
    unpublishSuccess: 'Template unpublished.',
    publishFailed: 'The publish state could not be changed.',
    // Row menu.
    edit: 'Edit',
    export: 'Export as JSON',
    delete: 'Delete',
    // Toasts.
    createSuccess: 'Template created.',
    updateSuccess: 'Template updated.',
    saveFailed: 'The template could not be saved.',
    deleteSuccess: 'Template deleted.',
    deleteFailed: 'The template could not be deleted.',
    // Delete confirmation.
    deleteTitle: 'Delete “{name}”?',
    deleteDescription:
      'This removes the template from every organization’s gallery. Workflows already created from it are unaffected. This cannot be undone.',
    deleteConfirm: 'Delete template',
    deleteCancel: 'Cancel',
    // Provenance tint labels (shared by the table and the editor).
    provenance: {
      law: 'Regulation',
      project: 'Project',
      office: 'Office',
      auto: 'General',
    },
    form: {
      createTitle: 'New workflow template',
      editTitle: 'Edit workflow template',
      subtitle: 'Author the brief in German and English — the gallery shows the viewer’s language.',
      close: 'Close editor',
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
      locale: {
        de: 'German',
        en: 'English',
      },
      nameLabel: 'Name',
      descriptionLabel: 'Short description',
      categoryLabel: 'Category label',
      categoryHint: 'Short pill shown on the gallery card, e.g. “Compliance”.',
      objectiveLabel: 'Objective',
      contextLabel: 'Background & context',
      questionsLabel: 'Research questions',
      questionsHint: 'One question per line.',
      outputFormatLabel: 'Output requirements',
      previewLabel: 'Compiled brief (what the agent receives)',
      previewEmpty: 'Fill in the objective to see the compiled brief.',
      publishLabel: 'Published',
      publishHint: 'When on, this template is visible in every organization’s gallery.',
      // Names the language that is incomplete — the form also switches to that
      // tab, so the message and the view agree.
      requiredError: '{locale}: name, short description, category label and objective are all required.',
      cancel: 'Cancel',
      save: 'Save template',
      saving: 'Saving…',
    },
  },
  overview: {
    search: 'Search organizations…',
    searchLabel: 'Search organizations',
    searchClear: 'Clear search',
    sortBy: 'Sort by {column}',
    range: '{from}–{to} of {total}',
    previous: 'Previous',
    next: 'Next',
    noMatches: 'No organization matches this search.',
    noMatchesHint: 'Try a different name, or clear the search to see every organization.',
    emptyHint: 'Organizations appear here as soon as the first one is created.',
    // The directory reads one page from WorkOS. Saying so beats a bare "100+".
    cappedTile: 'First {count} — more exist',
    cappedNote:
      'Only the first {count} organizations could be loaded from the directory. Search, sorting and the totals above cover those.',
  },
  // The maintenance surface (the orphaned-vector sweep). Its own namespace, so
  // the explainer, the confirm and the last-run summary can be read — and
  // translated — as one continuous voice.
  vectorMaintenance: {
    title: 'Vector maintenance',
    description:
      'Reconcile the shared vector store against the document catalog, and delete indexed chunks whose document no longer exists.',
    // The operator who needs this page is, by definition, confused about why
    // retrieval disagrees with the catalog — so the answer lives here.
    howTitle: 'What reconciling does',
    howBody:
      'Deleting a document is two steps: drop its indexed chunks from the vector store, then drop its row from the catalog. When the first step is skipped or fails, the row disappears but the chunks stay behind — invisible everywhere in the app, yet still eligible to be retrieved and cited. Reconciling walks every collection, compares it against the catalog, and deletes the chunks no document owns any more.',
    whenTitle: 'When you need it',
    whenBody:
      'Run it when an answer cites a document nobody can find, when a deleted file keeps reappearing as a source, or after a bulk delete that reported errors. Repeating it is harmless: on a healthy store it finds nothing and deletes nothing.',
    scopeTitle: 'What it never touches',
    scopeBody:
      'Any file with a catalog row counts as live — including one still indexing, or one whose indexing failed — and is left alone. Collections with no rows at all, such as the separately managed OIB base corpus, are skipped entirely.',
    run: 'Reconcile orphaned vectors',
    running: 'Reconciling…',
    confirmTitle: 'Reconcile orphaned vectors?',
    confirmDescription:
      'Every collection on the platform is scanned, and every chunk without an owning document is deleted from the shared vector store.',
    confirmWarning:
      'This runs across all organizations at once and cannot be undone. An orphaned chunk’s document row is already gone, so re-uploading restores nothing.',
    confirmCta: 'Run reconcile',
    cancel: 'Cancel',
    lastRunTitle: 'Last run',
    lastRunHint: 'Runs are not recorded — this covers what you start from this page.',
    neverRunTitle: 'No sweep run yet',
    neverRunBody: 'Start a reconcile to see how many collections were scanned and exactly what was removed.',
    colMeasure: 'Measure',
    colCount: 'Count',
    measureCollections: 'Collections scanned',
    measureCollectionsHint: 'Collections holding at least one catalogued document.',
    measureFound: 'Orphans found',
    measureFoundHint: 'Indexed files with no owning document row.',
    measureDeleted: 'Chunks removed',
    measureDeletedHint: 'Chunks the vector store confirmed it deleted.',
    outcomeRemoved: 'Removed {chunks} orphaned chunk(s) across {collections} collection(s).',
    outcomeClean: 'Nothing to clean up — every indexed chunk still has its document.',
    failuresTitle: '{count} collection(s) could not be reconciled',
    failuresHint: 'The sweep continued past these. They stay unreconciled until a later run succeeds.',
    colCollection: 'Collection',
    colError: 'Reason',
    failed: 'Reconcile failed',
    failedHint: 'The request did not complete, so nothing was deleted. Please try again.',
  },
  nav: {
    label: 'Platform sections',
    overview: 'Overview',
    models: 'Models',
    retrieval: 'Retrieval',
    quality: 'Answer quality',
    knowledge: 'Base knowledge',
    norms: 'Norm catalog',
    workflows: 'Workflow templates',
    storage: 'Storage',
    maintenance: 'Maintenance',
  },
  answerFeedback: {
    title: 'Answer feedback',
    subtitle: 'What users thought of their answers over the last {days} days — what landed, what missed, and the questions behind both.',
    refresh: 'Refresh',
    export: 'Export CSV',
    digest: {
      title: 'Summary',
      generated: 'Written by AI · {ago}',
      regenerate: 'Write a new summary',
      working: 'What is working',
      workingNone: 'Nothing in this window stands out as working well.',
      attention: 'What needs attention',
      attentionNone: 'Nothing in this window stands out as a problem.',
      nextStep: 'Next step:',
      caveat: 'Based on {votes} voluntary ratings over {days} days. Rating is optional, so this describes the people who rated — not every answer.',
      emptyNoFeedback: 'No ratings in this window, so there is nothing to summarise yet.',
      emptyTooFew: 'Too few ratings in this window for a summary that would mean anything.',
      unavailable: 'The summary could not be written just now. The figures below are unaffected.',
    },
    trendHeading: 'Direction',
    trendAria: 'Daily share of votes that were helpful',
    trendBetter: '{points} points better',
    trendWorse: '{points} points worse',
    trendFlat: 'Roughly flat',
    trendAverageMark: 'avg',
    legendRate: 'Helpful share per day',
    legendSparse: 'Under {min} votes — not measured',
    legendAverage: 'Window average ({pct}%)',
    legendVolume: 'Votes that day',
    trendPoint: '{pct}% helpful of {votes} votes',
    trendPointUnreadable: 'only {votes} votes — no rate',
    trendTooSparse: 'Not enough days with {min}+ votes to show a direction yet.',
    windowLabel: 'Time window',
    windowDays: 'Last {count} days',
    searchPlaceholder: 'Search questions and answers…',
    clearFilters: 'Clear filters',
    filteredNote: 'Filtered — the figures above describe the current selection.',
    helpfulRate: 'of votes were helpful',
    up: 'helpful',
    down: 'not helpful',
    percent: '{value}%',
    downFromVoters: 'not helpful, from {voters} people',
    coverage: '{votes} votes on {answers} answers — {pct}% of answers were rated',
    orgsHeading: 'By organization',
    orgVotes: '{votes} votes',
    topicsHeading: 'By topic',
    topicsCaveat: 'Only conversations that carry a topic tag appear here, so these do not add up to the totals above.',
    topics: {
      brandschutz: 'Fire safety',
      schallschutz: 'Sound insulation',
      barrierefreiheit: 'Accessibility',
      energie: 'Energy & thermal',
      statik: 'Structural',
      hygiene: 'Hygiene & environment',
      nutzungssicherheit: 'Safety in use',
      allgemein: 'General',
    },
    tooFewShort: 'n/a',
    tooFewVotes: 'Fewer than {min} votes — too few for a rate to mean anything.',
    reasonsHeading: 'Why it missed',
    reasons: {
      inaccurate: 'Inaccurate',
      wrong_source: 'Wrong source',
      too_slow: 'Too slow',
      other: 'Other',
    },
    verdictLabel: 'Which answers to list',
    showMissed: 'Missed',
    showLanded: 'Landed',
    missedHeading: 'Answers that missed',
    landedHeading: 'Answers that landed',
    landedChip: 'Helpful',
    noMissed: 'No negative feedback in this window.',
    noLanded: 'No helpful ratings in this window.',
    turnUnavailable: 'This turn was not stored, so the question cannot be shown.',
    emptyTitle: 'No feedback yet',
    emptyBody: 'Once users rate answers, the ratings and the questions behind them appear here.',
    errorTitle: 'Answer feedback could not be loaded',
    errorBody: 'The platform feedback read failed. Try again in a moment.',
  },
  sections: {
    overview: {
      title: 'Overview',
      subtitle: 'Every organization on the platform, with projects and LLM spend.',
    },
    models: {
      title: 'Models',
      subtitle: 'The default model every organization runs on until it picks its own.',
    },
    retrieval: {
      title: 'Retrieval',
      subtitle: 'How many hits each search fetches and merges — fleet-wide, effective on the next request.',
    },
    quality: {
      title: 'Answer quality',
      subtitle: 'How well answers are grounded, what users thought of them, and the execution timeline behind any turn that was not.',
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
    storage: {
      title: 'Storage',
      subtitle:
        'Stored bytes per organization, and the quota that bounds each one.',
    },
    maintenance: {
      title: 'Maintenance',
      subtitle: 'Vector-store upkeep. Only needed when retrieval and the corpus have drifted apart.',
    },
  },
  /** Platform → models: the fleet-wide default model per agent group. */
  models: {
    title: 'Default models',
    description:
      'The model each part of the agent runs on. Changing one here moves every organization that has not chosen its own model for that part — on their next message, with no deployment.',
    // Per-group state.
    pinnedBadge: 'Platform default',
    yamlBadge: 'Workflow config',
    unknownFallback: 'Workflow config',
    change: 'Change',
    clear: 'Back to the workflow config',
    zdrWarning:
      'No zero-data-retention endpoint — organizations with that policy on keep their own model instead.',
    noZdr: 'No zero-data-retention endpoint',
    // Thinking level per group — the second lever on the same row.
    effortPinnedBadge: 'Platform level',
    effortInherit: 'Workflow config',
    effortClear: 'Thinking level back to the workflow configuration',
    effortSelectLabel: 'Thinking level for {group}',
    effortSaveError: 'The thinking levels could not be saved.',
    // The levels themselves (OpenRouter vocabulary). The hint names the cost,
    // not just the name — reasoning tokens are invisible until the bill arrives.
    levels: {
      none: {
        label: 'Off',
        hint: 'No hidden thinking. For pure routing and one-liners. Models that must reason reject this level.',
      },
      minimal: { label: 'Minimal', hint: 'The shortest thinking. Fast and cheap.' },
      low: { label: 'Low', hint: 'Little thinking. For quick answers with some deliberation.' },
      medium: { label: 'Medium', hint: 'Balanced — the default for most roles.' },
      high: { label: 'High', hint: 'A lot of thinking. Noticeably more hidden tokens and runtime.' },
      xhigh: {
        label: 'Very high',
        hint: 'Maximum thinking. Multiplies cost and runtime across hundreds of agent steps.',
      },
    },
    // Picker.
    searchPlaceholder: 'Search models…',
    contextWindow: 'Context',
    noResults: 'No suitable model found.',
    // Save.
    unsavedChanges: 'Unsaved changes.',
    note: 'Note',
    notePlaceholder: 'Why this change? (optional)',
    save: 'Save defaults',
    saving: 'Saving…',
    discard: 'Discard',
    saved: 'Default models saved.',
    saveError: 'Could not save the default models.',
    loadError: 'Could not load the default models.',
    confirmTitle: 'Change the default for every organization?',
    confirmDescription:
      'Every organization that has not picked its own model for these parts of the agent switches over on its next message. Organizations with their own choice are unaffected. Changed thinking levels apply to EVERY organization — higher levels multiply hidden reasoning tokens and runtime.',
    confirmSave: 'Change defaults',
  },
  /** Platform → retrieval: the fleet-wide retrieval depths (chunks/results per search). */
  retrieval: {
    title: 'Retrieval depths',
    description:
      'How many chunks and results the individual searches fetch and merge. Changing one here applies to every organization — on its next request, with no deployment.',
    // Per-setting state.
    pinnedBadge: 'Adjusted',
    defaultBadge: 'Default',
    defaultHint: 'Default: {value}',
    rangeHint: '{min}–{max}',
    reset: 'Back to default',
    updatedBy: 'by {email}',
    // Save.
    unsavedChanges: 'Unsaved changes.',
    note: 'Note',
    notePlaceholder: 'Why this change? (optional)',
    save: 'Save settings',
    saving: 'Saving…',
    discard: 'Discard',
    saved: 'Retrieval settings saved.',
    saveError: 'Could not save the retrieval settings.',
    loadError: 'Could not load the retrieval settings.',
    invalidValue: 'Invalid value',
    confirmTitle: 'Change retrieval depth for every organization?',
    confirmDescription:
      'More hits deepen every organization’s research, but also raise latency and token cost per request. The change applies on the next request.',
    confirmSave: 'Change settings',
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
          '{citations} citation(s) across {turns} turn(s) were removed, {share}% of them because the cited source was not among the sources retrieval returned on that turn — and {unheld} of those sources are held nowhere on the platform, so the model is citing from memory.',
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
      description:
        'Citation findings per UTC day over the last {days} days. One turn can carry several findings, so the bars count findings, not turns.',
      turns: '{count} turns',
      findings: '{count} findings',
      flagged: '{count} flagged',
      empty: 'No citation findings in this window.',
    },
    missingTitle: 'Sources answers could not prove',
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
  /** Storage: every tenant's consumption and the quota that bounds it. */
  storage: {
    title: 'Document storage',
    description:
      'Stored bytes per organization, and the quota that refuses further uploads. Quotas are a platform control — tenants can see their own number but never change it.',
    totals: '{used} stored across {orgs} organizations',
    columnOrg: 'Organization',
    columnUsed: 'Used',
    columnQuota: 'Quota',
    unlimited: 'Unlimited',
    inherited: 'Platform default',
    rowDocuments: '{count} documents',
    rowOver: 'Quota reached — uploads refused',
    rowNear: 'Almost full',
    edit: 'Edit quota for {org}',
    save: 'Save quota',
    cancel: 'Cancel',
    saved: 'Quota updated.',
    saveError: 'Could not update the quota.',
    belowUsage: 'That quota is below what the organization already stores. Free space first.',
    loadError: 'Could not load storage usage.',
    empty: 'No organization has stored anything yet.',
    hint: 'Leave the field empty to remove the limit. A quota below current usage is refused — it would strand the tenant with no way to fix it.',
  },

}
