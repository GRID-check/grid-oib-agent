# What develop changed, and how our stack fits it

Our stack has 29 levels (PRs #855 to #883) that sit on top of `develop`. Under them, develop moved by about 85 commits. This report covers three things: what develop changed and why, where our stack already fits, and what we must fix before merging.

## What develop changed

### 1. The backend is split into "chat" and "api", and Dask is gone (#900)

The Python backend used to run as one web process. It now runs as two. The "chat" part holds the live chat connection, and the "api" part answers every other request. A new test checks that each route belongs to exactly one of the two. The same change removed Dask, an older system for running research jobs. Every research job now waits in a database queue until a separate worker picks it up. Uploads are processed only by the ingest worker, which stores its progress in the database so the api part can report it. The goal is to scale chat and background work separately.

### 2. A connection pooler in front of the database

The database allows 200 connections, and our services together could ask for several times that. Develop put PgBouncer in front of it. PgBouncer is a "pooler": many clients share a few real connections, one transaction at a time. That breaks anything that needs a connection to last longer than one transaction, such as long-held locks or listening for notifications. Those uses now get a "direct" connection, and every database address must state which route it takes. The deployment plan fails if the total connection count goes over budget. Locks that must outlive a transaction got their own direct connection, and they refuse to work if it is missing. All of this is recorded in ADR-0083.

### 3. The OIB base corpus moved into object storage

The OIB norms used to sit on one server's disk. They now live in SeaweedFS, our file store, with a database table listing them. Each file that needs indexing becomes an ordinary job on the ingest queue, and the worker downloads and checks the file itself. Admin uploads go through two new BFF routes (the BFF is our web server between the browser and the backend), because the backend may only read from storage. A one-time job copies the old files across. These jobs belong to no office and carry no screening, because they are public norms uploaded with the platform admin key.

### 4. Fair queues, autoscaling and a model rate limiter (#847)

This landed just before our base, but the stack has to follow it. All background work goes through queues that share fairly between offices. The office with the fewest running jobs goes first, then interactive work before bulk work, then the oldest job. Long walks over a whole project, such as re-indexing, run on a separate internal pod called "bff-jobs", not on the pods that serve users. KEDA, a tool that adds or removes workers based on queue length, scales each pool. Every model call passes one rate limiter with four classes: chat first, then interactive, then research, then bulk. Later commits replaced the backend's built-in housekeeping loops with scheduled jobs.

### 5. Stricter release notes and leaner CI

A PR that touches product code must now *add* a release-note file. Editing an existing note no longer counts. New internal sections (security, incident, operators) satisfy the check but are never published on piloti.at. The rule of thumb: if a reader would learn that Piloti once lost, kept or showed something it should not have, the line belongs in "incident". A short list of alarm words such as "vulnerability" or "CVE" is now refused in public sections. CI also dropped some workflows, runs every lint hook, can reuse a green run for identical code, and requires Python 3.14.1.

### 6. Voice dictation in the chat box

A new microphone button records up to 45 seconds of speech. The audio goes to an external transcription model through OpenRouter: ElevenLabs Scribe first, Whisper as the fallback, or OpenAI for an office that uses its own key. Filler words are removed, and the text lands in the chat box exactly like typed text. Nothing is sent until the person presses send. The cost is recorded but not billed. The audio itself is not screened.

### 7. Storage links signed for the right address

Three links the backend uses were signed with the file store's *browser* address. Inside the cluster that address points to the wrong place, so some uploads could never work. Develop added `presignForBackend`, which signs with the internal address. Every link the backend reads or writes now uses it, and links meant for the browser keep the public address. Develop also fixed the bucket setup in the local Compose environment.

### 8. Run access by signed scope (ADR-0084)

This is the authorization half of #900. Before it, only the person who started a run could open or stop it. Now the BFF checks the caller's project and conversation rights and signs that "scope" with a timestamp. The backend accepts the scope only if the signature is valid, it belongs to the logged-in user, and it is less than 6 hours old. The run's owner may do anything. A member of the same project may read and steer the run. A reader of the same conversation may only read it. In effect, every project member with chat permission can now read and steer every run in the project.

### Smaller changes

- Langfuse, the tool that records model calls, moved to version 4.54.
- Backend housekeeping now runs as scheduled jobs.
- New rule for the list of known pitfalls: a pitfall in our own tooling is fixed in code, and its entry is deleted, in the same change.
- Several lint tools were updated.

## Where our stack fits cleanly

- **Backend split:** Our new routes sit on the api part and pass the role test. Nothing in the stack still refers to Dask. Restricted collections are mapped back to their project by the same function that submitting and access checks both use. Every way of starting a run still refuses a closed project.
- **Pooler:** Every lock we add lasts only one transaction, so the pooler does not affect it. We use no feature that needs a longer connection, add no database address, and make no outside call while holding a lock.
- **Base corpus:** Our upload screening travels inside the queued job, and its result is stored where the api part can read it. Nothing in the stack assumes files on local disk.
- **Queues and limiter:** Our cleanup proposal and memory check both pass the rate limiter. Chat masking makes no model call and works however chat is scaled. We add no background loops.
- **CI:** The `claude/**` triggers, the lints, the link and ADR checks and ruff all pass. We do not touch the Python version.
- **Dictation:** Dictated text goes through the same screening as typed text, and the server masks it again as a safety net. The merge is clean, and our database migrations do not collide with develop's.
- **Storage:** We add no new place that signs links. Every re-dispatch goes through develop's signing functions.
- **Run access:** A run's scope never contains a restricted collection, and the browser cannot ask for one. A confined conversation cannot become a run, and runs only see open project memory.

## Confirmed gaps, ranked

"Confirmed" means two independent reviewers both found the gap to be real. They never split on whether a gap exists. Where they agree it exists but disagree on the fix, the owner or the severity, the gap is marked **disputed**.

**1. Blocker: ten PRs fail the release-note check.**
- **Affected PRs:** #860 (04), #861 (05), #862 (06), #863 (07), #864 (08), #865 (09), #866 (10), #867 (11), #869 (13) and #871 (15). Each one only edits the shared note `sensible-daten-und-quarantaene`, and under develop's new rule that no longer counts. None of them can merge.
- **Fix:** In each level, run `task release:note -- <slug>`. Move that level's bullets into the new file and remove them from the shared note, so the changelog does not repeat them. Then check each level with `ci/require_release_note.py <level below> <level>`. The "no release note" label is not an option, because customers can see these changes.

**2. High: restricting a folder re-indexes the whole project inside the user's request (level 09).**
- **What happens:** Up to 100 documents are re-indexed at a time on a user-facing pod, at interactive priority. A colleague's upload then waits behind thousands of re-reads, which is exactly the case develop's queue rules were written to prevent.
- **Fix now:** Add `priority: 'bulk'` in `collection-placement.ts:194` and `folder-bin.ts:347`, plus a test that pins it.
- **Follow-up:** Keep the purge step, which matters for security, inside the request. Move the re-indexing into a queued bulk job modelled on "reindex project".

**3. High: Papierkorb restore, delete and purge run inside user requests (level 17).**
- **What happens:** If a deployment cuts off a restore, the remaining documents still look indexed but have no search data, and nothing repairs them. A delete that is cut off leaves a folder in the bin that is still searchable.
- **Fix:** In the same transaction as the restore, mark the restored documents "pending". Then re-index them as a queued bulk job. A delete should either record an unfinished purge so a sweep can finish it, or refuse large folders. Moving the final purge is optional.

**4. High or medium (severity disputed): dictation sends audio to an outside model before any screening (level 07).**
- **What happens:** ADR-0085 and the screening notice ("Piloti sendet sie nicht an das Modell") promise that nothing sensitive reaches a model. Spoken IBANs and terms do reach the transcription model, and no document says so.
- **Fix:**
  - Add dictation to ADR-0085's list of unscreened paths and to the user guide's "Nicht geprüft" list.
  - Reword the notice to "Antwortmodell".
  - Add a cross-link from the dictation architecture document to ADR-0085.
- **Your decision:** Should the microphone be hidden when an office has screening switched on? Whether the server should also mask the transcript is **disputed**: one reviewer calls it optional extra safety, the other calls it unnecessary.

**5. Medium: names of restricted documents leak into a run's "Grundlage" (level 11; owner disputed, one reviewer says level 09).**
- **What happens:** A cleared member can add a restricted file to a teammate's run. Because of ADR-0084, every project member can then read its name in the run's progress and in the report.
- **Fix:** Check every document named for a run against restricted folders, and refuse the request. Apply the check when adding a document, when commissioning a run, and on the plan-card path. Refuse `job/*/documents` in the generic job proxy, and filter restricted files out of the picker. A second check in the backend is optional.

**6. Medium: "Endgültig löschen" silently skips deleting Langfuse traces (level 17).**
- **What happens:** The BFF pod has neither the Langfuse settings nor network access to Langfuse, yet the purge is recorded as done.
- **Fix:** The BFF stops calling Langfuse. Hand the folder back to the purger, which can reach Langfuse, or let the scheduler finish it (which of the two is **disputed**). Remove the import, and add a test that the frontend has no Langfuse settings.

**7. Medium: public release notes describe permission holes (levels 27, 22, 14, 15, 23).**
- **What happens:** Under develop's new rule, these lines would tell everyone that quarantined files, blocked file names, chat titles and pictures were once exposed.
- **Fix:** Move these lines to "security" or "incident". If a hole never shipped to customers, fold the correct behaviour into the feature text instead. The picture line describes develop's old behaviour, so it belongs in "incident". Which section fits each line is **disputed**.

**8. Medium: level 02 raises a WebSocket header limit that develop's ADR-0077 forbids.**
- **Fix:** Both reviewers say: revert level 02 entirely (the setting, its pitfall entry, its environment-variable row, its tests and its release-note line). If that leaves #858 empty, close it.

**9. Low: in a closed project, the generic job proxy still lets someone add a document to a running run (level 18).**
- **Fix:** Refuse `job/*/documents` in the proxy, or remove it from the proxy so the project runs route is the only way in, and add a route test. Whether "write now" should be refused as well is **disputed**.

**10. Low: an image link that was already handed out keeps showing a file after a replacement put it into quarantine (level 27).**
- **Fix:** In `streamDocumentImage`, refuse a quarantined document to anyone but its uploader, and shorten how long the image may be cached. The approach is **disputed**: a simple uploader check, or a reviewer-aware check carried in the signed link.

**11. Low: two new pitfall entries describe our own tooling (levels 09 and 18).**
- **Fix:** Make `rls-test-db.sh` pick a free port and delete row 32. Moving row 31 into a script comment is optional.

## Raised but not confirmed

Reviewers did not uphold these findings. Each is worth a look, but none blocks the merge:

- the folder purge holding a pooled database connection open during outside calls;
- the base corpus's exemption from screening not being written down;
- `/v1/ingest` still accepting a request with no screening field;
- a green stacked PR leaving a marker that develop's reuse logic would trust;
- the AI-Act note not listing the dictation model;
- a run report in a restricted folder staying readable through the job routes;
- an out-of-date code comment in `restricted_collections.py`.