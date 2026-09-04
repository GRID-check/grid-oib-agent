/** chat namespace — populated during component i18n. */
export const chat = {
  actions: {
    dismiss: 'Dismiss',
  },
  // Source preview (WS-9, FB-4): citation chips open a preview of the source.
  sourcePreview: {
    chipAria: 'Preview source: {label}',
    view: 'View',
    // Document-type chip in the preview dialog header.
    projectDocument: 'Project document',
    corpusDocument: 'Building law & guidelines',
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
      bindend: 'Bindend',
      verbindlich_erklaert: 'Verbindlich erklärt',
      auslegend: 'Auslegend',
    },
    openExternal: 'Open in RIS',
    // Coarse source kind (ADR-0026) shown in the info popover. Preferred
    // over `origins` because the origin token is kb/ris/web only, so a
    // knowledge-base copy of a legal text reads as project material.
    kinds: {
      baurecht: 'Building law & guidelines',
      buero: 'Office archive',
      projekt: 'Project knowledge',
      web: 'Web source',
    },
    // Origin line in the info popover (no openable document).
    origins: {
      kb: 'Project knowledge',
      ris: 'Law & guidelines (RIS)',
      web: 'Web source',
    },
  },
  // Document grid: real project/Büroarchiv files the assistant surfaced as
  // clickable preview cards (the `document_grid` card / `surface_documents` tool).
  documentGrid: {
    // Count pill — singular/plural chosen in the component (no ICU in this i18n).
    countOne: '1 document',
    countOther: '{count} documents',
    forQuery: '“{query}”',
    // Provenance badge on a card.
    source: {
      projekt: 'Project',
      buero: 'Office',
    },
    // A surfaced file that no longer resolves to a live document row — an honest,
    // actionable card (the assistant referenced it; open the archive / project
    // files) rather than a silent dead tile.
    unresolvedHint: 'The assistant referenced this file.',
    openInArchive: 'Open in archive',
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
    // shared project knowledge, the office-wide archive, a private attachment.
    shelf: {
      projekt: 'Project files',
      buero: 'Office archive',
      session: 'Attachment in this chat',
    },
    notIndexed: 'Not indexed — readable, but it cannot be cited.',
    failed: 'Processing this file failed.',
  },
  composer: {
    /** Shown when the reader holds project:view but not project:chat. */
    noProjectChatPermission:
      'The research agent is unavailable in this project for you right now. If you have read-only access, a project admin can grant you the Contributor role.',
    placeholder: 'Ask Piloti about this project …',
    sources: 'Data basis',
    sourcesAria: 'Data basis — {enabled} of {total} sources enabled. Opens the data sources panel.',
    deepResearch: 'Deep Research',
    deepResearchAria: 'Deep Research preference',
    // Honest intent hint: the agent auto-escalates; the pill records a
    // preference, it does not force a deep-research run.
    deepResearchHint:
      'Preference noted — Piloti escalates to Deep Research automatically when a question calls for it.',
    scopeAria: 'Search scope: {project}',
    scopeFallback: 'This project',
    scopeCurrent: 'Current project',
    scopeAll: 'All projects',
    scopeAllSoon: 'Coming soon — cross-project search is not available yet.',
    // Mobile-only cue: the source/scope labels collapse to icons on phones, so a
    // tiny one-line hint under the composer keeps the active source count legible.
    sourcesActiveMobile: '{count, plural, one {# source} other {# sources}} active',
  },
  // Source-preset shortcut chips under the composer (empty thread).
  shortcuts: {
    label: 'Shortcuts',
    presetAria: 'Source preset: {label}',
    presets: {
      law: 'Building law & guidelines',
      project: 'Project documents',
      office: 'Office archive',
    },
  },
  // Time-of-day greeting on the empty chat state.
  greeting: {
    morning: 'Good morning',
    afternoon: 'Good afternoon',
    evening: 'Good evening',
    withName: '{greeting}, {name}.',
  },
  // Thread role tabs (click-dummy overhaul, WS-3).
  roles: {
    input: 'Input',
    result: 'Result',
    // Role tab for a conversational / clarifying reply (routing_decision =
    // 'meta': greetings, capability questions, clarifying Rückfragen) — marks
    // it visibly apart from a substantive Baurecht 'Result'.
    note: 'Note',
  },
  // "Belegt durch" provenance chip row under answers that carry source data.
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
    punktPage: 'Pkt. {punkt} · p. {page}',
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
  },
  // Thread-header breadcrumb (project / session title) with inline rename.
  // The citation peek: what a Fundstelle IS, before you open it.
  citationPeek: {
    wholeDocument: 'Whole document',
    openAtPage: 'Open at this passage',
    notOpenable: 'Cannot be opened in Piloti',
    copyLink: 'Copy link',
    copyLinkAria: 'Copy a link to this passage: {label}',
    markerAria: 'Source {number}: {label} — open preview',
    lociLabel: '{count, plural, one {# passage} other {# passages}}',
    lociAria: 'Passages in this document',
    lociPosition: '{index}/{count}',
    previousLocus: 'Previous passage',
    nextLocus: 'Next passage',
    retrievedOnly: 'Read',
  },
  breadcrumb: {
    ariaLabel: 'Conversation breadcrumb',
    renameAria: 'Rename session — click to edit the title',
    renameInputAria: 'Session title',
  },
  cards: {
    legalBasis: 'Legal basis',
    // Tooltip on the OIB / RIS tier badge: the badge itself is a proper noun
    // that reads the same in both locales, so this is what says what it MEANS.
    authority: 'Authority: {tag}',
    viewOib: 'View OIB Richtlinie',
    verifyRis: 'Verify in RIS',
    aiGenerated:
      'AI-generated citation — check the excerpt against the primary source (OIB / RIS).',
    conditionTree: {
      eyebrow: 'Condition tree',
      dependsOn: 'Depends on',
      applies: 'applies here',
      basis: 'Basis',
      // Lead-in over the outcome of the case that DOES apply to this project.
      appliesHere: 'For this project the following applies:',
      // Lead-in over any other case, in the subjunctive: the grammar itself
      // says this is a what-if, so a screenshot of the panel cannot be read
      // as this project's answer.
      previewLead: 'Under {condition} the following would apply:',
      // Same lead-in where no branch is marked as this project's: nothing is
      // being contrasted, so nothing is put in the subjunctive.
      caseLead: 'Under {condition} the following applies:',
      // Rides INSIDE the previewed panel, so it travels with a screenshot.
      previewNotice: 'For comparison only — this project is {condition}: {outcome}',
      backToActive: 'Back to {condition}',
      caseAria: 'Case {condition}',
    },
    askAbout: {
      chip: 'Ask about this',
      chipAria: 'Put a question about "{subject}" into the message box',
      missingWithDetail:
        '"{subject}" is missing a figure: {missing}. How can I supply it, and what applies until then?',
      missingOnly:
        '"{subject}" is missing a figure. Which figure is needed here, and where do I get it?',
    },

    // ── Shared schematic chrome ────────────────────────────────────────────
    // `kit.tsx` draws fifteen cards. Its vocabulary lives here because it
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
    },
    keyTakeaways: {
      eyebrow: 'What matters most',
    },
    callout: {
      hinweis: 'Note',
      achtung: 'Caution',
      frist: 'Deadline',
      tipp: 'Tip',
      more: 'More on this',
      less: 'Less',
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
    // The one card whose picture the renderer did not compute — the model wrote
    // the mermaid. The rest of its words are shared with the mermaid FENCE
    // (`diagrams.schematicOnly`, `diagrams.fallback`): the same claim about the
    // same picture, said once.
    diagram: {
      eyebrow: 'Diagram',
    },
    processMap: {
      eyebrow: 'Procedure',
      current: 'you are here',
      done: 'done',
      stepAria: 'Step {step}: {label}',
      requires: 'Requires',
      produces: 'Produces',
      actor: 'Responsible',
      duration: 'Deadline',
      basis: 'Basis',
      // Rides INSIDE an opened step that is not the current one, so it travels
      // with a screenshot of that panel alone.
      elsewhereNotice: 'For reference only — this project is at step {step}: {label}',
      backToCurrent: 'Back to {label}',
    },
    // ── Submission documents ────────────────────────────────────────────
    // The counts in the overview are worked out by the card from its own rows,
    // so there is no field on the wire for a summary to disagree with.
    documentChecklist: {
      eyebrow: 'Documents',
      itemAria: 'Document: {label}',
      requirement: {
        required: 'required',
        conditional: 'conditional',
      },
      // The state of ONE row. „not known" is the normal case: only what the
      // conversation established may stand here.
      status: {
        present: 'on hand',
        missing: 'missing',
        unknown: 'not known',
      },
      // The same words as modifiers, so a count reads grammatically.
      tally: {
        required: 'required',
        conditional: 'conditional',
        present: 'on hand',
        missing: 'missing',
        unknown: 'unresolved',
      },
      tallyAria: 'State of the dossier',
      // Stands in for the second row when nothing is known about any document.
      // A bar reading „0 of 5" there would be a claim about the project rather
      // than a summary of the card.
      noStatus: 'Whether you already hold these documents does not follow from the conversation.',
      condition: 'Condition',
      issuer: 'Issued by',
      form: 'Form',
      basis: 'Basis',
    },
    // ── Deadlines ───────────────────────────────────────────────────────
    deadlineTimeline: {
      eyebrow: 'Deadlines',
      deadlineAria: 'Deadline {index}: {label}',
      startsFrom: 'Clock starts',
      consequence: 'If missed',
      actor: 'Responsible',
      basis: 'Basis',
      // The sentence that keeps the card honest: the order is drawn, the
      // length is not — each period runs from its own event.
      notToScale: 'The order is drawn, not the lengths: each period runs from an event of its own.',
      noDatesNote:
        'Every period is carried as the provision words it. This card works out no dates.',
    },
    // ── Impact of a change ──────────────────────────────────────────────
    changeImpact: {
      eyebrow: 'Impact',
      consequenceAria: 'Impact: {aspect}',
      changeWithBefore: '{factor}: {from} → {to}',
      changeWithoutBefore: '{factor} → {to}',
      // Under the header when the current value is absent. Leaving „before"
      // blank would be the quieter but less truthful option.
      currentUnknown: 'The current value does not follow from the conversation.',
      direction: {
        tightens: 'tightens',
        relaxes: 'relaxes',
        unchanged: 'unchanged',
      },
      before: 'before',
      after: 'then',
      unknownBefore: 'current value not known',
      basis: 'Basis',
    },
    verdictHeader: {
      confidenceHigh: 'high confidence',
      confidenceMedium: 'medium confidence',
      confidenceLow: 'low confidence',
    },
    normChain: {
      eyebrow: 'Chain of norms',
      // Rank of the legal instrument. These are the names of the Austrian
      // legal order and stay in German here too.
      rank: {
        bundesgesetz: 'Bundesgesetz',
        landesgesetz: 'Landesgesetz',
        verordnung: 'Verordnung',
        oibRichtlinie: 'OIB-Richtlinie',
        oenorm: 'ÖNORM',
        leitfaden: 'Leitfaden',
      },
      binding: 'binding',
      // An OIB-Richtlinie binds only once a Land declares it binding — that
      // belongs on the link, not in a footnote.
      bindingWhenDeclared: 'binding where declared',
      interpretive: 'interpretive',
    },
    comparison: {
      eyebrow: 'Comparison',
      criterion: 'Criterion',
    },
    typedTable: {
      eyebrow: 'Table',
    },
    // ── Labels inside the drawings ─────────────────────────────────────────
    // What is written on the sketch itself. Symbols (±0,00, Ø, N), units and
    // standard designations (A++ … G, DnT,w) are deliberately absent: they are
    // the same mark in every language.
    schematics: {
      acoustic: {
        soundClass: 'Sound insulation class',
        airborne: 'Airborne sound',
        impact: 'Impact sound',
        airborneResultant: 'Airborne sound (resultant)',
        lowerIsBetter: '↓ lower is better',
        higherIsBetter: '↑ higher is better',
        reserve: 'Margin +{margin} dB',
        shortfall: 'Shortfall {margin} dB',
      },
      daylight: {
        glassArea: 'Glazed area',
        window: 'Window',
        obstruction: '45° daylight angle — {label}',
        requiredArea: 'Floor area {floor} m² → required glazed area ≥ {required} m² (10 %).',
        obstructionPierces: 'The obstruction pierces the 45° daylight cone.',
      },
      density: {
        coverage: 'Site coverage',
        parcel: 'Parcel {area} m²',
        builtUp: 'built',
        builtUpUnknown: 'Built-up area: {missing}',
        grossFloorArea: 'Gross floor area (BGF)',
      },
      egress: {
        totalWalkLength: 'Total travel distance',
      },
      elevator: {
        accessible: 'Accessible lift',
        required: 'required',
        notRequired: 'not required',
        entranceLevel: 'Entrance level',
        shaft: 'Lift',
        // Storey label relative to the entrance level, in Austrian notation.
        groundFloor: 'EG',
        upperFloor: '{level}.OG',
        basement: '{level}.KG',
      },
      energy: {
        hwb: 'Heating demand (HWB)',
        hwbMarker: 'HWB {value}',
        fgee: 'Overall energy efficiency factor (fGEE)',
      },
      fireAccess: {
        routeWidth: 'Access route width',
        gateClearance: 'Gateway clear height',
        aufstellflaecheWidth: 'Aufstellfläche width',
        aufstellflaecheLength: 'Aufstellfläche length',
        facadeDistance: 'Distance to facade',
        walkToEntrance: 'Walk to entrance',
        parcel: 'Parcel {width} × {depth} m',
        route: 'ACCESS',
        building: 'Building',
        aufstellflaeche: 'Aufstellfläche',
        entrance: 'Entrance',
        street: 'STREET',
        gebaeudeklasse: 'Gebäudeklasse',
        walkTooFar: ' — the walk to the entrance exceeds the permitted distance.',
      },
      fireCompartment: {
        storey: 'Storey {label}',
        plan: 'Floor plan',
      },
      guardrail: {
        context: {
          balkon: 'Balcony',
          loggia: 'Loggia',
          stiege: 'Stairs',
          fenster: 'Window',
          dachterrasse: 'Roof terrace',
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
      parking: {
        car: 'Car parking spaces',
        bicycle: 'Bicycle parking spaces',
        // Abbreviation for parking spaces, used as the unit after the number.
        unit: 'sp.',
        basis: 'Basis',
        short: '{provided} of {required} provided — {missing} short{overflow}',
        surplus: '{provided} provided — surplus +{surplus}{overflow}',
        exact: '{provided} of {required} provided{overflow}',
        truncated: ' (excerpt)',
        legend: 'Filled = provided, dashed = missing against the requirement.',
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
      },
      stair: {
        section: 'SECTION',
        plan: 'PLAN',
        // Step notation as it appears in the section of an Austrian submission.
        stepNotation: '{count} Stg · {rise}/{going} cm',
        // Without rise and going only the count is left.
        stepCount: '{count, plural, one {# step} other {# steps}}',
      },
      thermal: {
        roof: 'Roof',
        wall: 'External wall',
        window: 'Window',
        door: 'Door',
        floor: 'Floor',
      },
    },
  },
  agentPrompt: {
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
    approve: 'Approve',
    reject: 'Reject',
    approvePlan: 'Approve plan',
    rejectPlan: 'Reject plan',
    // The current three-way plan decision (start / answer briefly / cancel).
    startResearch: 'Start research',
    answerShallow: 'Answer briefly instead',
    answerShallowAria: 'Answer the question briefly, without deep research',
    cancelResearch: 'Cancel',
    cancelResearchAria: 'Cancel the research',
    selectOption: 'Select option: {option}',
    yourResponse: 'Your response:',
    // Localized replacement for the backend's English approval envelope
    // sentence ("Reply approve to proceed, reject to cancel").
    approvalInstruction: 'Choose "Approve" to start the research or "Reject" to cancel.',
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
    responseRejected: 'Plan rejected',
  },
  agentResponse: {
    viewProgress: 'View Progress',
    viewReport: 'View Report',
    loading: 'Loading...',
    loadingLabel: 'Loading',
    errorTitle: 'Error: {message}',
  },
  // The single disclosure in the answer footer that holds everything past the
  // sources row and the copy actions (confidence, memory note, skills used,
  // verification notes, feedback, timestamp).
  answerDetails: {
    trigger: 'Answer details',
    triggerAria: 'Show details for this answer',
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
    inProgress: 'Thinking in progress',
    working: 'Working on a response …',
    waiting: 'Waiting for response',
    interrupted: 'Interrupted',
    // Compact inline notice on an interrupted turn: a silent reconnect can drop
    // an in-flight answer (protocol-robustness item 4). German copy is the
    // product-facing string; this English fallback is for harnesses/tests.
    interruptedNotice: 'Connection briefly lost — the answer was dropped. Please resend.',
    // Transient "checking" state (FIX 3): shown while the reconnect recovery
    // fetch is in flight, so a turn that only LOOKS interrupted does not flash
    // the "lost" copy before we have confirmed the answer is really gone.
    recovering: 'Reconnecting',
    recoveringNotice: 'Reconnecting — checking for a finished answer …',
    done: 'Done',
    elapsedAria: 'Elapsed: {seconds, plural, one {# second} other {# seconds}}',
    // Live one-liners describing what the assistant is doing right now, chosen
    // from the newest OPEN step that can be phrased for a reader. There is
    // deliberately no "show the step's own name" entry: an internal identifier
    // dressed up as a status is noise, so an unclassifiable step falls through
    // to the previous meaningful phrase, or to `working` above.
    activity: {
      // The same words as the chips below (`stepName.*`, e.g.
      // `stepName.corpus` = "OIB knowledge"): the reader should learn one
      // vocabulary, not two for the same thing.
      understanding: 'Classifying your question …',
      planning: 'Choosing the research path …',
      searchingWeb: 'Searching the web …',
      searchingKnowledge: 'Searching OIB knowledge …',
      searchingRis: 'Searching RIS (Austrian law) …',
      searchingSources: 'Searching your sources …',
      researching: 'Researching …',
      reading: 'Reading the results …',
      composing: 'Composing the answer …',
    },
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
      // Corpus NAMES, because "im OIB-Wissen" is product copy with a German
      // preposition welded on, not a proper noun. The backend sends the id.
      // Each entry is the prepositional phrase the templates below slot in.
      corpus: {
        knowledge: 'the OIB knowledge base',
        ris: 'RIS (Austrian law)',
        web: 'the web',
        documents: 'your documents',
        ifc: 'the building model',
      },
      // Joins two corpora in one line. Grammar, so it lives here too.
      corpusJoin: ' and ',
      status: {
        // Which of the reader's OWN files are being read. One key per level
        // rather than one template with a slot: German needs the dative ("aus
        // dem Büroarchiv") and English needs no article, so the level's name
        // cannot be interpolated into one shared sentence. Every line names
        // the level the way the product names it to the reader — office
        // archive, project, conversation. There is no line for several at
        // once, because the collective noun for them is OURS, not theirs, so
        // `several` states plainly WHAT is being read.
        documents: {
          archiv: 'Reviewing documents from the office archive …',
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
          // The first pool was not enough; other formulations are being tried.
          // The formulations are the model's words, so they stay off the line.
          requery: 'First results are not enough — searching with other terms …',
        },
        // Non-retrieval tools the user asked for by name. A tool with no entry
        // gets no line at all: its internal name is not a status.
        action: {
          remember: 'Saving the note …',
          card: 'Building the result card …',
        },
        // The product's trust proposition said out loud: what is checked is not
        // "the citations" in the abstract but every one of them, against what
        // was actually retrieved.
        citations: 'Checking every citation against the sources …',
        // A citation or a quote failed verification; one more search and one
        // rewrite are tried before the answer ships with its markers.
        repair: 'A citation did not hold up — searching again …',
        escalation: 'A quick lookup is not enough — starting deep research',
      },
    },
    // The one skill event a reader sees, keyed on WHO decided. Two sentences
    // rather than one with a swapped verb — that difference is not a word in
    // every language. `{skill}` is the office's authored `grid-title` and
    // travels verbatim: it is their name for their own method.
    skill: {
      activated: 'Applying the “{skill}” skill',
      forced: 'Applying the “{skill}” skill you asked for',
    },
    // Compact "what actually ran" chips in the Herleitung basis — one chip per
    // executed agent/tool, without the technical-steps opt-in.
    executedSteps: 'Ran:',
    stepName: {
      webSearch: 'Web search',
      ris: 'RIS',
      corpus: 'OIB knowledge',
      assistant: 'Assistant',
      reading: 'Reading',
      // One chip per skill the turn actually applied. `{name}` is resolved by
      // the single label authority (features/skills/lib/skill-activity).
      skill: 'Skill: {name}',
      // The bare `use_skill` frame with no identifiable skill behind it.
      skillUnnamed: 'Skill',
    },
    // Reader-facing names for the nodes and tools the backend emits, used by
    // the opt-in technical panel. The names on the wire are internal ids
    // (`knowledge_search`) — and NAT also forwards LangChain span names, which
    // are CamelCase class names — so the panel resolves every row through this
    // map instead of title-casing whatever arrived. Entries that a chip already
    // names reuse `stepName.*` above: one node, one wording, everywhere.
    nodeName: {
      // The root frame that is open for the whole turn, not a step within it.
      workflow: 'Whole exchange',
      clarification: 'Clarifying question',
      deepResearch: 'Deep research',
      dataSources: 'Data sources',
      note: 'Note saved',
      card: 'Result card',
      documents: 'Document list',
      askUser: 'Question to you',
      model: 'Building model',
      measure: 'Model measurement',
      compliance: 'Compliance check',
      skillSelection: 'Skill selection',
      // A node this build has no name for. It keeps its row — the panel counts
      // its steps and each carries a timestamp, so dropping rows would make the
      // list disagree with the count and hide that something ran — but it says
      // only that something internal ran. The raw name is not a vocabulary a
      // reader can learn (unlike a `status:` slot, which is one and stays
      // verbatim on purpose); it is whatever the framework called that span.
      internal: 'Internal step',
    },
    showThinking: 'Show thinking ({count})',
    showThinkingSteps: 'Show thinking steps ({count})',
    // The trace's header line, built from two clauses. The sources clause is
    // ABSENT when there are none: "0 sources" is a true number that reads as a
    // failure, and an answer grounded in a measurement of the model rightly has
    // no citations. The line counts what is there and says nothing about what
    // is not.
    herleitungSummary: 'Trace · {count, plural, one {# step} other {# steps}}',
    herleitungSummaryWithSources: '{summary} · {count, plural, one {# source} other {# sources}}',
    // The turn has reported no step yet, so the line says what it is instead of
    // counting to zero.
    herleitungSummaryNoSteps: 'Trace',
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
    // The files hung on THIS message. The data sources toggled on in the
    // composer are availability, not activity, and are deliberately not listed
    // here — what ran is the `executedSteps` row above.
    attachedFiles: 'Attached files:',
    // One-liner when this turn escalated from shallow to deep research.
    escalationNarration: 'Escalated to deep research: {reason}',
    node: {
      framingTab: 'Framing',
      framingTitle: 'Question understood',
      framingQuestion: 'You asked: “{question}”',
      contextLabel: 'Context',
      sourcesTab: 'Sources',
      sourcesTitle: 'Sources examined',
      findingsTab: 'Assessment',
      // Reasoning-only detail in the assessment node: which source lanes
      // produced hits. NOT the answer's trust verdict (confidence/provenance) —
      // that lives once, on the answer card.
      findingsHits: 'Hits in: {lanes}',
      // The proof-of-work tally, stated where the fan converges: what was
      // actually read, before naming which strata it came from.
      findingsTally: '{hits, plural, one {# hit} other {# hits}} across {docs} documents',
      findingsTallyOne: '{hits, plural, one {# hit} other {# hits}} in 1 document',
      // While the turn streams there is no assessment yet, but the graph still
      // needs its converge point — otherwise the source columns dangle and the
      // shape jumps when the answer lands.
      findingsPendingTab: 'Assessment',
      findingsPending: 'Weighing the sources …',
      // The search did not finish; it ran into its iteration ceiling. It
      // belongs in the assessment node because that node answers "what was
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
          noCards: 'The report is complete, but the proposals derived from it could not be produced.',
        },
      },
      branchesTab: 'Next steps',
      branchesSub: 'Pick one option — the answer is assembled for your choice.',
    },
  },
  deepResearch: {
    stats: {
      toolCalls: '{count, plural, one {# tool call} other {# tool calls}}',
    },
    success: {
      heading: 'Report Completed!{stats}',
      subheading: 'Research has finished and a report is ready to view in the research panel.',
      // Rendered ONLY when the report really was filed and has a document id.
      // Absent with nothing having been promised — no project, a run older than
      // the feature — the banner says nothing rather than claiming a file that
      // does not exist.
      filedLine: 'Filed in the project: {filename}',
      // The retraction of `starting.filingDisclosure`, and only that: the
      // starting banner promised „wird abgelegt", the server attempted the
      // filing (there was a project) and it did not land. A reader who saw the
      // promise otherwise walks to Berichte, finds nothing, and the only record
      // is a server log they cannot read. No reason travels — a refused quota,
      // a revoked `project:documents:write` and a report too long to render are
      // one fact here: the document is not there. Same quiet line as the
      // promise, no red and no error state: the research itself succeeded. The
      // folder is named in German because that is what the folder is called.
      filingFailedLine: 'The report could not be filed under “Berichte”.',
    },
    failure: {
      heading: 'Report Failed to Complete',
      subheading:
        'Something prevented the research report from completing. Check the thinking for details.',
    },
    cancelled: {
      heading: 'Research Cancelled',
      subheading:
        'Research was stopped by user. You can view any partial progress in the research panel.',
    },
    expired: {
      heading: 'Report Expired',
      subheading: 'The report has expired and is no longer available.',
    },
    starting: {
      heading: 'Starting Deep Research',
      subheading:
        'Chat is paused while the report is created to prevent generating multiple reports. You can click away while this runs — it may take several minutes.',
      // The disclosure that makes the authorization real. It sits on the
      // STARTING banner rather than the outcome: deep research escalates out of
      // a chat turn (there is no submit form), and a run can begin because the
      // agent itself escalated rather than because anybody ordered a report. The
      // moment the run can still be stopped is therefore the only moment at
      // which naming the destination is worth anything. No dialog and no
      // confirmation: a modal asked after the fact is only ever answered yes,
      // which makes it a ritual rather than a decision. Shown inside a project
      // only — outside one nothing is filed. The folder is named in German
      // because that is literally what the folder in the file tree is called.
      filingDisclosure: 'The finished report will be filed in this project under “Berichte”.',
    },
    viewReport: 'View Report',
    // The success banner's second action, when something was filed. Worded
    // apart from "View Report" on purpose: that opens the research panel, this
    // opens the file in the project — two places, two words.
    openInProject: 'Open in project',
    viewThinking: 'View Thinking',
    viewProgress: 'View Progress',
    // One-liner above the "Starting Deep Research" banner when the turn
    // escalated from shallow to deep research (WP-A `escalation_reason`).
    escalationNarration: 'Escalated to deep research: {reason}',
  },
  error: {
    showDetails: 'Show details',
    hideDetails: 'Hide details',
    // Retry action on an errored answer (design language: "helpful message + retry").
    retry: 'Try again',
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
    responseInterrupted: {
      title: 'Response Interrupted',
      message: 'Your previous request was not completed. Please resend your message.',
    },
    workflowError: {
      title: 'Request Failed',
      message:
        'The assistant hit an unexpected error while handling your request. Please try again.',
    },
    deepResearchFailed: {
      title: 'Deep Research Failed',
      message: 'The deep research process encountered an error.',
    },
    deepResearchLoadFailed: {
      title: 'Research Data Unavailable',
      message: 'Unable to load research data. The job may have expired or been deleted.',
    },
    unknown: {
      title: 'Something Went Wrong',
      message: 'An unexpected error occurred. Please try again.',
    },
    // Deep-research job rejected because the queue is full (WP-A
    // `job_admission_rejected`). Warning, not error: resending resolves it.
    researchQueueFull: {
      title: 'Research is busy',
      message: 'The research queue is currently full. Please resend your request in a moment.',
      retryHint: 'Please try again in about {seconds, plural, one {# second} other {# seconds}}.',
    },
  },
  // User-facing deep-research error copy raised from the SSE hook and the
  // job-data loading hook (use-load-job-data.ts).
  deepResearchErrors: {
    interrupted: 'Research was interrupted before completion.',
    reportUnavailable: 'This research report is no longer available.',
    serviceUnreachable: 'The service is currently unreachable. Please try again later.',
    loadFailed: 'Research data could not be loaded.',
  },
  // Toasts fired when a session is deleted but its deep-research job could not
  // be cancelled on the server.
  sessionActions: {
    researchMayStillRunTitle: 'Research run may still be running',
    researchMayStillRunDescription:
      'The session was deleted, but its deep-research job could not be stopped on the server.',
    researchRunsMayStillRunTitle: '{count} research {runLabel} may still be running',
    researchRunsMayStillRunDescription:
      'Sessions were deleted, but some deep-research jobs could not be stopped on the server.',
    runSingular: 'run',
    runPlural: 'runs',
  },
  budgetExhausted: {
    title: 'Budget exhausted',
    memberMessage:
      'Your usage budget is used up, so new messages can’t be sent right now. You can review your own usage under Organization → Usage & budgets. Ask an organization admin to raise your limit.',
    adminMessage:
      'The usage budget is used up, so new messages can’t be sent right now. Raise the limits under Organization → Usage & budgets.',
  },
  fileUpload: {
    uploading:
      'File is uploading and ingesting. Until completion, a file cannot be included in queries.',
    pendingWarning:
      'Files are pending! Wait until they are ready or send your query again to continue WITHOUT those files.',
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
      quoteUnverified: 'A quote could not be verified verbatim against the source; the assessment is capped accordingly.',
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
  },
  // Per-answer thumbs feedback (WS-7, `answer-feedback` flag).
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
    commentSubmit: 'Send note',
  },
  // Copy message button on user message bubbles
  copyMessage: {
    copy: 'Copy message',
    copied: 'Copied',
    failed: 'Message could not be copied',
  },
}
