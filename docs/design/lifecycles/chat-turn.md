# Lifecycle matrix: chat turn

**Design of record:** [`../streaming-chat-answer.md`](../streaming-chat-answer.md)
(wire, settle, paced reveal, [the turn on screen](../streaming-chat-answer.md#the-turn-on-screen)),
[`../chat-wire-v2.md`](../chat-wire-v2.md) (events),
[`../grid-design-language.md`](../grid-design-language.md) (motion tokens),
[`../run-block.md`](../run-block.md) (hand-off to a run).
**Owner area:** `frontends/ui/src/features/chat/` (ChatArea, ChatThinking,
ReasoningFlow, AgentResponse, InputArea, `lib/turn-fold.ts`,
`lib/turn-projection.ts`, `hooks/use-paced-text.ts`).
**Method:** [`../../contributing/lifecycle-matrix.md`](../../contributing/lifecycle-matrix.md).

A turn runs from the send to the last post-answer stage: the question row, the
Herleitung header and panel, the streamed answer card with its masthead and
cards, the settle, and the stages after it. Six components draw into that one
region while frames arrive, so most defects are one component's correct move
shoving another's content.

**Codes.**

- SS = `/dev/stream-socket` (a scripted v2 server behind a stubbed socket).
  `?scenario=` is one of `happy` (the default), `cards-only`,
  `masthead-first`, `shallow`, `opens-table`, `opens-card`, `one-line`,
  `long`, `two-turns`, `retract-with-card`, `rewrite`
  (`app/dev/_fixtures/v2-scenarios.ts`). Overlays on any scenario:
  `error=preack|steps|prose|finish`, `drop=<ms>`, `reload=<ms>`,
  `switch=<ms>`, `stop=<ms>`, `toggle=open@<ms>,close@<ms>`, `speed=`.
- TO = `/dev/turn-outcomes?scenario=` with `handed_off`, `answer_retracted`,
  `run_error`, `cancelled`, `error_preack`, `error_steps`, `error_finish`,
  `stop_before_steps`, `stop_during_steps`, `job_admission_rejected`,
  `hitl_choice`, `hitl_plan`, `proposal_accept`
  (`app/dev/turn-outcomes/scenarios.ts`).
- HL = `/dev/herleitung?variant=`. CT = `/dev/chat-turn` (static answer
  variants). SR = `/dev/stream-replay`. RB = `/dev/run-block`. SH =
  `/dev/shared-thread`.
- MP = `frontends/ui/scripts/measure-stream-socket.mjs`
  ([harness](../../contributing/testing-and-verification.md#the-socket-level-streaming-harness)).
  It passes `--scenario`, `--error`, `--drop`, `--reload`, `--switch`,
  `--stop` and `--toggle` to SS unchanged, and adds `--reader scroll`,
  `--animations`, `--reduced-motion`, `--color-scheme dark|light` and
  `--browser webkit`.
- Specs are named by file and test title. A check marked † does not exist yet;
  each one is listed under [Open gaps](#open-gaps).

## Rules that hold across every row

- **The working turn looks alive.** Before the answer the Herleitung header
  spins and shimmers, the frontier connectors march and a running chip pulses;
  during the prose the caret, with the header icon spinning; nothing after the
  settle.
- **Fade, then resize.** A block that must change size while visible fades
  first, then changes height in one frame while invisible. Only card-slot
  growth, blocks arriving below the reading point and reader-started
  accordions animate height.
- **What you saw is kept.** A stop, an error, a remount or a replay never takes
  away text the reader has already seen, and never re-types it.

## Phases

| # | Phase | Entered by (data) | Visible | Loop | Owner |
|---|---|---|---|---|---|
| P0 | idle | no running view | The composer shows Send. | none | InputArea |
| P1 | sent | `user_message` sent, `beginTurn` | The question row rises in. An anchor glide brings the question to the top. The Herleitung header mounts in the same row with "Denkt nach…". Send becomes Stop at once. The field stays live for typing ahead. | header shimmer | ChatArea, ChatThinking |
| P2 | working, no steps | `RUN_STARTED` | The same header. The timer fades in once it passes 2 s, counted from the question's timestamp. | shimmer | ChatThinking |
| P3 | steps | first `STEP_*` | The panel opens with an opacity fade and shows the whole graph, the executed-step chips under it. The live line cross-fades on each step. | spinner, shimmer, frontier edges | ChatThinking, ReasoningFlow |
| P4 | masthead | `CUSTOM masthead` before the first word | The answer has begun: the panel folds and the answer card mounts under the bar with its masthead as one entrance. | shimmer | ChatArea, AgentResponse |
| P5 | prose streaming | first `TEXT_MESSAGE_CONTENT` | Fold: the panel content fades on `motionQuickExit` with its height held, then the height drops in one frame. The answer row enters after the fold. The header label becomes the summary ("Herleitung · n Quellen") without shimmer and the timer keeps ticking. The paced reveal runs with a solid caret inside the text, which breathes after 600 ms without an advance. A leading summary is written in as the head of the prose. The footer is hidden. | caret | ChatArea, AgentResponse, use-paced-text |
| P6 | snapshot | `STATE_SNAPSHOT` | Text that continues what was shown is kept. A rewrite fades the body in on the same element while its frame holds the old height and glides down. A masthead gated out fades, then loses its height in one frame. | caret | AgentResponse |
| P7 | cards | `CUSTOM card` / `card_refused` | A slot already holding `[[card:N]]` grows into the card (`motionDeliberateEntrance`). A card that arrives before its marker draws at full size when the marker streams. A refused card's held place folds away. | caret | CardSlotArrival |
| P8 | terminal | `RUN_FINISHED` or `RUN_ERROR` | The composer shows Send again. The result is authoritative for text, sources, masthead and cards, except after a Stop pressed on this page. | caret | turn-fold, turn-projection |
| P9 | finishing | terminal arrived, text still held back | The held-back text is revealed in 300 to 500 ms. The header stays live. | caret | use-paced-text |
| P10 | settled | paced reveal settled | In one frame: the caret is gone, the footer fades in and becomes operable, pending citation pills turn real, the role-tab dot becomes a check and the header's dot a check on `iconSwapTransition`, the timer freezes on the answer duration (never below the last live figure), and a polite status says "Antwort fertig: {gist}", or the ending word for a turn without an answer of its own. The header label stays the summary; there is no "Fertig". | none | AgentResponse, ChatThinking, ChatArea |
| P11 | post-stages | `CUSTOM stage` after the terminal | The memory chip fades into its reserved footer row. Follow-ups are drawn only for the last answer, finished, with an empty draft. | none | turn-projection, FollowUpsRail, MemoryNotedChip |
| P12 | rest | every stage landed, or the stage TTL passed | Nothing moves. The turn is not re-attached. | none | use-websocket-chat |

## Edges

| # | Edge | Expected | Failure modes | Fixture | Check |
|---|---|---|---|---|---|
| L01 | P0→P1 send | Row rises. Glide on `springGlide`, jumping first when the travel exceeds 1.5 viewports, skipped for a retried question already within a viewport. Interruptible by wheel, touch, key or pointer. Stop shows at once; for 400 ms after the swap the button ignores presses, and a held Enter presses it once. The send closes the keyboard only when a soft keyboard is up (an iPad on a hardware keyboard keeps focus). | Smooth `scrollIntoView` fights the reader; glide restarts on layout. | SS | MP `scrollCalls` ≤ 1; ChatArea.spec "glides a newly sent user message to the top of the viewport, scrolling only the thread", "a sent question already where it would land is not scrolled"; InputArea.spec "a double click on Stop does not send the draft typed ahead", "a double click on Send does not cancel the turn it started", "a coarse pointer on a hardware keyboard (iPad) keeps the field focused" |
| L02 | P1→P2 `RUN_STARTED` | Nothing changes visibly. | — | SS | — |
| L03 | P2→P3 first step | The panel opens with an opacity fade. | `height:auto` does not interpolate, so the open pops; hidden only while the anchor spacer absorbs it. | SS | MP `clsBeforeSettle`; per-phase split † |
| L04 | P3 round n+1 | The new layer lands below with a fade. The pane height glides. Edges into the frontier march. | Nodes pop without a fade; a re-layout (fan to spine) re-measures every layer. | SS, HL `spine`, `spine-folded` | MP `--animations`: no element animates twice |
| L05 | P3→P5 fold at first word | As in P5. | The answer enters before the fold has faded; a Stop inside the fold mounts it under the fading panel; a row already on screen is pulled out and back in. | SS | ChatArea.spec "folds when the answer starts, and its header stays live until the answer settles", "the answer is withheld while the Herleitung above it folds, then placed under the bar", "a Stop inside the fold still waits for the fold, then places the answer", "an answer row already on screen is not withheld at its first word"; fold CLS 0 † |
| L06 | P4 masthead before the first word | The masthead counts as the answer beginning: the panel folds and the masthead is part of the card's entrance. | The card mounts under the open panel, which then drops in one frame at the first word and the masthead jumps. | SS `masthead-first` | ChatArea.spec "a masthead (or a card) before the first word folds it too" |
| L07 | Answer with no steps | The header is the working cue from the send. At the first word the label switches and nothing folds. Settled: the bar stays, so the answer is not pulled up; it offers no empty panel. | The header claims a "Herleitung" that opens empty; the bar leaves at the settle. | SS `shallow` | ChatArea.spec "a turn that took no step keeps its bar after the settle, so the answer is not pulled up"; settled bar not expandable † |
| L08 | Cards-only answer | The first card counts as the answer: the panel folds when it arrives and the card enters as the answer. | The panel stays open until the settle, then folds and the card jumps up by the panel height. | SS `cards-only` | ChatArea.spec "a masthead (or a card) before the first word folds it too"; MP `clsAfterSettle` 0 |
| L09 | One-line answer | Fold, entrance after 180 ms, finish, settle, strictly in sequence. No lede. | Fold, entrance, finish and settle all land within 700 ms and stack. | SS `one-line` | MP: no two height animations overlap † |
| L10 | Very long answer | The question stays anchored and the spacer is consumed. Follow does not engage. Jump-to-latest appears once. The finish is capped at 500 ms. | Per-flush cost grows with the markdown tree; the jump button flickers at the spacer edge. | SS `long` | MP long-frame p95; ChatArea.spec "shows while content lies unseen below, and goes once it is in view"; jump button toggles ≤ 1 † |
| L11 | Answer opens with a table, diagram or card | No lede. The caret sits in the last cell. A table appears with its first body row, a row with its first cell; rows grow downwards only. A diagram skeleton grows into the drawing, or glides to the source when it cannot be drawn. A card at index 0 grows in its slot. | Earlier table rows reflow as cells append; a header alone restacks on a phone; a failed fence swaps in one paint. | SS `opens-table`, `opens-card`; CT `lede-card`, `two-cards` | stream-pace.spec "shows a table with its first row, never its header alone", "shows a row with its first cell, never as a blank row"; MP: rows above the frontier never move † |
| L12 | Retraction, then a second answer | The answer card keeps its frame: the words fade out, the body holds its height with one quiet line („Antwort wird erstellt …"), and the next round's first word or the settle releases it on a glide. The Herleitung stays folded. The lede is decided again, and the next round's cards arrive with their entrance. | The card vanishes in one frame and re-enters; the panel reopens over the held frame (248 px); the lede of the retracted preamble carries over. | TO `answer_retracted`, SS `retract-with-card` | AgentResponse.settle.spec "keeps the card, fades the words into one quiet line, and lets the next round decide its lede"; CardSlotArrival.spec "after its answer is retracted, the next card at the same place arrives again"; ChatArea.spec "a retraction does not reopen the Herleitung over the answer it folded for" |
| L13 | Choice prompt mid-turn | The prompt row enters below. The panel shows "Wartet auf Ihre Wahl" without controls; the options have one home, the prompt row. A reader's close stands. The timer keeps counting through the wait. After the pick the fold moves nothing visible below. | Options drawn twice; the wait forces the panel open; the timer jumps by the wait on resume; the fold drops the panel and the prompt card jumps. | TO `hitl_choice`, HL `branches` | ChatThinking.spec "a HITL wait does not force the panel open: the choice is answered in its prompt card"; TO CLS after pick 0 † |
| L14 | Plan approval | The plan card resolves in place to a one-line record ("Plan freigegeben · 5 Abschnitte"), then the run block takes the answer slot. | A tall dead card stays. | TO `hitl_plan` | TO: plan card ≤ 56 px tall 600 ms after approval † |
| L15 | `handed_off` to a run | The answer is swapped, in the same frame, for a provisional run message in the same row; the row is keyed by its question, so the stored message is adopted into the same node. The header reads "Auftrag angelegt" with a neutral glyph, and the settle is announced as a commissioned run. | The run row gets a new React key: two rows for 180 ms and a slide; a green check for work that has only started; a failed fetch reads as interrupted. | TO `handed_off`, RB `transition` | ChatArea.spec "a turn handed to a run keeps its answer row: the run message takes the same node", "a turn handed to a run says the run was commissioned, not the provisional message as the answer"; turn-projection.spec "swaps the answer for a provisional run message in the same row" |
| L16 | refused / admission rejected | No answer row. The banner speaks. The header reads "Nicht bearbeitet" with a neutral glyph. | "Fertig" with a check on a refused turn. | TO `job_admission_rejected` | ChatArea.spec "a turn the queue refused is not handled, not failed and not done"; turn-projection.spec "job_admission_rejected: the answer leaves, the banner speaks" |
| L17 | No ack, or `RUN_ERROR` right after it | The header stays live with one calm loop while the client waits; it never reads "Unterbrochen". Without an ack, the socket reopens at 15 s and resends; at 30 s the header turns to "Fehlgeschlagen" and an `agent.no_response` card („Keine Rückmeldung") with „Erneut versuchen" enters below. A `RUN_ERROR` after the ack goes there at once. | "Unterbrochen" and the recovery spinner flash before the error card: the wrong cause; the header stays live forever. | TO `error_preack`; SS `error=preack` | ChatArea.spec "a turn that failed reads as failed, never as interrupted or done" |
| L18 | `RUN_ERROR` during steps | The panel keeps its steps and the header reads "Fehlgeschlagen". The error card enters. No empty answer bubble. | As L17. | TO `error_steps`; SS `error=steps` | As L17 |
| L19 | `RUN_ERROR` during prose | The words shown stay, frozen and dimmed, with no check, copy or feedback, and the error card under them. The announcement says „Fehlgeschlagen", never that the answer is ready. „Erneut versuchen" removes both at once. | The streaming fragment is removed and the words being read vanish. | SS `error=prose`, TO `run_error` | AgentResponse.spec "a failed answer keeps the words, dimmed, without the check, the copy action or feedback"; turn-projection.spec "RUN_ERROR: the projection keeps what streamed, marked failed in the same frame"; ChatArea.spec "a failed answer says „Failed", never that the answer is ready" |
| L20 | `RUN_ERROR` during the finish | As L19. | Row removed mid-finish; the header stays live. | SS `error=finish`, TO `error_finish` | As L19 |
| L21 | Stop before the first step | The header shows "Gestoppt" with a neutral glyph. No answer row. The composer is free. | — | TO `stop_before_steps`; SS `stop=<ms>` | ChatThinking.spec "a stopped turn shows „Stopped…"; ChatArea.spec "a stopped turn says „Stopped…" |
| L22 | Stop during steps | "Gestoppt". The open row closes, nothing else moves; the panel is not folded under the reader. | The stop folds the panel the reader was watching. | TO `stop_during_steps`; SS `stop=<ms>` | Panel not folded by a stop † |
| L23 | Stop during prose | The text freezes at the shown length without a body fade, the caret fades, "Gestoppt" fades in under the last word. The masthead stays, with its summary as far as it was written. Resolved `[N]` stay citations, from the wire sources, though the cut falls before the Quellen list. An error the run raises after the Stop leaves the answer stopped, not failed. Nothing arrives after the stop: no cards, takeaways or sources row. A reload shows the same cut. | The server's cancelled terminal brings the longer text, cards and a sources row after the stop; its missing masthead takes the masthead away; the body blinks out and back; markers settle to wider plain „[N]" and the line re-wraps (26 px on a phone). | TO `cancelled`; SS `stop=<ms>` | AgentResponse.settle.spec "after Stop, keeps what was on screen, says so, and does not claim to be complete"; turn-fold.spec "takes no more text, snapshots, mastheads, cards or retractions"; use-paced-text.spec "settles at what is shown and does not type out the held-back rest"; AgentResponse.spec "draws no card and no „without source…"; AgentResponse.settle.spec "does not fade the body in again when Stop freezes it", "keeps the masthead and the summary as far as it was written when stopped under it"; CitationMarker.spec "an answer cut before its Quellen list keeps its markers as citations"; turn-fold.spec "stays stopped when the run fails after the Stop, rather than turning failed" |
| L24 | Stop during the finish | Not offered: the terminal has freed the composer, which shows Send for the 300 to 500 ms finish (accepted residual). A send starts turn 2 (L30). | — | SS | — |
| L25 | Socket drop mid-steps | A quiet line in the status dock above the composer ("Verbindung unterbrochen …", then "Wieder verbunden" for 2.4 s), never a card in the thread. The replay lands as one layer. | Replayed steps pop one by one; a connection card collapses out of the thread on reconnect. | SS `drop=<ms>` | ChatArea.spec "a dropped connection is a quiet line above the composer, not a card in the thread"; no duplicate rows, replay CLS ≤ steps baseline † |
| L26 | Socket drop mid-prose | The paced reveal absorbs the burst. The caret breathes during the outage. | — | SS `drop=<ms>` | As L25 |
| L27 | Reload mid-turn | The question and the live header show from the first paint. The replay's arrived text shows at once and only what follows is paced. | "Unterbrochen" flashes before `attach` returns; the whole answer re-types from zero. | SS `reload=<ms>` | use-paced-text.spec "shows 2000 characters that had already arrived at once, and paces only the next delta"; no "Unterbrochen" flash † |
| L28 | Thread switch away and back | Back shows exactly what was there, at the saved position; a turn still running is anchored again. Nothing re-enters or re-types. | The answer remounts and re-types from zero; the thread opens at its bottom; the old thread lingers 180 ms beside the new one. | SS `switch=<ms>` | use-paced-text.spec "shows what a remounted answer had on screen at once, however short"; toggle kept † |
| L29 | Observer joins mid-turn | The observer sees the asker's surface: steps so far, the text whole rather than from mid-sentence, one loop, a timer from the question. The swap to the persisted row is placed, not entered. An observer at the end of the thread has every colleague's turn anchored, question at the top; one reading further up is not moved. | Text starts mid-sentence; two shimmers; the timer counts from mount; the swap replays an entrance. | SH `live` | SpectatedTurn.spec "an observer who joined mid-answer waits for the whole text rather than starting mid-sentence", "keeps one ambient loop: the headline stops shimmering once the Herleitung carries it"; ChatArea.spec "anchors the next turn too, for a reader who watched the last one to its end", "leaves a reader who scrolled up to read where they are" |
| L30 | Second question soon after the settle, or during the finish | Turn 1 finishes and settles before its header shows its check. Turn 1's follow-ups are not drawn. The memory chip lands in its reserved row. The anchor glides to Q2. | Two reveals run at once; turn 1 reads done mid-finish. | SS `two-turns` | Header order and follow-up absence asserted † |
| L31 | Reader scrolled up while streaming | No yank: following starts only from the reader's own scroll to the end or the jump button. The jump button shows. A fold above the viewport is compensated. | WebKit has no `overflow-anchor`, so a fold above the viewport moves the page; a clamp read as "at the bottom" chases the reader. | SS | MP `--reader scroll`, `--browser webkit`; ChatArea.spec "a scroll the page caused never shows it, nor starts following"; WebKit fold CLS 0 † |
| L32 | Reader toggles the Herleitung by hand | Opened: stays open through the answer. Closed: stays closed and the answer enters without waiting for a fold. | A closed panel still delays the answer 180 ms. | SS `toggle=open@<ms>` | ChatThinking.spec "the live panel shows the whole graph", "a panel the reader opened is not folded or reopened by the turn"; MP `clsAfterSettle` 0 with the panel open † |
| L33 | Reduced motion | Every transition is instant. No shimmer, no caret breathe. The glide becomes a direct `scrollTop`. The reveal still paces. | A motion that ignores the media query; an opacity on a spring. | CT, HL with emulated media; SS | MP `--reduced-motion --animations` (flags only a run > 0 ms that is not a pure fade ≤ `--motion-quick`) |
| L34 | Phone | The fan becomes one column, the header summary hides below `sm`, follow waits for touch end. | Steps and post-settle CLS higher than on desktop. | SS | MP at 390x844 (default) |
| L35 | Phone keyboard open | Send blurs the textarea and the keyboard closes during the glide. The shell sizes to the visual viewport. The anchor spacer refits on the resize. | iOS ignores `interactiveWidget`; the composer hides behind the keyboard; the glide target moves mid-glide. | none (manual, real iPhone) | use-visual-viewport.spec; ChatArea.spec "the anchor spacer shrinks as the list grows and refits when the viewport resizes"; refit during the glide † |
| L36 | Dark mode | No light flash on load. The veil and masks use the card colour. The check glyph keeps its contrast. | Light flash on hydration; the veil paints over muted chips. | CT, HL; SS | theme-boot.spec "an explicit dark choice wins over a light OS"; MP `--color-scheme dark`; shots at P3, P5, P10 † |
| L37 | Deep link to a message (`#message-<id>`, inbox link) | The thread opens on the named message, which owns the position: no bottom jump, no follow. A target missing from a thread whose messages have all arrived stops holding it; leaving that thread for one the link does not name drops the target. A shared thread's late history still lands it. | The bottom jump overrides the link a frame after it lands; an unresolvable target leaves every later thread unplaced and unfollowed. | SH; any thread with `#message-<id>` | use-message-anchor.spec "stops holding a thread that loaded without it", "still lands when the message arrives after all (a shared thread's history)", "is dropped when the reader leaves the thread it missed in"; ChatArea.spec "a deep-linked thread switched away from and back to is placed like any other" |
| L38 | Escape during the reader's own turn | Stops the answer from the composer, or from the page body while the composer was the last thing used. An open picker takes the first Escape; an IME's Escape (keyCode 229) is the IME's. The draft is untouched. | An Escape meant for a dialog, a menu or a text selection in the thread cancels the answer. | SS | InputArea.spec "Escape stops a streaming turn from <body> once the composer let go of the focus", "Escape from <body> after a click on transcript text leaves the turn running", "an IME's Escape (Safari: after compositionend, keyCode 229) leaves the turn running" |

## Events

| # | Event | Appears | Where | Choreography | Cost |
|---|---|---|---|---|---|
| E01 | send (no frame) | Header "Denkt nach…" | Under the question, same row | Rises with the row. The timer appears after 2 s with a fade. | one row mount |
| E02 | `STEP_FINISHED status`, live channel | Live line phrase | Header label | Cross-fade (`motionQuick` in, `motionQuickExit` out). The screen reader hears the phase, at most once per 3 s. | header re-render |
| E03 | `status`, technical channel | Nothing live; a row in the opt-in technical steps | Panel | — | steps array identity |
| E04 | `retrieval` round 0 | Live line "Sucht … nach '…'" and the framing node | Graph top | The pane height glides. | ReactFlow measure |
| E05 | `retrieval` round ≥ 1 | A checkpoint layer "Schritt N" with its reason; the fan becomes the spine at round 2 | Graph | Lands below with a fade. Height glides and holds its maximum while live. Edges into the frontier march. | one layout pass per round |
| E06 | `STEP_STARTED tool` | Executed-step chip | Chip row under the graph | Its dot pulses while it runs. | chip list derive |
| E07 | `STEP_FINISHED tool` | Chip settles; an error shows detail | Same | Glyph swap only. | — |
| E08 | `sources` | Source cards under their round; one grouped column on a phone | Graph | Height glide. The header's source count updates. | layout pass |
| E09 | `skill` activated | Live line "Wendet … an" and a skill chip | Header and chip row | Static dot. At the settle it moves to the skills disclosure in the footer without shrinking an open panel. | — |
| E10 | `skill` offered, loaded, hidden | Nothing | — | — | — |
| E11 | `clarification` | Nothing (detail only) | — | Precedes E12. | — |
| E12 | `interaction_request choice` | The prompt row; the graph says "Wartet auf Ihre Wahl" | Prompt row (one home) | Row enters below. No controls in the graph. | row mount |
| E13 | `interaction_request text` with `plan_json` | Plan checklist card | Its own prompt row | Enters with the row. On approve: controls fade, a one-line record takes the same slot. | row mount |
| E14 | `interaction_resolved` | The prompt resolves | Prompt row | Buttons cross-fade to a receipt in a fixed slot. | — |
| E15 | `heartbeat` | Nothing | — | The timer is clock-driven. | fold only |
| E16 | `scope: deep` step | Nothing in the Herleitung | Run block | — | — |
| E17 | Reader folds or unfolds a round | Fan becomes its scent (count and top file) | Graph layer | Chevron rotates on `duration-quick`; pane height glides. | layout pass |
| E18 | First answer word, masthead or card | The panel folds | Panel | Fade 180 ms with height held, then the height drops in one frame. The label becomes the summary. | — |
| E19 | Settle | The spinner becomes a check, the timer freezes; the label stays the summary | Header | Same frame as the answer's settle. The frozen figure is never below the last live figure. No "Fertig". | — |

## Open gaps

Ranked by visibility times likelihood. Each entry leaves when its check lands.
Every fixture the first version of this file asked for now exists; what remains
are assertions.

| Rank | Rows | Fixture | Assertion to add |
|---|---|---|---|
| G1 | L22 | TO `stop_during_steps`, SS `stop=<ms>` | A stop during steps neither folds nor reopens the panel |
| G2 | L03, L05 | SS | MP per-phase CLS split (send, steps, fold, prose, settle, after); fold CLS 0 |
| G3 | L27 | SS `reload=<ms>` | No "Unterbrochen" in the DOM between the reload and the first replayed frame |
| G4 | L25, L26 | SS `drop=<ms>` | No duplicate rows after the replay; replay CLS within the steps baseline |
| G5 | L28 | SS `switch=<ms>` | The reader's panel toggle survives a switch and back |
| G6 | L32 | SS `toggle=open@<ms>` | `clsAfterSettle` 0 with the panel open |
| G7 | L13, L14 | TO `hitl_choice`, `hitl_plan` | CLS after the pick 0; plan card ≤ 56 px 600 ms after approval |
| G8 | L09, L10 | SS `one-line`, `long` | No overlapping height animations; jump button toggles ≤ 1 |
| G9 | L11 | SS `opens-table`, `opens-card` | MP: rows above the frontier never move |
| G10 | L30 | SS `two-turns` | Turn 1 settles before its check; no follow-ups on turn 1 |
| G11 | L31 | MP `--browser webkit --reader scroll` | Fold CLS 0 with the reader scrolled up |
| G12 | L36 | MP `--color-scheme dark` | Screenshots at P3, P5, P10 attached to the QA pass |
| G13 | L07 | SS `shallow` | A settled turn with no steps offers no expandable panel |
| G14 | L35, L01 | none: manual real-device checklist | iPhone: the keyboard closes on send and the spacer refits during the glide. iPad on a hardware keyboard: the field keeps focus after send |
