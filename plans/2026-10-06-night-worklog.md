# Night of 6–7 Oct 2026: from one PR to a reviewed stack

The product owner's request (1 Oct, restated 6 Oct 18:00), verbatim in
[`2026-10-01-upload-governance-worklog.md`](2026-10-01-upload-governance-worklog.md)
and the ten tickets in [`docs/audit/upload-and-filing-triage-2026-10.md`](../docs/audit/upload-and-filing-triage-2026-10.md).

What "done" means tonight, in the product owner's words: "work on this all night
till it is done and you truly understand everything … use many subagents. Done
means evidence", and "the work then must be split into many PRs and you must
make sure everything is addressed".

## What I take that to mean

1. Every sentence of the request and every checkbox of tickets 4, 5 and 6 is
   traced to code and a test that proves it, or named as a gap and closed.
2. The tickets that were only triaged (1, 2, 3, 7, 8, 10) are triaged
   "extremely well": every claim checked against today's code, which has moved
   (develop gave the Archiv folders on 6 Oct), product questions stated, smallest
   slices sized. Ticket 9 stays out of scope (product owner, 1 Oct).
3. PR #838 (567 files, past CodeRabbit's 100-file limit) becomes a stack of PRs a
   person can review, each green on its own.
4. The answer suite runs before and after (owed since the first commit).

## State at the start (18:10 UTC)

- PR #838 head `8bb2200d3`: develop merged twice today, CI fully green (first full
  run since 2 Oct: a conflict with develop had kept `pull_request` workflows off).
- Papierkorb: finished on the old structure, being ported onto the merged code
  (an agent; the folder-bin migration becomes 0113).
- Open from the last verifier round: card provenance, the revision task's
  `sourceText`, runs and tasks refused instead of inheriting a restriction,
  `shown_notes` keyed by collection, `requireProjectAccess` reading the admin bit
  from the token, named reviewers not checked against folder read.

## Log

| Time (UTC) | What | Evidence |
|---|---|---|
| 18:10 | Started: traceability audit, re-triage, split design, answer suite, in parallel | this file |
| 18:20 | Product owner: the project lifecycle (ticket 1) and looking into other projects (ticket 3: Bibliothek, and an agent tool across projects) are to be BUILT, not only triaged. Plan: a workflow (design with two competing designs for cross-project search, build in slices, adversarial verify) once the re-triage lands | message 18:20 |
| 18:25 | Constraint: the account's 7-day usage limit is in warning. Agents are paced; every stop point leaves work committed and pushed | `get_session` rate_limit_info |
| 18:40 | Papierkorb ported onto the merged structure (agent): 12,122 UI tests, 276 RLS tests, 4 revert-checks. It also found and fixed a bug on the head: a folder upload refused a second level (`Neu/Unterordner`) in any project with a custom folder, because the walk read access before creating | branch `wave3-papierkorb-port` `1a9575397` |
| 18:50 | Folder bin renumbered to 0113 (develop's 0103 again); merged onto the head; hunks whose unchanged lines carried old numbers shifted by hand (5 lines). The blocked revert-check run here: routing a project delete to the shelf delete fails 3 of 50 | `papierkorb-int` `f68395ff8` |
| 18:50 | Gap list additions from the port: the role-deletion guard ignores binned folders; nothing structurally forces every logged byte-reader through `getAccessibleDocument` | port report |
| 19:00 | Papierkorb merged onto the head and pushed: 12,136 UI tests (4 shards), 285 RLS tests, all green | PR head `a819df0c3` |
| 19:05 | Re-triage done (tickets 1, 2, 3, 7, 8, 10; 9 one line by the product owner's word: "stop the research for cheaper storage"). Traceability audit done: NAT conclusion holds on 1.9.0 (and `nvidia-nat-security`/`nemoguardrails` cannot even install on our Python 3.14); 18 gaps ranked, the worst: quarantined files readable by every member, the Büroablage not restrictable, no per-file access, revision tasks and platform lessons carrying restricted content | `docs/audit/upload-governance-traceability-2026-10-06.md`, `docs/audit/upload-and-filing-retriage-2026-10-06.md` (`790cbc2b0`) |
| 19:05 | Product owner's decisions: a closed project is readable by every member (restricted folders stay restricted); read-only with chat allowed; Ausmisten = an AI proposal over the documents that the person can override; Archiv → Büroablage; no Bibliothek page: a scoped cross-project search for the agent, solo chats only | AskUserQuestion 19:00 |
| 19:05 | My call on the ticket 5/6 contradiction (audit gap 7): the name gate keeps blocking by default (ticket 5); releasing a match into an open folder offers to restrict it (ticket 6's hint) | here |
| 19:10 | Launched: workflow `leak-and-gap-fixes-wave-a` (6 fix groups, each adversarially verified, repaired if refuted); cloud session for ticket 1 (4 stacked slices); cloud session for ticket 3 (cross-project tools) | `wf_52c08b78-221`, `session_01VE6X4R4NUqQFxgqPCPDMhK`, `session_01JQBjCfCWbQEqJzaLTSs1RR` |
