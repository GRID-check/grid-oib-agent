# Upload governance — working log (2026-10-01, overnight)

Branch `claude/nvidia-toolkit-data-validation-rbnyi6`. Request, in the user's words:
can the NVIDIA Agent Toolkit validate that nothing sensitive is uploaded; can an
organization build its own roles (WorkOS) and restrict folders and their documents
to the people holding them; screen new uploads against admin-defined sensitive
terms and hold matches in a quarantine an admin clears before anything reaches a
model; notify the uploader in the inbox when an ingestion completes, with a modal
summarising what arrived and where. Plus triage of the ten "Upload & Datenablage"
tickets (Jonathan, 1 Oct 2026). Done means evidence.

Entries are appended in time order. Each says what was done, what it proved, and
where the evidence is.

## Log

- **Orientation.** HEAD `f62552a`. NAT installed: `nvidia-nat` 1.9.0 (core,
  langchain, mcp, eval, profiler, opentelemetry, phoenix). Prior art found:
  `docs/audit/pilot-feedback-triage-2026-09.md` already established that the
  Archiv is one table (ADR-0024), that `projects` has no status column, that a
  per-org blacklist does not exist (org `settings` jsonb is its home), and that
  `@redactpii/node` is already bought for the platform-lessons scrub.
- **WorkOS, read-only (Staging `environment_01KEF0YG238…`).** FGA is live with
  three resource types `organization → project → skill`; no `folder` type. Seven
  organization roles (member, admin, org-auditor, org-billing-admin,
  org-knowledge-manager, org-compliance-officer, org-user-admin) and four
  project-scoped roles (project-viewer, -contributor, -editor, -admin), all
  environment-wide. Role config: `multipleRolesEnabled: false`,
  `ssoRoleAssignmentEnabled: false`, `dsyncRoleAssignmentEnabled: false`.
  The API offers organization-scoped `createRole`, resource-scoped role
  assignments, and Directory-Sync group→role mappings — the last is the
  "take the rights over from the office server" path Ticket 6 asks the CTO about.
