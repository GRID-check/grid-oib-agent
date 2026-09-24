# The answer repair pass after ADR-0066: alternatives

Research, 2026-09-24. Paths are relative to the repository root; line numbers
are as of that day.

**Landed since**, from the recommendation below: a quote no passage holds is
marked when the prose settles, not at the terminal frame
(`settle_streamed_citations`); a card's `[N]` follows its source through an
adopted rewrite and is dropped when the rewrite no longer cites it
(`rewrite_numbers`, `recite_surface(strict=True)`); the answer suite counts
`repair_adopted`, `repair_discarded` and `settled_replaced` (the terminal text
differing from the settled one) apart. The span-level repair (§5) is built,
narrower than sketched: ADR-0067 replaces only the quotation's inner text
with the passage's verbatim wording, never the sentence. **Open**: the
structural option.

## 1. What the reader should be able to rely on

Two things:

1. A citation or quote that did not verify is never shown as real. This is the core promise.
2. Once the settled snapshot arrives, the text the reader is reading stays put. Numbers,
   sentences and length do not change under their eye.

Today the repair keeps (1) and breaks (2). An adopted rewrite replaces the whole streamed
answer 10-25 s after the settled snapshot (ADR-0066, "Bad, because the text can still change").
The source-count guard in `_adopt_if_better` (`answer_pipeline.py:458-492`) blocks the one
case that was recorded (9 sources down to 2). Any rewrite it does adopt still swaps every byte.

## 2. What the code does today (facts that shape the options)

| Fact | Where | Why it matters |
|---|---|---|
| The snapshot runs `verify_citations` + `sanitize_report` only. It does **not** run `verify_quoted_spans` or `annotate_unverified_quotes` | `settle_streamed_citations`, `answer_pipeline.py:635-660` | A failing quote is shown **unmarked** at the snapshot and marked only at the terminal frame. So the text changes even when the repair is off or gets discarded. The snapshot shows a quote that did not verify as if it had verified, for 2-25 s. That is a small breach of promise (1) that exists today. |
| A removed citation is already subtractive at the snapshot: the unresolvable line and its inline `[N]` are gone before the reader gets past them | same | For removed citations, all a repair can do is put a citation back 15 s later. Restoring a citation is exactly the kind of swap we want to avoid. |
| The rewrite is a frontier call with the full system prompt and history, JSON envelope mode, plus up to 2 retrievals (each with rerank and requery) | `repair.py:repair_answer`, `ainvoke_with_envelope_json_mode` | This is where the 10-25 s go. Timings: `turns-per-answer-audit-2026-09.md:128` gives 16 s and 23 s. `latency-and-caching-audit-2026-09.md` §3.8 notes there is still no wall-clock bound. |
| `_clean_rewrite` keeps only the rewrite's prose. Cards, masthead and confidence all come from the **original** envelope | `repair.py:_clean_rewrite`; `finalize_answer` uses `extracted.meta` | After adoption, `_recite_surface_cards` (`answer_pipeline.py:620`) holds the original cards' `[N]` to the **rewrite's** renumber map and cited set. If the rewrite orders its sources differently, a card's `[3]` can pass the "is cited" check and still point at a different document than the card author meant. This is a latent citation-integrity risk that any whole-answer rewrite carries. (Inferred from the code. No test pins it.) |
| The repair's retrievals bypass the tool node. They never appear in the retrieval ledger | `docs/api/websocket-protocol.md:442` ("absent by design") | An adopted repair cites sources the Herleitung never shows were fetched. |
| `verify_quoted_spans` is pure and cheap, and returns offsets (`UnverifiedQuote.start/end`), a `reason` (`not_verbatim` / `too_long` / `uncited`) and `best_coverage`. It does **not** say which chunk came closest | `citation_verification.py:2909-2928, 3114-3179` | Offsets and reason are all a span-level patch needs. Returning the best-matching entry is one small change. |
| `annotate_unverified_quotes` already patches by offset, right to left, and is idempotent | `citation_verification.py:3182-3199` | There is already a precedent for editing a span in place. |
| The frontend replaces the whole text on the snapshot and again on the terminal frame (`replaceStreamingAgentResponse`, `finalizeAgentResponse`) | `frontends/ui/src/features/chat/hooks/use-websocket-chat.ts:1429-1432` | If the terminal text differs from the snapshot in one sentence only, just that sentence moves. The `diff` package (v9) is already a dependency (`frontends/ui/package.json:87`, used in `lib/documents/version-diff.ts`), so the client can highlight a change without any change to the wire contract. |

## 3. How often it fires, and why

