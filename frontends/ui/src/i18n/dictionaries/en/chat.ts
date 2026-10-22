/** chat namespace — populated during component i18n. */
export const chat = {
  actions: {
    dismiss: 'Dismiss',
  },
  effortDial: {
    title: 'Effort',
    trigger: 'Effort: {level}',
    faster: 'Faster',
    smarter: 'Smarter',
    help: 'How long Piloti thinks before it answers. More effort helps with tricky questions but costs time and tokens. Applies to this chat.',
    maximumWarning:
      'Rarely smarter than High. Piloti thinks far longer, costs far more tokens and tends to overthink.',
    levels: {
      minimal: 'Minimal',
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      xhigh: 'Maximum',
    },
  },

  // Source preview (WS-9, FB-4): citation chips open a preview of the source.
  sourcePreview: {
    chipAria: 'Preview source: {label}',
    view: 'View',
    // Document-type chip in the preview dialog header.
    projectDocument: 'Project document',
    corpusDocument: 'Building law & guidelines',
    risDocument: 'Legal source (RIS)',
    // Tinted box with the passage the answer cites.
    citedPassage: 'Cited passage',
    // Marks a source the report actually cited (vs. merely discovered).
    cited: 'Cited',
    loadFailed: 'The source preview could not be loaded. Please try again.',
    // Bindingness note (how a RIS source binds the project) in the info popover.
    bindingLabel: 'Binding effect',
    // The German legal terms are kept even in the English UI — they are the
    // terms of art an Austrian architect works in, and translating "verbindlich
    // erklärt" to "declared binding" loses the phrase they would search for.
    binding: {
      binding: 'Bindend',
      declared_binding: 'Verbindlich erklärt',
      interpretive: 'Auslegend',
    },
    openExternal: 'Open in RIS',
    // Office files (Word, Excel, PowerPoint, ODF, RTF) are shown as a PDF Piloti
    // renders from the original (ADR-0070); the original stays untouched and
    // downloadable.
    renditionNote: 'PDF preview of the original',
    renditionPending: 'Creating PDF preview…',
    downloadOriginal: 'Download original',
    // Coarse source kind (ADR-0026) shown in the info popover. Preferred
    // over `origins` because the origin token is kb/ris/web only, so a
    // knowledge-base copy of a legal text reads as project material.
    kinds: {
      building_law: 'Building law & guidelines',
      office: 'Office filing',
      project: 'Project knowledge',
      praezedenz: 'Precedent',
      web: 'Web source',
    },
    // Origin line in the info popover (no openable document).
    origins: {
      kb: 'Project knowledge',
      ris: 'Law & guidelines (RIS)',
      web: 'Web source',
    },
  },
  // Document grid: real project/Büroablage files the assistant surfaced as
  // clickable preview cards (the `document_grid` card / `surface_documents` tool).
  documentGrid: {
    // Count pill — singular/plural chosen in the component (no ICU in this i18n).
    countOne: '1 document',
    countOther: '{count} documents',
    forQuery: '“{query}”',
    // Provenance badge on a card.
    source: {
      project: 'Project',
      office: 'Office',
    },
    // A surfaced file that no longer resolves to a live document row — an honest,
    // actionable card (the assistant referenced it; open in Office filing / project
    // files) rather than a silent dead tile.
    unresolvedHint: 'The assistant referenced this file.',
    openInOfficeShelf: 'Open in Office filing',
    openInFiles: 'Open in project files',
    // The resolve fetch failed — a retry affordance, not a permanent dead tile.
    loadError: 'Documents couldn’t be loaded.',
    retry: 'Try again',
    openAria: 'Open document: {label}',
    thisFile: 'This file',
    choose: 'Which file?',
    // Quiet receipt when the card opened exactly one file beside the chat.
    showing: 'Showing {label}',
  },
  // Composer (InputArea) control row — WS-3 click-dummy overhaul.
  // A file the answer names in its running prose ("Start with pd8280-2.pdf") —
  // not evidence, but a pointer at a document the reader owns. Clicking it
  // opens the document beside the answer.
  fileReference: {
    openAria: 'Open file: {name}',
    // The document the agent can read: opening it is also the composer saying
    // the next question is about it, and a label naming only half of that is a
    // control that surprises the reader it was written for.
    openAskAria: 'Open {name} and ask about it',
    open: 'Open beside the answer',
    openAsk: 'Open and ask about it',
    pages: '{count, plural, one {# page} other {# pages}}',
    // Shown when the answer spelled the name differently from the file itself.
    writtenAs: 'In the text: {name}',
    // Which shelf the file came from — the same distinction the sources draw:
    // shared project knowledge, Office filing, a private attachment.
    shelf: {
      project: 'Project files',
      office: 'Office filing',
      session: 'Attachment in this chat',
    },
    notIndexed: 'Filed, not read. You can open it, but Piloti does not cite it.',
    failed: 'Reading failed. Piloti cannot cite this file.',
    // Held back by the content check (ADR-0086); never "release".
    held: 'Held back: the content check keeps this file from Piloti. Piloti cites it only once someone allows it through.',
  },
  composer: {
    /** Shown when the reader holds project:view but not project:chat. */
    noProjectChatPermission:
      'Piloti is unavailable in this project for you right now. If you have read-only access, a project admin can grant you the Contributor role.',
    placeholder: 'Ask Piloti about this project …',
    sources: 'Data basis',
    sourcesAria: 'Data basis — {enabled} of {total} sources enabled. Opens the data sources panel.',
    scopeAria: 'Search scope: {project}',
    scopeFallback: 'This project',
    scopeCurrent: 'Current project',
    scopeAll: 'All projects',
    scopeAllSoon: 'Coming soon — cross-project search is not available yet.',
    // Mobile-only cue: the source/scope labels collapse to icons on phones, so a
    // tiny one-line hint under the composer keeps the active source count legible.
    sourcesActiveMobile: '{count, plural, one {# source} other {# sources}} active',
  },
  // Voice dictation in the composer (features/dictation).
  dictation: {
    start: 'Dictate',
    startHint: 'Speak, and Piloti writes it into your message. Stops after {seconds} seconds.',
    stop: 'Stop and insert',
    recording: 'Recording, {elapsed}',
    transcribing: 'Transcribing …',
    unavailable: {
      unsupported: 'This browser cannot record from a microphone.',
      insecure: 'Voice input needs a secure (https) connection.',
      noFormat: 'This browser records no audio format Piloti can transcribe.',
      denied: 'Microphone access is blocked. Allow it in the browser’s site settings, then reload.',
    },
    errors: {
      noMicrophone: 'No microphone was found.',
      denied: 'Microphone access was not allowed.',
      rateLimited: 'Too many recordings in a short time. Try again in a minute.',
      tooLarge: 'The recording is too large to transcribe.',
      notConfigured: 'Voice input is not available right now.',
      failed: 'The recording could not be transcribed. Your message is unchanged.',
    },
  },
  // Source-preset shortcut chips under the composer (empty thread).
  // A source card's provenance tab in the Herleitung: the coarse stratum when
  // the backend named no fine lane, and the shelf the wire stated.
  sourceTabs: {
    law: 'Building law',
    project: 'Project knowledge',
    office: 'Office filing',
    auto: 'Web',
    model: 'Model measurement',
    shelves: {
      office_shelf: 'Office filing',
      project: 'Project knowledge',
      session: 'Private session',
      base: 'Base knowledge',
    },
    // A document's fine lane (`norm_registry`) in the reader's language: the
    // backend sends it in German only (`laneLabel`). Project, office filing
    // and web are not here; the shelf above says them.
    lanes: {
      building_law_oib: 'OIB guideline',
      building_law_oib_guide: 'OIB guide',
      building_law_oib_explanatory_note: 'OIB explanatory note',
      building_law_oib_definitions: 'OIB definitions',
      building_law_oib_reference: 'OIB referenced standards',
      building_law_oib_amendment: 'OIB amendment',
      building_law_ris: 'Legal source (RIS)',
      building_law_base: 'Base document',
      building_law_federal: 'Federal law',
      building_law_state: 'State law',
      building_law_ordinance: 'Ordinance',
      authority: 'Official information',
      external_standard: 'External standard',
      office_piloti: 'Piloti document',
      measurement: 'Model measurement',
    },
  },
  shortcuts: {
    label: 'Shortcuts',
    presetAria: 'Source preset: {label}',
    presets: {
      law: 'Building law & guidelines',
      project: 'Project documents',
      office: 'Office filing',
    },
  },
  // Time-of-day greeting on the empty chat state.
  greeting: {
    morning: 'Good morning',
    afternoon: 'Good afternoon',
    evening: 'Good evening',
    withName: '{greeting}, {name}.',
    // The empty canvas inside a project says ONE thing about itself: that
    // Piloti writes as well as answers. Otherwise the only people who find out
    // are the ones who happen to phrase a request as a commission (ledger 23).
    // Project-only, because without a project there is nowhere for a draft to
    // be filed.
    projectWrites:
      'Piloti does more than answer — ask, and it writes file notes, memos and drafts straight into the project files.',
  },
  // Thread role tabs (click-dummy overhaul, WS-3).
  roles: {
    input: 'Input',
    result: 'Result',
    // Role tab for a conversational / clarifying reply (routing_decision =
    // 'meta' or answer_meta.kind = 'direct': greetings, capability questions,
    // clarifying Rückfragen) — marks it visibly apart from a substantive
    // Baurecht 'Result'.
    note: 'Note',
    // Walkthrough: a guided answer without a ruling — not the Result document.
    answer: 'Answer',
  },
  // "Belegt durch" provenance chip row under answers that carry source data.
  // The findings matrix over a report: one row per requirement the report
  // read against the project.
  findings: {
    label: 'Findings',
    page: 'p. {page}',
    /** The same table when the report states rows without judging them. */
    labelResults: 'Results',
    columns: {
      requirement: 'Requirement',
      value: 'Value',
      reference: 'Reference',
      status: 'Status',
      note: 'Note',
    },
    status: {
      met: 'met',
      not_met: 'not met',
      open: 'open',
      not_applicable: 'not applicable',
    },
    grounding: { sourced: 'sourced', derived: 'derived', open: 'unsourced' },
    clarify: 'Clarify',
    /** Under the matrix in a closed project, where „Clarify“ would be (ADR-0090). */
    clarifyClosed: 'Closed project: no new research to clarify open findings.',
    commissioned: 'Task created',
    change: {
      new: 'new',
      changed: 'changed',
      dropped: '{count, plural, one {# finding dropped:} other {# findings dropped:}}',
    },
  },
  answerSources: {
    label: 'Sources',
    ariaLabel: 'Sources this answer is backed by',
    // Honest "Lücke" gap row: a substantive answer that cites nothing renders
    // this in the neutral --source-auto family instead of hiding its lack of
    // grounding (design language — first-class knowledge-gap treatment).
    gapLabel: 'Without source citation',
    gapAria: 'This answer cites no sources',
    // The consolidated list numbers each source the way the answer's inline
    // [N] markers do, and shows the cited page after the chip.
    sourceNumber: 'Source {number}',
    page: 'p. {page}',
    pages: 'pp. {pages}',
    // The meta line of a precedent from another project: project, status, then the Land.
    precedentProject: '{name} · {status}',
    projectStatus: { active: 'active', paused: 'paused', closed: 'closed' },
    // Sources past the eight chips fold behind the same control the read
    // sources use: the count first, every name on expand.
    more: '+{count} more',
    less: 'Show fewer',
    clause: 'Sec.\u00A0{clause}',
    clausePage: 'Sec.\u00A0{clause} · p.\u00A0{page}',
    // Citations the user can actually paste somewhere — per source (Fachtext)
    // and for the whole answer in the formats external tools ingest.
    copyCitation: 'Copy citation',
    copied: 'Copied',
    copyCitationAria: 'Copy citation for {label}',
    copyFailed: 'The citation could not be copied.',
    citeAll: 'Cite',
    citeAsLabel: 'Copy all sources as',
    formats: {
      quotes: { label: 'Quoted passages', hint: 'The cited sentences, as a list' },
      fachtext: { label: 'Citation text', hint: 'For a report or submission' },
      apa: { label: 'APA', hint: 'Formatted bibliography' },
      bibtex: { label: 'BibTeX (.bib)', hint: 'LaTeX, JabRef' },
      ris: { label: 'EndNote/Zotero (.ris)', hint: 'Reference managers' },
      'csl-json': { label: 'CSL-JSON', hint: 'Zotero, Word, pandoc' },
    },
    // Note under the sources row when citation verification dropped one or more
    // unverifiable citations (WP-A `citations_removed`).
    citationsRemoved:
      '{count, plural, one {# citation} other {# citations}} removed (not verifiable)',
    citationsRemovedReasonsLabel: 'Reasons',
    // Evidence-gathering was cut off at the iteration ceiling. A statement
    // about the EVIDENCE, not an error and not a verdict on the answer — hence
    // the same register as the sources row above it. Independent of the
    // confidence chip, which grades whether the claims are sourced rather than
    // whether the search ran to the end.
    researchTruncated:
      'The search stopped before it was finished — this answer rests on the evidence gathered up to that point',
    // The same fact for an answer that cites nothing: the sentence above would
    // promise evidence that is not there.
    researchTruncatedWithoutSources:
      'The search stopped before it was finished, and before it had found anything',
    // The search ran and found nothing; the answer is shown anyway (ADR-0125),
    // and this sentence says what it then rests on.
    lookupFoundNothing: 'The search found no sources. This answer rests on general knowledge and is not backed.',
    // WHY it stopped, appended to whichever sentence above applies as a short
    // parenthetical — "it stopped early" is the fact, "it ran out of time" is
    // what tells the reader whether asking again is worth anything.
    //
    // Keyed by the backend's stable token VERBATIM, so the mapping can be
    // checked against the producer by eye. A token this build has no entry for
    // renders nothing at all: a reader must never be shown `wall_clock`.
    truncationReason: {
      wall_clock: 'time limit reached',
      // A timeout from below (provider/transport), not the run's own budget. To
      // the reader both are the same fact: research ended at a time limit. The
      // two are only counted apart internally.
      upstream_timeout: 'time limit reached',
      step_limit: 'step limit reached',
      user_requested: 'stopped at your request',
    },
    // Ways a salvaged answer is weaker than one from a finished run. Same
    // register as the lines above — muted, factual, about the EVIDENCE — but
    // each one names something the reader can act on, which is why they are
    // stated rather than folded into the truncation sentence.
    degradedReason: {
      no_report_file: 'No research report was filed — this answer is the only record of the run',
      no_valid_citations:
        'No citation survived verification — please check the figures yourself before relying on them',
      cards_generation_failed:
        'The report is complete, but the proposals derived from it could not be produced',
      basis_unread:
        'Not every document named as the basis was read — the end of the report lists which',
    },
    // The verification's own reasons for dropping a citation, in the reader's
    // words. The backend states them as tokens (`url_not_in_registry`, …) and
    // they used to reach the tooltip exactly like that; an unmapped one is now
    // left out rather than shown raw.
    citationsRemovedReason: {
      url_not_in_registry: 'URL not among the sources retrieved',
      citation_key_not_in_registry: 'Document not among the sources retrieved',
      unverifiable: 'Nothing checkable in the citation',
      duplicate: 'Duplicate citation',
      ungrounded: 'Claim not backed by a citation',
      quote_unverified: 'Quotation could not be verified',
    },
  },
  // Getting the answer OUT of the app — the paste into a report, a mail, a
  // submission. Two icon buttons in the answer's meta row; the second one only
  // exists when the turn actually resolved sources to write out.
  answerActions: {
    copy: 'Copy answer',
    copyWithSources: 'Copy answer with full source references',
    copied: 'Copied',
    copyFailed: 'The answer could not be copied.',
    // The heading the written-out source list is filed under. Mirrors the
    // heading answers write themselves, so a pasted answer reads the same way
    // whichever button produced it.
    sourcesHeading: 'Sources',
    untitledSource: 'Untitled source',
    downloadDocx: 'Download as Word document',
    downloadFailed: 'The Word document could not be created.',
    // The system share sheet on a phone: the button's name and the shared message's title.
    share: 'Share answer',
    shareTitle: 'Answer from Piloti',
  },
  // The section list of a long answer (a report): on a phone, the way to a
  // section without scrolling back to the top.
  outline: {
    label: 'Sections',
    count: '{count, plural, one {# section} other {# sections}}',
    close: 'Close',
    title: 'Sections',
    description: 'Jump to a section of this answer.',
  },
  // Thread-header breadcrumb (project / session title) with inline rename.
  // The citation peek: what a Fundstelle IS, before you open it.
  citationPeek: {
    pageThumbnail: 'Page {page}',
    thumbnailLoading: 'Drawing the page',
    wholeDocument: 'Whole document',
    openAtPage: 'Open at this passage',
    notOpenable: 'No file for this source is available in Piloti.',
    sheetTitle: 'Source {number}',
    sheetDescription: 'The cited passage and the way into the document.',
    noInlineViewer:
      'This file format cannot be shown inside Piloti. Download the document and open it in your own application.',
    download: 'Download document',
    downloading: 'Preparing…',
    copyLink: 'Copy link',
    copyLinkAria: 'Copy a link to this passage: {label}',
    markerAria: 'Source {number}: {label} — open preview',
    pendingAria: 'Source {number} — being checked',
    lociLabel: '{count, plural, one {# passage} other {# passages}}',
    lociAria: 'Passages in this document',
    lociPosition: '{index}/{count}',
    previousLocus: 'Previous passage',
    nextLocus: 'Next passage',
    retrievedOnly: 'Read',
    // The cited document is a Fassung a person has since replaced. The citation stays true of the file it names;
    // the reader should know before relying on it.
    olderRevision: 'Older revision. Current:',
    openCurrentRevisionAria: 'Open the current revision: {name}',
    currentRevisionUnavailable: 'The current revision cannot be opened.',
  },
  breadcrumb: {
    ariaLabel: 'Conversation breadcrumb',
    renameAria: 'Rename session — click to edit the title',
    renameInputAria: 'Session title',
  },
  cards: {
    askAbout: {
      chip: 'Ask about this',
      chipAria: 'Put a question about "{subject}" into the message box',
      missingWithDetail:
        '"{subject}" is missing a figure: {missing}. How can I supply it, and what applies until then?',
      missingOnly:
        '"{subject}" is missing a figure. Which figure is needed here, and where do I get it?',
    },

    // ── Shared schematic chrome ────────────────────────────────────────────
    // `kit.tsx` draws eight cards. Its vocabulary lives here because it
    // appears on every one of them: verdict, missing figure, provenance.
    kit: {
      eyebrow: 'Sketch',
      status: {
        pass: 'met',
        fail: 'not met',
        warning: 'borderline',
        needsInput: 'figure missing',
      },
      // Stands where a number would stand that nobody knows. Never a guessed
      // number — and never an empty slot, which reads as a fact about the
      // building rather than a gap in the file.
      missingValue: 'no figure given',
      provenance: {
        declared: 'per model',
        computed: 'measured',
        inferred: 'presumed',
      },
      // Long form for the tooltip, where there is room to say what the word means.
      provenanceTitle: {
        declared: 'This number is stated in the IFC file — the architect’s own figure.',
        computed:
          'Measured from the geometry, not declared. The tolerance is part of the statement.',
        inferred: 'Derived from a heuristic. A suggestion to confirm, not a finding.',
      },
      toleranceStraddlesLimit:
        'The measurement tolerance reaches across the limit: at this precision it is undecided whether the value is met. Measure more precisely for a formal check.',
    },
    followUps: {
      eyebrow: 'Ask on',
      groupAria: 'Follow-up questions',
      // The one client-side chip under a long answer: the offer nobody
      // otherwise discovers — Piloti writes, too (ledger 23).
      fileNote: 'Write this up as a file note',
      // What the chip types into the composer. Deliberately not the label: the
      // label is a sentence fragment, not a request. It is prefill and not a
      // command, so the reader can edit it before pressing send.
      fileNotePrefill: 'Write that up as a file note in my project.',
    },
    workReport: {
      eyebrow: 'Where the work stands',
      done: 'Done',
      proposed: 'Proposed, waiting for you',
      blocked: 'Blocked',
      next: 'Next',
      who: 'Who: {who}',
      due: 'by {due}',
    },
    keyTakeaways: {
      eyebrow: 'What matters most',
    },
    callout: {
      note: 'Note',
      warning: 'Caution',
      deadline: 'Deadline',
      tip: 'Tip',
      more: 'More on this',
      less: 'Less',
    },
    // Ein auf wenige Zeilen gekürzter Text, der sich per Tipp öffnen lässt (ClampedText).
    clamp: {
      more: 'Show more',
      less: 'Show less',
    },
    calculation: {
      eyebrow: 'Derivation',
      result: 'Result',
      limitLabel: 'Limit',
      // A range limit, e.g. the Schrittmaßregel's 59–65 cm. Built by the code
      // from two bounds, so the dash and the word order belong here.
      limitRange: '{lower}–{upper} {unit}',
      // An operand that is the result of an earlier step, named under it.
      fromStep: 'from step {step}',
      // Stands where the result would stand. Never a partial number: a
      // derivation missing an input has no result, and printing one anyway is
      // the exact failure this card exists to make impossible.
      undecidable: 'Cannot be derived from the figures given.',
      undefinedResult: 'Divided by zero — the result is not defined.',
      sourcesMore: 'Where the figures come from',
      sourcesLess: 'Less',
      // Said inside the disclosure, where the reader is already checking the
      // inputs: the card did the arithmetic, so what they audit is the inputs.
      computedNote:
        'The result is computed by this card from the figures above, not copied from the answer.',
    },
    // A document Piloti wrote into this conversation's working directory. Not a
    // project document: nothing here is filed, indexed or citable until a
    // person takes it into the project — which is what the (still inert)
    // action under the card will do.
    documentDraft: {
      eyebrow: 'Draft',
      // How often this path has been written in this conversation. Rendered as
      // its own token beside the size, so a locale can drop the „v".
      version: 'v{version}',
      // The stand of a draft written once: a single write is no history, so
      // the card names the state instead of numbering it.
      draftState: 'Draft',
      // The draft lives in this conversation only. "File into the project"
      // files it through the BFF's draft-file door, in the reader's own
      // session — one press, no prompt, no second turn. A same-name document
      // already in the project is a 409 the card answers with an explicit
      // confirmation rather than a silent second copy.
      file: 'File into the project',
      filing: 'Filing …',
      fileError: 'Filing failed. Please try again.',
      fileConflict: 'A document with this name is already in the project.',
      fileAnyway: 'File anyway',
      // The reference filed and a person moved the revision on: nothing to
      // retry and nothing to confirm — the Files pane owns it from here.
      fileSubmitted: 'This draft has already been filed. Continue in Files.',
      // The unfiled draft's reading surface: the bytes live in the agent's
      // working directory, fetched through the BFF draft-preview door. A read,
      // so it writes nothing and stays presentational.
      preview: 'View draft',
      previewLoading: 'Loading the draft …',
      previewError: 'The draft could not be loaded.',
      previewRetry: 'Try again',
      // From here on the document is in the project.
      filed: 'Filed in the project as a draft',
      open: 'Open in the project',
      submit: 'Submit for approval',
      submitting: 'Submitting…',
      submitted: 'Submitted for approval — waiting for a person',
      // A state a person has already set. No button: what happens next is
      // decided in the Files pane.
      inReview: 'In review',
      changesRequested: 'Changes requested',
      approved: 'Approved',
      published: 'Published',
      // A revision a newer one overtook: neither a draft nor an approval —
      // it reads, but it is no longer the current one.
      ersetzt: 'Replaced',
      error: 'Submitting for approval failed. Please try again from Files.',
    },
    // Work Piloti has taken on and will finish after this conversation
    // (ADR-0051). The card offers nothing: the row exists by the time it
    // renders, and the run block below it says how the work is going — so
    // this card is the receipt (what, of what kind, by when) and states no
    // status of its own.
    // Where Piloti looked on a document (ADR-0128): per look the page and the
    // place, and what Piloti showed the room.
    look: {
      eyebrow: 'Looked at',
      looked: 'p. {page}',
      shown: 'Shown on p. {page}',
      wholePage: 'whole page',
      // A reading is what Piloti read off the page, never a measurement (ADR-0125).
      reading: 'Read: {reading}',
      readingNote: 'Read off the page by Piloti, not measured.',
      embeddedImage: 'image {index}',
      open: 'Open {document} at p. {page}',
    },
    // Two Fassungen of a document, the changes boxed on each (ADR-0128, V10).
    revisionCompare: {
      eyebrow: 'Fassungen compared',
      page: 'p. {page}',
      older: 'Older Fassung',
      newer: 'Newer Fassung',
      open: '{side}, p. {page}: open with the changes',
    },
    taskCreated: {
      eyebrow: 'Task',
      due: 'by {date}',
      open: 'Open conversation',
      // The four kinds, in the words somebody would use to ask for them.
      kind: {
        complianceCheck: 'Compliance check',
        submissionCheck: 'Submission check',
        document: 'Document',
        revision: 'Revision',
      },
    },
    // The workspace change Piloti PROPOSED. Nothing has happened until the
    // reader accepts: the agent has no way to write a document row at all, so
    // the card is the whole of what the backend did. Accepting runs the same
    // routes the Files pane runs, in the reader's own session.
    fileOperationProposal: {
      // One eyebrow per verb — the reader should know what kind of change this
      // is before reading a single row of it.
      eyebrow: {
        move: 'Move',
        rename: 'Rename',
        create_folder: 'New folder',
        assign: 'Assign',
      },
      // A move that creates its target folder first: it is named before the rows.
      newFolder: 'New folder',
      // The project root has a path of nothing; it needs a name a person uses.
      root: 'Top level',
      applied: {
        move: '{count, plural, one {File moved.} other {# files moved.}}',
        rename: '{count, plural, one {File renamed.} other {# files renamed.}}',
        create_folder: '{count, plural, one {Folder created.} other {# folders created.}}',
        assign: '{count, plural, one {File assigned.} other {# files assigned.}}',
      },
      // Some entries of a card decided before proposals lived on the server.
      // WHICH is not stored there (a decision is a decision plus a timestamp),
      // so this is all the card can honestly say — and it says where to look.
      partial: 'Applied in part. Some entries could not be applied — check the file list.',
      // A card whose proposal the server holds counts the entries that went
      // through from the result per row.
      partialCount: '{applied} of {total} applied.',
      dismissed: 'Discarded. Nothing was changed.',
      // A card with no stored proposal (an answer from before them, or one the
      // agent could not file). Nothing runs in the browser any more: the
      // proposal still reads, it cannot be applied, and this says why.
      notStored: 'Could not be created as a proposal. Ask Piloti to propose the change again.',
    },
    // A proposal the server holds (ADR-0105), whatever its kind: a file change,
    // a note or a change to the project context. Its status, its result and who
    // decided are read from that object, so every reader sees a colleague's
    // decision.
    proposalReceipt: {
      prompt: 'Apply this?',
      accept: 'Apply',
      reject: 'Discard',
      applying: 'Applying…',
      failed: 'Nothing could be applied. Nothing was changed.',
      applyError: 'Could not be applied.',
      dismissError: 'Could not be discarded.',
      decidedBy: {
        applied: 'Applied by {name} · {when}',
        partially_applied: 'Applied by {name} · {when}',
        failed: 'Tried by {name} · {when}',
        dismissed: 'Discarded by {name} · {when}',
      },
      // The decider's name is not known to this reader.
      someone: 'a colleague',
      // The click arrived after somebody else had decided.
      overtaken: 'This was decided in the meantime.',
      readOnly: 'You can read this proposal, but not apply it in this project.',
      loadError: 'The state of this proposal could not be loaded.',
      memory: {
        confidence: { low: 'Confidence: low', medium: 'Confidence: medium', high: 'Confidence: high' },
        goesInto: {
          organization: "Goes into the office's memory, for every project.",
          project: "Goes into this project's memory.",
        },
        supersedes: 'Replaces: “{note}”',
        onlyInProject: 'Remember in the project only',
        saving: 'Saving…',
        saved: 'Note remembered.',
        // The decided card's headline when it is known where the note went.
        savedIn: { organization: "Remembered in the office's memory.", project: 'Remembered in the project.' },
        dismissed: 'Discarded. Nothing was remembered.',
      },
      profile: {
        applied: 'Project context updated.',
        dismissed: 'Discarded. The project context is unchanged.',
      },
    },
    // An action Piloti PROPOSED through the MCP surface (ADR-0122). Nothing has
    // happened until the reader accepts; accepting runs it in the reader's own
    // session, and the action's route checks the permission.
    operationProposal: {
      eyebrow: 'Action',
      // `{operation}` is the action's technical name; it is not translated.
      operation: 'Action: {operation}',
      inputLabel: 'Inputs',
      // A long value is shortened at first; „Apply“ waits until every one has been read in full.
      showAll: 'Show all ({length} characters)',
      showLess: 'Show less',
      readAllFirst: '{count, plural, one {Read the shortened value in full before you apply.} other {Read the # shortened values in full before you apply.}}',
      targetsLabel: 'Applies to',
      target: {
        project: 'Project {name}',
        document: 'Document {name}',
        folder: 'Folder {name}',
        conversation: 'Conversation {name}',
        bim_model: 'Model {name}',
        upload_batch: 'Upload {name}',
        proposal: 'Proposal {name}',
        inbound_mail: 'Email {name}',
        mail_thread: 'Mail thread {name}',
      },
      applied: 'The action was carried out.',
      dismissed: 'Discarded. The action was not carried out.',
    },
    // What Piloti did on a document: marks it set, threads it answered in.
    // One „take over" or „discard" per mark, and the way into the review at
    // exactly that place.
    canvasActivity: {
      headline: {
        proposed: '{count, plural, one {# annotation proposed} other {# annotations proposed}}',
        repliedOne: 'Replied in the thread of #{number}',
        repliedMany: 'Replied in {count} threads',
        created: '{count, plural, one {# annotation set} other {# annotations set}}',
        changed: '{count, plural, one {# annotation changed} other {# annotations changed}}',
        deleted: '{count, plural, one {# annotation deleted} other {# annotations deleted}}',
        repliedPart: 'replied in {threads, plural, one {one thread} other {# threads}}',
      },
      kinds: {
        hint: 'Note',
        question: 'Question',
        defect: 'Defect',
      },
      page: 'Page {page}',
      repliedIn: 'Reply in the thread of #{number}',
      show: 'Show in document',
      showMarkLabel: 'Show annotation {number} in the document',
      showThreadLabel: 'Show the thread of annotation {number} in the document',
      showError: 'The document could not be opened.',
      accept: 'Take over',
      accepting: 'Taking over …',
      acceptLabel: 'Take over annotation {number}',
      reject: 'Discard',
      rejectLabel: 'Discard annotation {number}',
      state: {
        proposed: 'Proposed',
        open: 'Taken over',
        resolved: 'Resolved',
        dismissed: 'Discarded',
        gone: 'No longer there',
      },
      error: 'Could not be saved.',
      forbidden: 'You cannot change this annotation.',
      // What Piloti changed on a mark at the person's request, in their words:
      // „#4 resolved“, „#4 assigned to Anna“.
      change: {
        taken: 'taken over',
        reopened: 'reopened',
        resolved: 'resolved',
        dismissed: 'discarded',
        assigned: 'assigned to {name}',
        someone: 'someone',
        unassigned: 'assignee removed',
        due: 'due {date}',
        undue: 'due date removed',
        kind: 'marked as {kind}',
        body: 'text reworded',
      },
      status: {
        proposed: 'proposed',
        open: 'open',
        resolved: 'resolved',
        dismissed: 'discarded',
      },
      undo: 'Undo',
      undoing: 'Undoing …',
      undoLabel: 'Undo the change to annotation {number}',
      undone: 'Undone',
      movedSince: 'Changed since, now {state}',
      deleted: 'Annotation #{number} deleted',
      // Who the turn acted for, and why an undo did not happen (ADR-0109).
      forPerson: 'for {name}',
      movedOn: 'Someone changed this in the meantime, so it stays as it is.',
      alreadyUndone: 'Already undone.',
      // Several proposals at once (take over or discard per annotation stays)
      // and the state of the thread at a glance.
      batch: {
        acceptAll: 'Take over all',
        accepting: 'Taking over …',
        rejectRest: 'Discard the rest',
        rejecting: 'Discarding …',
        confirmTitle:
          '{count, plural, one {Discard this annotation?} other {Discard # annotations?}}',
        confirmBody: 'This cannot be undone from here.',
        confirm: 'Discard',
        cancel: 'Cancel',
        already: 'already handled',
        alreadyBy: 'already handled by {name}',
        failed:
          '{count, plural, one {One annotation could not be saved.} other {# annotations could not be saved.}}',
      },
      thread: {
        count: '{count, plural, one {# reply} other {# replies}}',
        last: 'latest {name}: “{excerpt}”',
        someone: 'someone',
      },
    },
    verdictHeader: {
      confidenceHigh: 'high confidence',
      confidenceMedium: 'medium confidence',
      confidenceLow: 'low confidence',
    },
    // ── Labels inside the drawings ─────────────────────────────────────────
    // What is written on the sketch itself. Symbols (±0,00, Ø, N), units and
    // standard designations (A++ … G, DnT,w) are deliberately absent: they are
    // the same mark in every language.
    schematics: {
      daylight: {
        glassArea: 'Glazed area',
        window: 'Window',
        obstruction: '45° daylight angle — {label}',
        requiredArea: 'Floor area {floor} m² → required glazed area ≥ {required} m² (10 %).',
        obstructionPierces: 'The obstruction pierces the 45° daylight cone.',
      },
      egress: {
        totalWalkLength: 'Total travel distance',
      },
      fireAccess: {
        routeWidth: 'Access route width',
        gateClearance: 'Gateway clear height',
        stagingAreaWidth: 'Aufstellfläche width',
        stagingAreaLength: 'Aufstellfläche length',
        facadeDistance: 'Distance to facade',
        walkToEntrance: 'Walk to entrance',
        parcel: 'Parcel {width} × {depth} m',
        route: 'ACCESS',
        building: 'Building',
        stagingArea: 'Aufstellfläche',
        entrance: 'Entrance',
        street: 'STREET',
        buildingClass: 'Gebäudeklasse',
        walkTooFar: ' — the walk to the entrance exceeds the permitted distance.',
      },
      guardrail: {
        context: {
          balcony: 'Balcony',
          loggia: 'Loggia',
          staircase: 'Stairs',
          window: 'Window',
          roof_terrace: 'Roof terrace',
        },
        elevation: 'ELEVATION · {context}',
        fallHeight: 'Fall height',
        railHeight: 'Guardrail height',
        maxOpening: 'max. opening width',
        bottomGap: 'Bottom gap',
        climbGuard: 'No-climb zone 15–60 cm',
        atLeast: ' → min. {value}',
        climbables:
          'Horizontal elements suitable for climbing within the no-climb zone (15–60 cm).',
      },
      setback: {
        side: {
          front: 'front',
          back: 'rear',
          left: 'left',
          right: 'right',
        },
        distance: 'Setback {side}',
        parcel: 'Parcel {width} × {depth} m',
        building: 'Building',
        street: 'STREET',
        tooClose: 'At least one setback falls short of the required distance.',
        stated: 'stated: {value}',
      },
      stair: {
        section: 'SECTION',
        plan: 'PLAN',
        // Step notation as it appears in the section of an Austrian submission.
        stepNotation: '{count} Stg · {rise}/{going} cm',
        // Without rise and going only the count is left.
        stepCount: '{count, plural, one {# step} other {# steps}}',
      },
    },
  },
  agentPrompt: {
    plan: {
      points: 'Sections',
      addPoint: 'Add a section',
      addPlaceholder: 'Add another section …',
      removePoint: 'Remove section: {point}',
      genre: 'Kind of report',
      genres: {
        inspection_report: 'Compliance review',
        file_note: 'Memo',
        comparison: 'Comparison',
        checklist: 'Checklist',
        report: 'Report',
      },
      depth: 'Depth',
      depths: { quick_check: 'Short review', expert_report: 'Full opinion' },
      /** The documents the reader names for the run, and the sources it may use. */
      documents: {
        label: 'Documents',
        basis: 'Read in full:',
        excluded: 'Excluded:',
        none: 'No documents named — the research reads what it finds.',
        choose: 'Choose documents',
        removeRead: 'No longer read in full: {name}',
        removeExcluded: 'No longer excluded: {name}',
      },
      frame: 'Sources',
      frameNote: 'The sources selected in the composer. Change them there before approving.',
    },
    needsInput: 'Piloti needs your input',
    receivedInput: 'Piloti received your input',
    /**
     * Shown to a colleague in a shared thread instead of the buttons: the agent
     * asked one person, and the agent tier refuses an answer from anybody else, so
     * a button here would be offering a refusal. Without this line the card reads
     * as broken rather than as somebody else's turn.
     */
    awaitingOther: 'Piloti is waiting for {name}',
    awaitingSomeone: 'Piloti is waiting for another participant',
    approvePlan: 'Approve plan',
    // The current three-way plan decision (start / answer briefly / cancel).
    startResearch: 'Start research',
    answerShallow: 'Answer briefly instead',
    answerShallowAria: 'Answer the question briefly, without deep research',
    cancelResearch: 'Cancel',
    cancelResearchAria: 'Cancel the research',
    selectOption: 'Select option: {option}',
    yourResponse: 'Your response:',
    approvalInstructionThreeWay:
      'Start the research, have your question answered briefly instead, or cancel.',
    // Duration/cost expectation shown at the decision point, BEFORE approval.
    durationHint: 'Deep research can take several minutes to run and consumes usage quota.',
    // The plan bubble's scaffolding, localized in place of the backend's
    // byte-stable English headers.
    planPreviewHeading: 'Research plan',
    planTitleLabel: 'Title:',
    planSectionsLabel: 'Sections:',
    // What the answered bubble echoes for a clicked decision — the wire
    // keywords (approve/shallow/cancel/reject) never reach the reader.
    responseApproved: 'Research started',
    responseShallow: 'Quick answer requested',
    responseCancelled: 'Research cancelled',
    // An answered plan folds to one line; the plan as approved is behind it.
    planRecord: 'Plan approved · {count, plural, one {# section} other {# sections}}',
    showPlan: 'Show plan',
    hidePlan: 'Hide plan',
  },
  // The single disclosure in the answer footer that holds everything past the
  // sources row and the copy actions (confidence, memory note, skills used,
  // verification notes, feedback, timestamp).
  // Under an answer the reader stopped, where the writing ended.
  answerStoppedMarker: 'Stopped',
  answerDetails: {
    trigger: 'Answer details',
    triggerAria: 'Show details for this answer',
    // The trigger when the details hold a warning (cut-off, salvaged run,
    // stripped citations, low confidence): the dot beside it says so visually.
    triggerAriaAttention: 'Show details for this answer, including notes on it',
    // How long the turn took, question sent to answer final.
    duration: 'Answered in {duration}',
    costCredits: '{value} credits',
    costTokens: '{value} tokens',
    costBreakdown: 'Input {prompt} · output {completion} · of which thinking {reasoning} tokens',
    // Retrieved-but-uncited documents: what the turn read beyond what the
    // answer claims. Document chips only — no passages, no new claims.
    readSources: {
      label: 'Read, not cited',
      more: '+{count} more',
      less: 'Show less',
    },
  },
  profilePatchCard: {
    accept: 'Accept',
    applying: 'Applying...',
    reject: 'Reject',
    accepted: 'Project brief updated.',
    rejected: 'Changes discarded.',
    noProject: 'Open this chat from a project to apply brief changes.',
    field: 'Field',
    before: 'Before',
    after: 'After',
    applyFailed: 'Failed to apply the change',
  },
  memoryProposal: {
    title: 'Save this finding to memory?',
    prompt: 'Do you want to remember this org-wide?',
    yes: 'Yes, remember org-wide',
    no: 'No',
    saving: 'Saving…',
    saveToProject: 'Save to just this project',
    savedOrg: 'Saved to organization memory (org-wide).',
    savedProject: 'Saved to this project’s memory.',
    dismissed: 'Not saved.',
    error: 'Could not save the finding',
    kind: {
      decision: 'Decision',
      constraint: 'Constraint',
      open_question: 'Open question',
      derived_fact: 'Derived fact',
      preference: 'Preference',
    },
  },
  thinking: {
    // One row per document Piloti looked at (ADR-0128); its thumbnails open the place.
    look: {
      place: 'p.\u00A0{page}, {where}',
      placeWhole: 'p.\u00A0{page}',
      // A place on a page in words: the backend sends them in German
      // (`page_region_words.py`); here they stand in the reader's language.
      region: {
        topLeft: 'top left',
        topRight: 'top right',
        topCenter: 'top center',
        bottomLeft: 'bottom left',
        bottomRight: 'bottom right',
        bottomCenter: 'bottom center',
        middleLeft: 'center left',
        middleRight: 'center right',
        pageCenter: 'page center',
      },
    },
    // The Herleitung's work list (ADR-0132): one row per call, grouped into
    // rounds. Sentences are built from the call's typed values, never from a
    // tool's text.
    work: {
      label: 'Work steps',
      // The accessible name of a row that opens a document: the row's sentence.
      open: '{target} – open',
      running: 'running',
      // A call the turn ended under (Stop, an error, a lost connection): no result.
      interrupted: 'interrupted',
      noHit: 'no hit',
      nothingFound: 'nothing found',
      failed: 'failed',
      // After „failed“: what it means for the answer.
      failedNote: 'the answer does not rest on it',
      // More than five calls in one step: the worst first, the rest folded.
      more: '+{count} more',
      moreAllFound: '+{count} more, all with a result',
      fewer: 'Show fewer',
      // Calls of one kind on one row.
      times: '×{count}',
      // Quotes inside a query that itself stands in “…”.
      innerQuote: '‘{text}’',
      // Under a look's crop: read off is not measured.
      readOff: 'read off, not measured',
      // What a step did, from the verbs of its calls.
      kind: {
        search: 'Search',
        read: 'Reading',
        list: 'Open folder',
        look: 'Look',
        model: 'Query the model',
        workspace: 'Workspace',
      },
      shelf: {
        project: 'in the project',
        office: 'in the office filing',
        base: 'in the knowledge base',
        web: 'on the web',
        session: 'in this chat',
      },
      // The verb sits muted before its object: „Searches for the exact phrase“ „“Brandabschnitt” in the project“.
      verb: {
        search: 'Searches for',
        searchExact: 'Searches for the exact phrase',
        searchRegex: 'Searches for the pattern',
        searchIn: 'Searches',
        searchExactIn: 'Searches verbatim in',
        searchRegexIn: 'Searches by pattern in',
        list: 'Opens',
        read: 'Reads',
        look: 'Looks at',
        lookup: 'Searches other projects for',
        law: 'Searches the RIS for',
        web: 'Searches the web for',
        model: 'Queries the building model for',
        workspace: 'Workspace:',
      },
      // The settled head of a turn of exactly one call: what WAS done.
      done: {
        search: 'Searched: {name}',
        list: 'Opened: {name}',
        read: 'Read: {name}',
        look: 'Looked at: {name}',
        lookup: 'Searched other projects: {name}',
        law: 'Searched the RIS: {name}',
        web: 'Searched the web: {name}',
        model: 'Queried the building model: {name}',
        workspace: 'In the workspace: {name}',
      },
      doneFallback: {
        search: 'Searched the documents',
        list: 'Opened a folder',
        read: 'Read a document',
        look: 'Looked at a document',
        lookup: 'Searched other projects',
        law: 'Searched the RIS',
        web: 'Searched the web',
        model: 'Queried the building model',
        workspace: 'Worked in the workspace',
      },
      object: {
        query: '“{query}”',
        queryShelf: '“{query}” {shelf}',
        queryIn: '{target} for “{query}”',
        pages: '{target}, p.\u00A0{pages}',
        clause: '{target}, {pages}',
        where: '{target}, p.\u00A0{pages}, {where}',
      },
      // Calls of one kind on one row. Searches carry no verb: „4 RIS searches“.
      many: {
        documents: '{count, plural, one {#\u00A0document} other {#\u00A0documents}}',
        folders: '{count, plural, one {#\u00A0folder} other {#\u00A0folders}}',
        searches: '{count, plural, one {#\u00A0search} other {#\u00A0searches}}',
        lawSearches: '{count, plural, one {#\u00A0RIS search} other {#\u00A0RIS searches}}',
        webSearches: '{count, plural, one {#\u00A0web search} other {#\u00A0web searches}}',
        lookupSearches:
          '{count, plural, one {#\u00A0search in other projects} other {#\u00A0searches in other projects}}',
        modelQueries:
          '{count, plural, one {#\u00A0building model query} other {#\u00A0building model queries}}',
        workspaceCalls:
          '{count, plural, one {#\u00A0workspace call} other {#\u00A0workspace calls}}',
      },
      fallback: {
        search: 'Searches the documents',
        list: 'Opens a folder',
        read: 'Reads a document',
        look: 'Looks at a document',
        lookup: 'Searches other projects',
        law: 'Searches the RIS',
        web: 'Searches the web',
        model: 'Queries the building model',
        workspace: 'Works in the workspace',
      },
      found: {
        hits: '{count, plural, one {#\u00A0hit} other {#\u00A0hits}}',
        hitsDocuments:
          '{hits, plural, one {#\u00A0hit} other {#\u00A0hits}}\u00A0· {documents, plural, one {#\u00A0document} other {#\u00A0documents}}',
        documents: '{count, plural, one {#\u00A0document} other {#\u00A0documents}}',
        places: '{count, plural, one {#\u00A0passage} other {#\u00A0passages}}',
        listing:
          '{files, plural, one {#\u00A0file} other {#\u00A0files}}, {folders, plural, one {#\u00A0folder} other {#\u00A0folders}}',
        files: '{count, plural, one {#\u00A0file} other {#\u00A0files}}',
        folders: '{count, plural, one {#\u00A0folder} other {#\u00A0folders}}',
      },
    },
    inProgress: 'Thinking in progress',
    working: 'Working on a response …',
    waiting: 'Waiting for response',
    interrupted: 'Interrupted',
    // Compact inline notice on an interrupted turn: a silent reconnect can drop
    // an in-flight answer (protocol-robustness item 4). German copy is the
    // product-facing string; this English fallback is for harnesses/tests.
    // Only once the server has confirmed it has no answer and the turn no longer runs.
    interruptedNotice: 'This answer was not finished, and the server has none. Please send the question again.',
    // Transient "checking" state (FIX 3): shown while the reconnect recovery
    // fetch is in flight, so a turn that only LOOKS interrupted does not flash
    // the "lost" copy before we have confirmed the answer is really gone.
    recovering: 'Fetching the answer',
    recoveringNotice: 'Piloti is still working — the answer appears here as soon as it is ready …',
    done: 'Done',
    // The reader stopped the answer: no green check, no „Done“ — the same
    // word a cancelled run carries.
    stopped: 'Stopped',
    // The turn commissioned a run: its work has only begun, in the run block
    // below. No green check, no „Done“.
    // The turn failed; the error card below says how.
    failed: 'Failed',
    handedOff: 'Task created',
    // Piloti did not take the question on (refused, or not admitted): the
    // banner below says why. Neutral, never „Done“.
    refused: 'Not handled',
    elapsedAria: 'Elapsed: {seconds, plural, one {# second} other {# seconds}}',
    // ── Turn events: the words for what the backend REPORTED ──────────────
    //
    // The agent narrates itself with `status:<slot>` steps, and it narrates in
    // KEYS: a stable dotted id plus interpolation values. Everything a reader
    // sees is written here, in their locale. It used to be written in the
    // Python and shipped as a finished German sentence, which is how an
    // English-locale reader read German.
    //
    // A key with no entry here renders NOTHING — the live line falls back to
    // the previous meaningful phrase. Never the key, never an identifier.
    turnStatus: {
      // Corpus NAMES, because "im Wissen" is product copy with a German
      // preposition welded on, not a proper noun. The backend sends the id.
      // Each entry is the prepositional phrase the templates below slot in.
      corpus: {
        // The words the Herleitung's rows use („Searches the documents“).
        knowledge: 'the documents',
        ris: 'RIS (Austrian law)',
        web: 'the web',
        documents: 'your documents',
        ifc: 'the building model',
        otherProjects: 'other projects',
      },
      // Joins two corpora in one line. Grammar, so it lives here too.
      corpusJoin: ' and ',
      status: {
        // Which of the reader's OWN files are being read. One key per level
        // rather than one template with a slot: German needs the dative ("aus
        // der Büroablage") and English needs no article, so the level's name
        // cannot be interpolated into one shared sentence. Every line names
        // the level the way the product names it to the reader — Office
        // filing, project, conversation. There is no line for several at
        // once, because the collective noun for them is OURS, not theirs, so
        // `several` states plainly WHAT is being read.
        documents: {
          officeShelf: 'Reviewing documents from Office filing …',
          project: 'Reviewing documents from the project …',
          session: 'Reviewing documents from this conversation …',
          several: 'Reviewing your documents …',
          // A file uploaded moments ago is not indexed yet; the answer holds
          // for it briefly rather than answering without it.
          waiting: 'A new file is still being read — the answer is waiting for it …',
        },
        // `{query}` is the reader's own words echoed back — never translated,
        // and clipped by the backend so the line still fits one narrow row.
        retrieval: {
          withQuery: 'Searching {corpus}: “{query}”',
          plain: 'Searching {corpus} …',
          // The passage was already identified and is being READ, so the line
          // names the document instead of a corpus. `{document}` is the name
          // the publisher or the office gave it — a proper noun, sent as
          // itself and never translated.
          clause: 'Reading {document}, Sec.\u00A0{clause} …',
          page: 'Reading {document}, p.\u00A0{page} …',
          // Other formulations are being tried — the action, not the verdict:
          // the line says what is happening NOW, replacing the round's search
          // line, so it must not open with a failure. That the first pool was
          // not enough lives in the key (`requery`), not the sentence. The
          // formulations are the model's words, so they stay off the line.
          requery: 'Searching with other terms …',
        },
        // Non-retrieval tools the user asked for by name. A tool with no entry
        // gets no line at all: its internal name is not a status.
        action: {
          remember: 'Saving the note …',
          card: 'Building the result card …',
          // This conversation's working directory: one verb, one line. Never
          // "searching" — nothing here is read as evidence for an answer; the
          // document being written is what is being worked on.
          draftList: 'Reviewing the drafts …',
          draftRead: 'Reading the draft …',
          draftWrite: 'Writing the draft …',
          draftEdit: 'Revising the draft …',
          // A workspace change being PROPOSED. Present tense and no verb: the
          // card names the operation and the file a moment later, with the
          // buttons attached, so saying it twice would only say it worse.
          fileProposal: 'Preparing a suggestion for your files …',
          // The two steps that leave the conversation. Their own lines, because
          // what changes here is not the draft but where it lives — and because
          // filing and sending for approval are two different things to the
          // reader: one puts something down, the other asks somebody.
          draftFiled: 'Filing the draft in the project …',
          draftSubmitted: 'Sending the draft for approval …',
          taskCreated: 'Creating the task …',
          // Annotations on a document. Piloti only suggests its own findings: a
          // person takes each one over or dismisses it. It sets, changes and
          // deletes only what the person asks for.
          annotationsRead: 'Reading the annotations …',
          annotationsPropose: 'Suggesting annotations …',
          annotationsSet: 'Setting annotations …',
          annotationsUpdate: 'Changing an annotation …',
          annotationsDelete: 'Deleting an annotation …',
          annotationsReply: 'Replying to an annotation …',
          // Piloti looks at a page or a region of it (ADR-0128).
          look: 'Looking at the document …',
          // A call into the workspace through Piloti itself: a read runs, a
          // write comes back as a proposal.
          workspaceCall: 'Working in the workspace …',
        },
        // The tools are done, the answer is being written. The same words as
        // `activity.composing` above: one vocabulary for one thing — whether
        // the line comes from a turn event or the legacy classification must
        // not show.
        synthesis: 'Composing the answer …',
        // The product's trust proposition said out loud: what is checked is not
        // "the citations" in the abstract but every one of them, against what
        // was actually retrieved.
        citations: 'Checking every citation against the sources …',
        // A quotation no passage holds verbatim is corrected in place to the
        // cited passage's own wording (ADR-0067). No search, no rewrite; a quote
        // it cannot correct keeps its marker.
        repair:
          'A quotation differs from the source’s wording — correcting it against the original …',
        escalation: 'A quick lookup is not enough — starting deep research',
        // A note the person typed while Piloti works. `{text}` is their own
        // words; `{round}` the round in which Piloti read it.
        steer: {
          received: 'Added: “{text}” — taking it into account …',
          applied: 'Note applied in round {round}: “{text}”',
        },
      },
    },
    // The one skill event a reader sees, keyed on WHO decided. Two sentences
    // rather than one with a swapped verb — that difference is not a word in
    // every language. `{skill}` is the office's authored `grid-title` and
    // travels verbatim: it is their name for their own method.
    skill: {
      activated: 'Applying the “{skill}” skill',
    },
    // Compact "what actually ran" chips in the Herleitung basis — one chip per
    // executed agent/tool, without the technical-steps opt-in.
    executedSteps: 'Ran:',
    stepName: {
      webSearch: 'Web search',
      ris: 'RIS',
      corpus: 'Knowledge',
      /** Looked in the office's other projects (ADR-0094), mostly its closed reference projects. */
      otherProjects: 'Other projects',
      reading: 'Reading',
      /** The conversation's working directory: write, read, edit, list — one word. */
      draft: 'Draft',
      /** The draft leaves the working directory: filed, or submitted for approval. */
      filing: 'Filing',
      task: 'Task',
      /** Annotations on the document: read, suggested or answered. */
      annotations: 'Annotations',
      /** The file actions PROPOSE and write nothing (ADR-0003). */
      fileProposal: 'File proposal',
      // Read or proposed in the workspace (members, approvals, tasks).
      workspace: 'Workspace',
      // One chip per skill the turn actually applied. `{name}` is resolved by
      // the single label authority (features/skills/lib/skill-activity).
      skill: 'Skill: {name}',
      model: 'Building model',
      measure: 'Measurement',
      drawing: 'Drawing',
      documents: 'Files',
      note: 'Note',
      card: 'Card',
      compliance: 'Compliance check',
    },
    // The technical panel's names for the two step kinds that carry no tool or
    // slot of their own. Tools reuse `stepName.*` above.
    nodeName: {
      clarification: 'Clarifying question',
      skillSelection: 'Skill selection',
    },
    showThinking: 'Show thinking ({count})',
    showThinkingSteps: 'Show thinking steps ({count})',
    // The trace's header line. No step count: it counted raw NAT event names,
    // not turns or calls (see ChatThinking). The sources clause is ABSENT when
    // there are none: "0 sources" is a true number that reads as a failure, and
    // an answer grounded in a measurement of the model rightly has no citations.
    // The Herleitung's header: steps, cited sources and at most ONE warning, the worst.
    derivationSteps: '{count, plural, one {#\u00A0step} other {#\u00A0steps}}',
    derivationCited: '{count, plural, one {#\u00A0source cited} other {#\u00A0sources cited}}',
    derivationWarning: {
      failed: '{count, plural, one {#\u00A0call failed} other {#\u00A0calls failed}}',
      open: '{count, plural, one {#\u00A0open point} other {#\u00A0open points}}',
    },
    // A turn without any research: one line, nothing to expand.
    noResearch: 'Answered without research',
    noResearchNote: 'General expertise, no source cited',
    // A turn of exactly one call: the header is the Herleitung.
    singleCited: 'cited {markers}',
    derivationSummary: 'Trace',
    derivationSummaryWithSources: 'Trace\u00A0· {count, plural, one {#\u00A0source} other {#\u00A0sources}}',
    // aria-label naming the reasoning graph as one region for screen readers.
    reasoningGraphLabel: 'Reasoning trace',
    stepsLabel: 'Thinking steps',
    stepsHeading: 'Intermediate steps',
    sourcesFanOut: 'Sources',
    hitCount: '{count} hits',
    hitCountOne: '1 hit',
    gapHit: 'Nothing found',
    // A document the research read but the answer never cited — a real
    // research outcome, not a gap.
    readNotUsed: 'retrieved, not cited',
    moreSources: '+{count} more',
    // One-liner when this turn escalated from shallow to deep research.
    escalationNarration: 'Escalated to deep research: {reason}',
    node: {
      framingTab: 'Framing',
      framingTitle: 'Question understood',
      framingQuestion: 'You asked: “{question}”',
      // The Herleitung's last card: what the answer stands on, as a draft.
      // Never "proven": Piloti lists the basis, the judgement stays with the office.
      basis: {
        label: 'Basis · Draft',
        pendingLabel: 'Basis',
        pending: 'forms with the answer',
        law: 'Legal basis',
        evidence: 'Supported by',
        open: 'Open',
        clause: 'Sec.\u00A0{clause}',
        page: 'p.\u00A0{page}',
        // From a call without a hit: where it looked and for what. Never "No information found".
        openNoHitIn: 'Cannot be judged: the search in {target} for “{query}” found no passage.',
        openNoHitShelf: 'Cannot be judged: the search {shelf} for “{query}” found no passage.',
        openNoHit: 'Cannot be judged: the search for “{query}” found no passage.',
        openEmpty: 'Cannot be judged: a call found nothing ({what}).',
        // From a call that failed or broke off: the call as a noun.
        openFailed: 'Cannot be judged: {call} failed.',
        openInterrupted: 'Cannot be judged: {call} was stopped.',
        callQuery: '{call} for “{query}”',
        callTarget: '{call} “{target}”',
        call: {
          search: 'the search',
          list: 'opening the folder',
          read: 'reading the document',
          look: 'looking at the document',
          lookup: 'the search in other projects',
          law: 'the RIS lookup',
          web: 'the web search',
          model: 'the building model query',
          workspace: 'a workspace call',
        },
      },
      cardLink: 'Highlight the calls for {name}',
      // A step's uncited sources, in one dashed card. While the answer runs no
      // one knows what it cites: then "more".
      uncited: {
        pill: 'Not cited',
        pillLive: 'Retrieved',
        name: '+{count} retrieved',
        nameLive: '+{count} more',
        hide: 'Hide uncited sources',
      },
      // Every retrieval layer on the Herleitung spine, in execution order:
      // one counter, one noun. The old two-noun sequence (`Search 1`, then
      // `Conclusion 2…`) read as one run but counted two things — the tool
      // calls and the inferences — so the numbers could double-book a layer.
      // WHAT the layer did rides along as the typed sublabel below, never as
      // the number.
      stepTab: 'Step {n}',
      // The typed sublabel beside `stepTab`: what this layer actually did,
      // read off reason × files from the round the spine already owns. A
      // layer that concluded on the back of what it fetched is a finding; a
      // bare fetch that returned nothing is a search. `Read` reuses
      // `stepName.reading`'s word on purpose: one vocabulary, not two.
      stepKindSearch: 'Search',
      stepKindRead: 'Reading',
      stepKindFinding: 'Finding',
      stepKindConclusion: 'Conclusion',
      // A fetch the backend saw return nothing. Not `Search`: a layer with no
      // fan read as one that found nothing, and was often one whose hits the
      // old wire never stamped. Only the ledger can tell the two apart.
      stepKindNoHits: 'No hits',
      // A round that only opened folders: it looks for no documents, so coming
      // back without any is no miss (ADR-0132).
      stepKindBrowse: 'Open folder',
      // A layer that only opened passages of files the turn already had: it
      // searched for nothing. Telling that round apart from a fresh fetch is
      // the whole reason the word exists.
      stepKindOpen: 'Open',
      // A folded layer keeps the scent of its fan: the count plus the top
      // filename(s), never a bare count — evidence hidden by default reads
      // as no evidence. Still never the query (PF-12).
      roundFoldOne: '{name} · {locus}',
      roundFoldOneBare: '{name}',
      roundFoldTwo: '{first} · {second}',
      roundFoldMany: '{count} files · {first} and others',
      // The locus half of `roundFoldOne`, in the answer's own words (cf.
      // `answerSources.punktPage`): the passage, not the mechanism.
      roundFoldLocusPage: 'p.\u00A0{page}',
      roundFoldLocusClause: 'Sec.\u00A0{clause}',
      roundFoldLocusClausePage: 'Sec.\u00A0{clause}\u00A0· p.\u00A0{page}',
      // Accessible name of the control that folds and unfolds the layer. The
      // card's own text is a conclusion and makes a poor control name.
      roundFold: 'Collapse step {n}',
      roundUnfold: 'Expand step {n}',
      // A file an earlier round already showed, where its hit count would be.
      // The count is the whole turn's tally and therefore identical on every
      // repeat — which is what made a re-read look like a second fetch.
      roundDocRepeat: 'already retrieved',
      workspaceRead: 'Read from the workspace',
      contextLabel: 'Context',
      sourcesTab: 'Sources',
      sourcesTitle: 'Sources examined',
      // The search did not finish; it ran into its iteration ceiling. It
      // belongs in the findings node because that node answers "what was
      // this answer built on?", and where the chain broke off is part of it.
      // {tool} is the last step that RAN, never the next one: nobody knows
      // what the model would have chosen, because it never got to propose it.
      findingsTruncatedStep: 'The search ended here — the last step it ran was {tool}',
      // When there is no step to name (the budget was gone before the first
      // tool), say less rather than invent one.
      findingsTruncated: 'The search ended here: the budget was spent',
      // ── What the answer is NOT ──────────────────────────────────────────
      //
      // Two records the deep researcher keeps about its own limits, both on
      // the technical channel, both invisible before this: a run that hit its
      // wall clock or its step limit, and an answer that shipped in a
      // known-weaker form. Until they were rendered, an answer cut off after
      // two of ten planned searches looked exactly like a complete one.
      //
      // Written as statements an architect can act on, never as the telemetry
      // they are derived from. The record also carries a report length in
      // characters; there is no line for it, because a character count names a
      // mechanism and nothing a reader can do anything with.
      limits: {
        label: 'Limitations',
        deepCutoff: {
          // Why the run stopped. `other` covers a reason token this build does
          // not know — that it stopped early is true whatever ended it.
          time: 'Deep research reached its time limit.',
          steps: 'Deep research reached its step limit.',
          other: 'Deep research stopped early.',
          // …and whether anything survived it. This is the half that decides
          // how much weight the answer above can carry.
          salvaged: 'What it had established by then went into the answer.',
          nothing: 'It had produced no findings by then.',
          // How far it got. Only stated when there is something to state: zero
          // sources is a true number that reads as a verdict, and `nothing`
          // above already says the honest version.
          sources:
            '{count, plural, one {# source had been reviewed} other {# sources had been reviewed}} by then.',
          after: 'It stopped after {minutes, plural, one {# minute} other {# minutes}}.',
        },
        // The answer shipped weaker than a clean run. These read as warnings
        // because they are the reader's cue to check before they rely on it.
        degraded: {
          noReport:
            'No research report was filed — the answer exists only here in the conversation.',
          noCitations:
            'No citation held up under checking. Please verify the figures yourself before using them.',
          noCards:
            'The report is complete, but the proposals derived from it could not be produced.',
          basisUnread:
            'Not every document named as the basis could be read; the answer does not reflect its contents. The end of the report lists which.',
        },
      },
      branchesTab: 'Next steps',
    },
  },
  error: {
    showDetails: 'Show details',
    hideDetails: 'Hide details',
    // Retry action on an errored answer (design language: "helpful message + retry").
    retry: 'Try again',
    // The failed request's id. The first eight characters are shown — the same
    // ones the log line carries — and the whole id is what gets copied.
    reference: 'Support reference',
    referenceCopyAria: 'Copy reference {id}',
    referenceCopied: 'Reference copied',
  },
  // Localized titles + default messages for the chat error registry
  // (features/chat/lib/error-registry.ts). Keyed by error code.
  errorRegistry: {
    connectionLost: {
      title: 'Connection Lost',
      message: 'Lost connection to the server. Please check your network.',
    },
    connectionFailed: {
      title: 'Connection Failed',
      message: 'Unable to connect to the server. Please check your network connection.',
    },
    clientOutdated: {
      title: 'Piloti was updated',
      message: 'Reload the page to continue.',
    },
    serverIncompatible: {
      title: 'Piloti is not reachable right now',
      message:
        'The server runs a different version than this page, which happens briefly during an update. Try again in a few minutes; if it persists, tell support.',
    },
    connectionTimeout: {
      title: 'Request Timeout',
      message: 'The request took too long to complete.',
    },
    sessionExpired: {
      title: 'Session Expired',
      message: 'Your session has expired. Please sign in again.',
    },
    unauthorized: {
      title: 'Unauthorized',
      message: 'You do not have permission to perform this action.',
    },
    responseFailed: {
      title: 'Response Failed',
      message: 'The assistant encountered an error generating a response.',
    },
    // Only once the server has confirmed it has no answer.
    responseInterrupted: {
      title: 'Response Interrupted',
      message: 'Piloti did not finish this answer, and the server has none. Please send the question again.',
    },
    noResponse: {
      title: 'No response',
      message: 'Piloti did not respond to your question, not even to a second attempt. Send it again.',
    },
    zdrRefused: {
      title: 'Model not available under zero data retention',
      message:
        'Your organization’s zero-data-retention setting only allows models with a zero-data-retention endpoint, and the model for this task has none. An organization admin must choose one under Organization → Models.',
    },
    workflowError: {
      title: 'Request Failed',
      message:
        'The assistant hit an unexpected error while handling your request. Please try again.',
    },
    unknown: {
      title: 'Something Went Wrong',
      message: 'An unexpected error occurred. Please try again.',
    },
    // Deep-research job rejected because the queue is full (WP-A
    // `job_admission_rejected`). Warning, not error: resending resolves it.
    researchQueueFull: {
      title: 'Research is busy',
      full: 'The research queue is currently full.',
      message: 'The research queue is currently full. Please resend your request in a moment.',
      retryHint: 'Please try again in about {seconds, plural, one {# second} other {# seconds}}.',
    },
  },
  budgetExhausted: {
    title: 'Budget exhausted',
    memberMessage:
      'Your usage budget is used up, so new messages can’t be sent right now. You can review your own usage under Organization → Usage & budgets. Ask an organization admin to raise your limit.',
    adminMessage:
      'The usage budget is used up, so new messages can’t be sent right now. Raise the limits under Organization → Usage & budgets.',
  },
  /**
   * The usage notice above the composer (`UsageNotice.tsx`): one budget window,
   * at one of four levels, before it stops this person. `{budget}` is one of the
   * `budget.*` phrases and always opens the sentence.
   */
  usageNotice: {
    budget: {
      organization: { day: 'The office’s daily budget', month: 'The office’s monthly budget' },
      member: { day: 'Your personal daily budget', month: 'Your personal monthly budget' },
      project: { day: 'This project’s daily budget', month: 'This project’s monthly budget' },
    },
    title: {
      forecast: '{budget} runs out around {date} at this pace',
      warning: '{budget} is {percent} used',
      critical: '{budget} is almost used up ({percent})',
      exhausted: '{budget} is used up',
    },
    usedSoFar: '{percent} used so far.',
    amountsCredits: '{used} of {limit} credits.',
    amountsTokens: '{used} of {limit} tokens.',
    paceRunsOut: 'At this pace it runs out around {date}.',
    longRunsMayStop: 'A long research run may stop before it finishes.',
    renewsDay: 'It renews at {time}.',
    renewsMonth: 'It renews on {date}.',
    blockedDay: 'New messages can’t be sent until it renews at {time}.',
    blockedMonth: 'New messages can’t be sent until it renews on {date}.',
    askAdmin: 'An admin can raise the limit.',
    raiseLimit: 'Raise the limit',
    seeUsage: 'See usage',
    meterLabel: '{percent} of the budget used',
  },
  noSources: {
    warning:
      'No data sources selected and no files are available. Responses are more likely to be inaccurate or outdated unless external data sources are added.',
  },
  memory: {
    noted: 'Piloti noted',
    notedAria: 'Piloti noted {count, plural, one {# item} other {# items}}',
    addedToMemory: 'Added to project memory',
    manageHint: 'You can manage and delete these entries in the project memory.',
    kinds: {
      decision: 'Decision',
      constraint: 'Constraint',
      open_question: 'Open question',
      derived_fact: 'Fact',
      preference: 'Preference',
    },
    provenance: {
      distillation: 'added after the response',
      inTurn: 'noted during the response',
    },
  },
  confidence: {
    label: 'Confidence: {level}',
    levels: {
      high: 'high',
      medium: 'medium',
      low: 'low',
    },
    ariaLabel: 'Assistant self-assessed confidence: {level}',
    tooltip:
      "The assistant's own assessment of how well this answer is supported by its sources. It can be wrong.",
    // What each level MEANS, shown in the tooltip so the reader can interpret the chip.
    levelMeanings: {
      high: 'High: the answer is directly grounded in the retrieved sources, which support it clearly and consistently.',
      medium:
        'Medium: partially grounded — sources support parts, but a gap, an inference, or a minor ambiguity remains.',
      low: 'Low: sources are missing, conflicting, or clearly insufficient; the answer extrapolates from general knowledge.',
    },
    // Label introducing the model's own one-clause justification (verbatim).
    reasonLabel: "Assistant's reason",
    // The same label when the level was capped afterwards: the reason describes
    // the level BEFORE the cap, not the one shown.
    reasonLabelBeforeCap: "Assistant's reason before the cap",
    // Extra sentence appended to the tooltip explaining WHY the confidence was
    // capped, keyed by `answer_confidence_capped_reason` (WP-A, PB-9).
    cappedReasons: {
      ungrounded: 'Low confidence: answer not backed by sources.',
      quoteUnverified:
        'A quote could not be verified verbatim against the source; the assessment is capped accordingly.',
      // The measurement backs the number, not the legal statement beside it —
      // so the mixed answer stays at "low" and the tooltip says why.
      normativeClaimUncited:
        'Low confidence: the measurements come from the model, but the normative claim about them is not backed by a source.',
      // Measured is not cited: the number is reproducible, but "high" stays
      // reserved for an answer with a verified citation.
      measurementOnly:
        'Medium confidence: the figure was measured on the model (with tolerance and method), but is not backed by a source.',
      // The source came from the conversation, not from this answer — so it
      // backs no more than a measurement does.
      citationFallback:
        'Medium confidence: the source shown was attached by the assistant, not cited by the answer itself.',
    },
    // The assessment since ADR-0125: computed per statement, not per answer.
    // Older answers keep the copy above, under which they were computed.
    byClaim: {
      tooltip:
        "The assistant's own assessment, held to the weakest statement the answer rests on. It can be wrong.",
      levelMeanings: {
        high: 'High: every statement the answer rests on is backed by a cited source, a workspace record or a measurement.',
        medium:
          'Medium: a statement the answer rests on is an inference or general knowledge, or a record read does not cover a figure.',
        low: 'Low: a statement about the law, a figure or a deadline is not backed, or a citation did not hold up.',
      },
      // What the answer's sentences rest on, in reading order: what holds first.
      mix: {
        supported: '{count, plural, one {# statement backed} other {# statements backed}}',
        observed: '{count, plural, one {# statement read off the drawing} other {# statements read off the drawing}}',
        reasoning: '{count, plural, one {# inference} other {# inferences}}',
        modelKnowledge: '{count, plural, one {# from general knowledge} other {# from general knowledge}}',
        normativeUncited: '{count, plural, one {# legal statement without a source} other {# legal statements without a source}}',
        dropped: '{count, plural, one {# citation not verified} other {# citations not verified}}',
      },
      cappedReasons: {
        ungrounded: 'Capped by a statement the answer rests on that nothing backs.',
        quoteUnverified:
          'A quote could not be verified verbatim against the source; the assessment is capped accordingly.',
        normativeClaimUncited:
          'Capped by a legal statement without a cited source. A workspace record or a measurement does not back a legal statement.',
        measurementOnly:
          'Medium confidence: the figure was measured on the model (with tolerance and method), but is not backed by a source.',
        citationFallback:
          'Medium confidence: the source shown was attached by the assistant, not cited by the answer itself.',
      },
    },
  },
  // Per-answer thumbs feedback (WS-7).
  feedback: {
    question: 'Was this helpful?',
    helpfulAria: 'Mark this answer as helpful',
    notHelpfulAria: 'Mark this answer as not helpful',
    reasonPrompt: 'What was the problem?',
    reasons: {
      inaccurate: 'Inaccurate',
      too_slow: 'Too slow',
      wrong_source: 'Wrong source',
      other: 'Other',
    },
    thanks: 'Thanks for your feedback.',
    voteRecorded: 'Rating saved.',
    commentLabel: 'Anything else?',
    commentPlaceholder: 'Optional — tell us what went wrong',
    expectedLabel: 'What should a good answer have contained?',
    expectedPlaceholder: 'e.g. parapet height 1.00 m per OIB-RL 4',
    commentSubmit: 'Send note',
  },
  // After a thumbs-down: ask the same question again with more effort.
  retryThorough: {
    action: 'Answer again, more thoroughly',
    aria: 'Answer the same question again with more reasoning effort',
  },
  // Copy message button on user message bubbles
  copyMessage: {
    copy: 'Copy message',
    copied: 'Copied',
    failed: 'Message could not be copied',
  },
  /**
   * Sensitive data in chat (ADR-0086): what the composer reports before sending.
   * The placeholders themselves are domain data and come from `content-screen.ts`.
   */
  /** The notice once a chat's answers drew on another project (ADR-0094). */
  otherProjects: {
    chip: '{count, plural, one {One other project} other {# other projects}}',
    title: 'This chat draws on other projects: {projects}.',
    gone: 'a project that no longer exists',
    body: 'It can be shared only with people who may open those projects. Nothing from it goes into project memory, tasks, deep research or the project’s files.',
  },
  screening: {
    title: 'Contains {items} (Sensitive data).',
    body: 'Piloti does not send this to the answering model.',
    preview: 'The model sees: “{text}”',
    iban: '{count, plural, one {an IBAN} other {# IBANs}}',
    at_svnr: '{count, plural, one {a social security number} other {# social security numbers}}',
    credit_card: '{count, plural, one {a card number} other {# card numbers}}',
    term: 'the term “{term}”',
    withSample: '{item} {sample}',
    sendMasked: 'Send masked',
    edit: 'Edit',
  },
}
