/**
 * `feedbackExport` namespace — the words inside the answer-feedback workbook
 * (Plattform → Antwortqualität → Bewertungen → Exportieren).
 *
 * The file leaves the product, so every header, sheet name and note in it is
 * written down here rather than in the builder. `columns` and `weeklyColumns`
 * are keyed by the column's stable CSV key (`lib/feedback/export-columns.ts`);
 * the column definitions are typed against these keys, so a column without a
 * label or a description does not compile.
 */
export const feedbackExport = {
  sheets: {
    votes: 'Votes',
    weeks: 'Weeks',
    overview: 'Overview',
    columns: 'Columns',
  },
  formats: {
    text: 'Text',
    id: 'Identifier',
    integer: 'Whole number',
    decimal: 'Decimal number',
    usd: 'US dollars',
    seconds: 'Seconds',
    boolean: '1 = yes, 0 = no',
    datetime: 'Date and time, UTC (ISO 8601 in the CSV)',
    date: 'Date, UTC (YYYY-MM-DD)',
    week: 'ISO week (YYYY-Www)',
    url: 'Link',
    list: 'List, separated by ";"',
    percent: 'Share 0–1 (shown as % in Excel)',
  },
  dictionaryHeader: {
    key: 'Key (CSV header)',
    label: 'Column',
    description: 'Meaning',
    format: 'Format',
    source: 'Source',
  },
  columns: {
    feedback_id: { label: 'Vote ID', description: 'Stable id of the vote. One row per vote.' },
    voted_at: {
      label: 'Voted at (UTC)',
      description: 'When the vote was last cast. A re-vote (another verdict, reason or comment) moves it.',
    },
    first_voted_at: {
      label: 'First voted at (UTC)',
      description:
        'When the vote was first cast. The window, the page and the weekly sheet count by this time.',
    },
    vote_changed: {
      label: 'Vote changed',
      description: '1 when the vote was changed more than a second after it was first cast.',
    },
    vote_date: { label: 'Date (UTC)', description: 'Calendar day of the first vote, UTC.' },
    iso_week: { label: 'ISO week', description: 'ISO week of the first vote, UTC — matches the weekly sheet.' },
    verdict: { label: 'Verdict (key)', description: '"up" (helpful) or "down" (not helpful). Stable for scripts.' },
    helpful: { label: 'Helpful', description: '1 for a helpful vote, 0 for a not-helpful one. Its average is the helpful rate.' },
    reason: {
      label: 'Reason (key)',
      description: 'Why a not-helpful vote was cast. A down-vote without a chosen reason counts as "other", as on the page. Empty on helpful votes.',
    },
    reason_label: { label: 'Reason', description: 'The reason as the voter saw it.' },
    organization_name: { label: 'Organization', description: 'Display name of the voter’s organization; empty when it could not be resolved.' },
    organization_id: { label: 'Organization ID', description: 'WorkOS organization id.' },
    project_name: { label: 'Project', description: 'The project the conversation belongs to; empty for a chat outside a project.' },
    project_id: { label: 'Project ID', description: 'Project id.' },
    bundesland: {
      label: 'Federal state',
      description: 'The project’s federal state from its profile (key, e.g. "tirol"); empty when the profile has none.',
    },
    conversation_title: { label: 'Conversation', description: 'Title of the conversation; empty when it was deleted or never saved.' },
    conversation_id: {
      label: 'Conversation ID',
      description: 'The conversation of the rated answer. Taken from the stored answer when there is one, otherwise from the vote.',
    },
    message_id: { label: 'Answer ID', description: 'Id of the rated answer.' },
    voter_key: {
      label: 'Voter (pseudonym)',
      description:
        'The same 12 characters for the same person in the same organization, so votes can be grouped by person. Not reversible to a name or e-mail, and the export carries neither.',
    },
    topics: { label: 'Topics (keys)', description: 'The conversation’s OIB topic tags.' },
    question: { label: 'Question', description: 'The user message the answer replied to; empty when the answer was not stored.' },
    answer: {
      label: 'Answer',
      description: 'The rated answer’s text; empty when it was not stored or its conversation was deleted. Cut at 32,767 characters in Excel (a cell’s limit); answer_chars has the full length.',
    },
    comment: { label: 'Comment', description: 'What the voter wrote with a not-helpful vote.' },
    expected_answer: {
      label: 'Expected answer',
      description: 'What the voter says a good answer would have contained. A claim, not a verified fact.',
    },
    answer_chars: { label: 'Answer length', description: 'Characters in the stored answer.' },
    answer_mode: {
      label: 'Answer mode',
      description: '"shallow" (quick answer), "deep" (researched), "meta" (about Piloti itself), "error", or "report" for a deep-research run.',
    },
    answer_confidence: { label: 'Confidence', description: 'The confidence Piloti showed with the answer: low, medium or high.' },
    confidence_capped_reason: {
      label: 'Confidence capped because',
      description: 'Why the shown confidence was lowered, when it was (e.g. no binding source).',
    },
    sources_cited: { label: 'Sources cited', description: 'Sources the answer cited.' },
    citations_removed: {
      label: 'Citations removed',
      description: 'Citations removed after the answer was written because they could not be verified.',
    },
    research_truncated: {
      label: 'Research cut short',
      description: '1 when the research stopped before it was finished (time or budget).',
    },
    skills: { label: 'Skills', description: 'Skills that shaped the answer.' },
    answered_at: { label: 'Answered at (UTC)', description: 'When the answer was stored.' },
    client_duration_s: {
      label: 'Duration in the browser (s)',
      description: 'Seconds from question to finished answer, measured in the asker’s browser — includes their network.',
    },
    llm_calls: { label: 'LLM calls', description: 'Model calls billed to this answer; empty when the usage ledger holds none for it.' },
    models: { label: 'Models', description: 'The models those calls used.' },
    tokens_total: { label: 'Tokens', description: 'Tokens of those calls, input and output together.' },
    cost_usd: { label: 'Cost (USD)', description: 'Provider cost of those calls in US dollars, before any customer pricing.' },
    lesson_id: { label: 'Lesson ID', description: 'The platform lesson distilled from this vote, if any.' },
    lesson_status: {
      label: 'Lesson status',
      description: '"candidate", "active", "retired", or "skipped" when the pipeline looked at the vote and made no lesson. Empty when it has not looked yet.',
    },
    lessons_holdout: {
      label: 'Lessons holdout',
      description: 'Lessons experiment arm: 1 = answered without platform lessons, 0 = with them, empty = no experiment running.',
    },
    app_url: {
      label: 'Open in Piloti',
      description: 'Link to the answer in its conversation. Opens for members of that organization only.',
    },
    langfuse_trace_url: { label: 'Open in Langfuse', description: 'The answer’s trace in Langfuse, when it has one.' },
    trace_id: { label: 'Trace ID', description: 'Langfuse/OpenTelemetry trace id of the answer.' },
  },
  topicColumn: {
    label: 'Topic: {topic}',
    description: '1 when the conversation is tagged "{topic}", else 0.',
  },
  weeklyColumns: {
    organization_name: { label: 'Organization', description: 'Display name of the organization.' },
    organization_id: { label: 'Organization ID', description: 'WorkOS organization id.' },
    iso_week: { label: 'ISO week', description: 'ISO week, UTC.' },
    week_start: { label: 'Week starts', description: 'The Monday the week starts on, UTC.' },
    answers: {
      label: 'Answers',
      description: 'Answers the week is about: produced in it, plus answers rated in it — the page’s coverage denominator. Turns that were never stored are only counted when rated.',
    },
    rated_answers: { label: 'Rated answers', description: 'Answers with at least one vote in the week.' },
    up: { label: 'Helpful', description: 'Helpful votes first cast in the week.' },
    down: { label: 'Not helpful', description: 'Not-helpful votes first cast in the week.' },
    helpful_rate: {
      label: 'Helpful rate',
      description: 'Helpful ÷ (helpful + not helpful). Empty under 5 votes, where a percentage is noise.',
    },
    coverage: { label: 'Coverage', description: 'Rated answers ÷ answers: how much of the week was rated at all.' },
  },
  overview: {
    title: 'Answer feedback export',
    generatedAt: 'Generated at (UTC)',
    windowFrom: 'Window from (UTC)',
    windowTo: 'Window to (UTC)',
    organizationsScope: 'Organizations',
    projectsScope: 'Projects',
    scopeEverything: 'all',
    filters: 'Rating filters',
    filterNone: 'none',
    filterVerdict: 'Verdict: {value}',
    filterReasons: 'Reason: {value}',
    filterTopics: 'Topic: {value}',
    filterModes: 'Answer mode: {value}',
    filterConfidences: 'Confidence: {value}',
    filterHasComment: 'only with a comment',
    filterHasExpected: 'only with an expected answer',
    filterQuery: 'Search: {value}',
    filterOr: ' or ',
    weeksFilters: 'Filters on the "{sheet}" sheet',
    weeksAllApplied: 'All filters applied.',
    weeksIgnored:
      'Date range, organizations, projects and topic applied. Not applied: {filters}. A rate needs both verdicts and every answer as its denominator, and these filters describe a vote, not an answer.',
    filterNames: {
      verdict: 'verdict',
      reasons: 'reason',
      topics: 'topic',
      modes: 'answer mode',
      confidences: 'confidence',
      hasComment: 'comment',
      hasExpectedAnswer: 'expected answer',
      query: 'search',
    },
    votes: 'Votes',
    up: 'Helpful',
    down: 'Not helpful',
    helpfulRate: 'Helpful rate',
    voters: 'People who voted',
    organizations: 'Organizations',
    rows: 'Rows on the "{sheet}" sheet',
    rowCap: 'Row limit',
    rowCapHit: 'Row limit reached (newest votes kept)',
    weeksCapHit: 'Weekly sheet cut (oldest weeks dropped)',
    yes: 'yes',
    no: 'no',
    notesHeading: 'Read before you quote a number',
    noteVoluntary:
      'Rating is voluntary, so these votes describe the people who chose to vote, not every answer. Read the helpful rate next to the coverage on the weekly sheet.',
    noteErased:
      'The question and answer of a deleted conversation are empty; the vote itself, including its comment, is still listed.',
    noteTimes: 'All times are UTC.',
  },
  verdicts: {
    up: 'helpful',
    down: 'not helpful',
  },
}