These are all the data points in the repo:

- ADR-0066: 5 repairs in one 25-question sweep, 0 in the next.
- `docs/architecture/turns-per-answer-audit-2026-09.md:125-131`: a repair fired on a citation
  nobody had lost. Merged duplicates were counted as failures, and the pass cost 16 s and 23 s.
  Fixed at the cause with `lost_citations`.
- The same file, lines 171-180: both RIS questions ended every run in a repair. The model had
  copied the block's `Source URL:` as a citation. Fixed at the cause: the line is gone, and a
  key-cited line that carries a link is now verified by its key. The result was no repair in
  six runs, and 87→29 s and 88→33 s.

So every repair the audits examined was caused by a verifier false positive or a mismatch in
the grammar. Neither was a model misquoting a passage it had read. Both were fixed upstream.
The drop from 5 to 0 came from prevention, not from the repair.

Measurement gaps:

- The suite's `repair` signal (`scripts/turn_census/suite.py:60`) matches the substring
  `"repair pass"`. That substring appears in both `repair pass adopted` and `repair pass
  discarded`, so "5 repairs" does not say how many actually changed the text. A repair that
  returns `None` (no lookups, empty retrieval) logs neither line.
- Production `citation_events.record_turn` (`ledger.py:140`) records failures *after* the
  repair. Pre-repair failure counts and the repair outcome are not persisted anywhere.
- Nothing records how often the terminal text differs from the settled snapshot, which is the
  number the reader actually experiences.

## 4. Options

Latency is time added to the terminal frame on a turn that has a failure. Clean turns cost
nothing in every option.

| # | Option | What it fixes | Cost | Integrity risk | Code touched |
|---|---|---|---|---|---|
| A | **Status quo**: whole rewrite, adopted if it has fewer failures and at least as many cited sources | Misquotes, sometimes | +1 frontier call with full history, +≤2 retrievals, 10-25 s; ~400 lines in `repair.py` | Swaps text the reader has read; card `[N]` can be re-bound; sources the ledger never shows | — |
| B | **Subtractive only** (`repair_pass: false`) plus measurement | The swap, all the cost | 0 calls. A config flip, then deleting ~450 lines of `repair.py`, `_verify_with_repair` / `_adopt_if_better` and their tests | None. The markers are the floor already | `configs/config_oib_openrouter.yml:863`, then deletions |
| C | **Span-local quote patch**: fix only the failing quote's sentence, keep the rest byte-identical | Misquotes of a passage that *was* retrieved. The text change shrinks to one sentence | 1 short call (sentence + one passage, no history, no retrieval), roughly 2-5 s, only on `not_verbatim` quotes with a near-miss passage. ~120 new lines against ~300 deleted | Low. The patch is re-verified with the same verifier, and it cannot add a source | `citation_verification.py` (return the best entry), new `piloti/quote_patch.py`, `answer_pipeline.py` |
| D | **Settle quotes at the snapshot**: run `verify_quoted_spans` + `annotate_unverified_quotes` in `settle_streamed_citations` | The current case where a failing quote is shown unmarked until the terminal frame. With no patch, the snapshot equals the terminal text | ~10 lines. Pure, <10 ms | Improves integrity | `answer_pipeline.py:settle_streamed_citations`, `test_settle_streamed.py` |
| E | **Verify quotes in the stream**: `AnswerProseStream` checks each quote the moment its closing mark arrives, and streams the marker right behind it | The reader never sees an unmarked failing quote, not even for a moment | Moderate. The `uncited` reason depends on an `[N]` later in the sentence and on the source list settled at the end, so it can only cover `not_verbatim` / `too_long` | Improves integrity | `common/answer_prose_stream.py`, `turn/answer_stream.py`, `Live` protocol |
| F | **Prevent citation failures structurally**: the grounding block gives each passage a short id (for example `[S7]`), the model cites by id, and the pipeline writes the source list and the `[1..n]` numbering | Removes "line does not resolve" as a class of failure. It also lets pending pills resolve the moment they stream, because id→source is known before the call | Large. It changes the prompt contract, `grounding_block.py` (ADR-0061 byte fixtures), `verify_citations`, the stream reader and the frontend numbering, and needs an ADR and suite before/after | Improves integrity. A marker with an unknown id is held back in the stream and never shown | `common/grounding_block.py`, `piloti_static.md` `<citation_format>`, `citation_verification.py`, `answer_prose_stream.py` |
| G | **Prompt-only prevention**: tighten `<citation_format>` / `<stimme>` "Zitate" (quote only text copied from a passage, key copied exactly) | A small, unmeasured reduction | 0 lines of code, prompt churn, a suite run | None | `prompts/piloti_static.md:81, 260-268` (already says most of this) |
| H | **Repair before streaming, or stream a paragraph only once it verifies** | The swap | Holds prose back from the reader, which undoes ADR-0066's main gain. Citations cannot be verified until the source list arrives at the end anyway, and repairing mid-stream means aborting the call | None | Poor fit, not recommended |
| I | **Keep the whole rewrite, but label it** ("überarbeitet", with the original on toggle) | Honesty about the swap | A wire flag (`answer_revised`), a store holding both versions, persistence, i18n. The reader still loses their place | Unchanged from A, including the card re-binding | FE store + `turn/response` + persistence |

## 5. Recommendation

**Remove the whole-answer rewrite. Replace it with D + C, add the measurement, and treat F as
the structural follow-up.**

Why:

- The whole rewrite breaks the streaming contract, and on current evidence it buys very little.
  Every repair the audits examined was a verifier or grammar defect, fixed upstream, and the
  last sweep had 0 repairs. It also carries a card-number re-binding risk that no span-local
  approach has.
- Removed citations should get no repair at all. The snapshot has already applied the
  subtractive result where the reader can see it. Putting a citation back 15 s later is the
  swap again, and a citation is the one thing that should stay put. If they turn out to be
  frequent, the fix is F, upstream.
- Misquotes are the only failure where a repair buys the reader something: the passage exists
  and the model got the wording slightly wrong. The passage is almost always already in the
  registry, because the model was quoting something it had read. So the patch needs no
  retrieval. It needs the nearest chunk and one sentence.
- D should ship on its own first. It is a correctness fix for the snapshot today, whatever
  happens to the repair.

If the suite shows that misquotes of a retrieved passage are rare too (histogram of
`best_coverage` below), stop at B + D and skip C. That is the "no part" answer, and it is
fully honest.

## 6. Implementation sketch

### 6.1 D: settle quotes at the snapshot

In `settle_streamed_citations` (`answer_pipeline.py:650`), after `verify_citations`:

```python
quotes = verify_quoted_spans(verified.verified_report, registry)
report = annotate_unverified_quotes(verified.verified_report, quotes)
sanitized = sanitize_report(report)
```

This matches the order in `_ground` → `finalize_answer`, so with no patch the snapshot is
byte-identical to the terminal text.

Test (`tests/aiq_agent/agents/piloti/test_settle_streamed.py`): for a fabricated quote, the
settled content contains `UNVERIFIED_QUOTE_MARKER`. For a set of fixture answers, also assert
that `settle_streamed_citations(prose, sources).content == finalize_answer(...).content` with
`repair=None`. That second assertion ratchets snapshot/terminal identity.

### 6.2 C: span-local quote patch

1. `citation_verification.py`: give `UnverifiedQuote` a field `nearest: SourceEntry | None`, the
   entry whose chunk produced `best_coverage` (it is computed in the loop already; keep the
   argmax). No behaviour change.
2. New `agents/piloti/quote_patch.py` (~100 lines), replacing `repair.py`:
   - `patchable(q)`: `q.reason == "not_verbatim"` and `q.nearest` and
     `PATCH_FLOOR <= q.best_coverage < QUOTE_MATCH_THRESHOLD`. `PATCH_FLOOR` should come from the
     measured distribution, starting around 0.5. `too_long` and `uncited` keep the marker, because
     those are attribution problems, not wording problems.
   - `sentence_bounds(body, q)`: reuse `_quote_sentence_windows`
     (`citation_verification.py:3065`) so there is one sentence grammar.
   - One structured call on a small, low-reasoning model (a `quote_patch_llm` config key; the
     follow-up LLM's settings with `reasoning_effort: none` fit). The input is the sentence, the
     passage text of `q.nearest` and the instruction: "return this sentence with the quotation
     replaced by the passage's exact wording, or with the quotation marks removed if the
     sentence paraphrases; keep every [N] as is". No history, no system prompt, no tools. Put
     it under `asyncio.wait_for` with a few seconds' bound. The marked answer is the floor, so a
     timeout costs nothing (the argument of latency audit §3.8).
   - `accept(original_sentence, patched)`: the `[N]` set is identical, and
     `verify_quoted_spans(patched, registry)` returns nothing. The length stays within ±50 % of
     the original, which stops the patch from rewriting the claim. Otherwise, return `None`.
   - `apply(content, patches)`: splice right to left by offset, like
     `annotate_unverified_quotes`. Unpatched quotes fall through to the marker in `_ground`.
3. `answer_pipeline.py`: `_verify_with_repair` becomes
   `_verify_with_quote_patch(content, registry, patch_fn)`. It runs `_verify`, patches the
   quotes it can, and runs `_verify` once more over the patched text, so what ships is always
   what the verifier saw. `_adopt_if_better`, `Repair`, `repair_sources`, `_trailer_captures`'
   repair half and `FinalAnswer.repair_sources` all go, because the patch adds no source.
   `emit_answer_repair` becomes a `status:quote_patch` with `{quotesFailed, quotesPatched}`.
4. `agent.py:_repairer` binds the patch function. The `repair_pass` flag stays as the off switch.
5. Frontend (optional, no contract change): in `finalizeAgentResponse`, if a snapshot was shown,
   run a word diff between the snapshot and terminal text with `diff`. If they differ, mark the
   changed ranges with a quiet "nach Prüfung gegen die Quelle korrigiert" underline. This is
   honest (option I) without any wire change, and it covers the D marker too.

Tests to pin:

- In `TestPilotiRepairPass`, a misquote whose passage is in the registry, for example the
  `VERBATIM` chunk quoted with two words changed, is patched. Assert:
  - the final content equals the original with only that sentence replaced (compare the prefix
    and suffix outside the sentence byte for byte);
  - the model is awaited exactly 2 times plus 1 on the patch model;
  - no `knowledge_search` call is made after the answer.
- A patch that adds or drops an `[N]` is rejected, and the marker ships.
- A removed citation causes **no** extra call (`await_count == 2`), and the answer ships without
  the line.
- `test_a_fabricated_quote_is_re_searched_and_rewritten_once` changes meaning: a quote with no
  near passage now ships marked. That is intended. Rewriting a fabricated quote into a
  different true claim changes the substance of what the reader already read.
- Delete `test_repair_adoption.py`, since the adoption rule is gone. Replace it with a unit test
  of `accept`.
- Replace `TestRepairLookups` with `patchable` / `sentence_bounds` tests.

### 6.3 Measurement (do first, it is cheap)

- In `conversation_register.py:_answer_chunks` (with `live=True`), compare the last relayed
  `Snapshot.content` with the terminal content. Log `answer_stream: terminal differs from
  snapshot (N chars, M spans)`. Add a `terminal_changed` needle to `_LOG_SIGNALS` in `suite.py`.
- Split the suite's `repair` signal into `repair_adopted` / `repair_discarded`, and log the
  `best_coverage` of each unverified quote so that `PATCH_FLOOR` rests on data.
- Record pre-repair failure counts and the outcome in `citation_events` (`record_turn` args).
  That gives production frequency, not just 25-question sweeps.
- Suite protocol (not run here): `task be:eval:answer-suite` on `--all --runs 3` before and
  after, `--baseline` on the earlier `results.json`. Compare the checks (they must hold), final-
  call and wall seconds, "First text s", and the new `terminal_changed` and
  `repair_*`/`quote_patch` counts. Success means `terminal_changed` is only the patched sentence
  (or 0), with no loss in checks. If `repair_adopted` was already ~0 in the baseline, that is
  the evidence for dropping C and shipping B + D.

## 7. Open questions

1. Is there production data (logs, or `status:repair` steps persisted in the Herleitung) for how
   often repairs fire *and are adopted*? The repo only has sweep counts that conflate adopted
   and discarded.
2. Should a patch ever be allowed to append a source line? The sketch says no, so the source
   list the reader saw at the snapshot is final. Allowing it brings back the ledger gap and
   renumbering.
3. Should de-quoting (removing quotation marks from a paraphrase) count as a valid patch? It
   has the same trust level as any paraphrased sentence with a valid `[N]`, but it hides the
   signal that the model misremembered a norm's wording. The sketch allows it only through
   the model's own patch, re-verified, and never deterministically.
4. Ledger row 20 and roadmap L0 (`docs/roadmap/continuous-improvement-ledger.md:69`,
   `agentic-workspace-architecture.md:376`) frame the repair as a model-visible loop. Replacing
   it with a narrow patch shrinks that loop. The roadmap entry and ADR-0066's "Bad" consequence
   should be amended in the same change, and this decision probably deserves its own ADR.
5. `DeferredToolBinding` stays buffered (ADR-0066), so a whole rewrite would not swap visible
   text there. Keeping one path for both is simpler, and the card re-binding risk argues against
   keeping the rewrite anywhere.
6. The deep researcher has its own verify path (`deep_researcher/finalize.py`) and is out of
   scope here.
