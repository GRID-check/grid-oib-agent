# ADR-0036: When the agent answers in a shared thread (engagement modes, not judgement)

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Platform engineering, product
- **Related:** ADR-0034 (mention hand-off as persisted state), ADR-0033 (server-authoritative
  shared conversations), ../design/collaboration-sharing-and-inbox-spec.md (MN-1, MN-7)

## Context

In a one-person thread "who is this message for?" has one answer, so the product never
had to ask. A shared thread breaks that: Matthias, Anna and Piloti are in one
conversation, and a message with no `@` in it could be a question for the assistant or a
remark to a colleague.

The rule we shipped is deterministic (spec MN-1):

| Message | Piloti answers? |
| --- | --- |
| `@Piloti …` | always |
| `@Anna …` | never — hands off, the thread waits |
| `@Anna @Piloti …` | yes |
| plain text | yes, unless the thread is waiting on a named person |

The first three rows are exactly right and are not in question. **Row four is.** Its
failure mode is real and was reported from use: Anna answers, Matthias replies *to Anna*,
and Piloti answers a message that was never for it.

The proposal on the table was to hand row four to the model: always send the message to
the agent tier and let the intent classifier decide whether it was addressed. The
classifier is a good candidate on paper — it is the graph's entry point, it already runs
exactly once per turn, it already sees trimmed conversation history, and it already has a
terminal route that ends a turn without an answering agent (`out_of_scope`). Adding a
field to its JSON is nearly free.

Two bodies of evidence say do not do it that way.

### 1. Nobody ships this, and the ones who don't have thought about it

- **Claude in Slack (Claude Tag).** Engagement is deterministic: `@`-mention, or a DM.
  There is no documented "was this addressed to me?" inference anywhere in the product.
  What it *does* have is **routines** — standing work a human writes in the channel in
  plain language ("watch #eng-announce and post here once a day if anything is relevant
  to user education"). A routine is created by a person, scoped to a channel, listed on
  demand (`@Claude !routines`), edited by describing the change, disabled by name, and
  documented to post *only when something changed*. Even the automatic-triage recipe
  keeps the mention as the trigger — "when someone tags you on a request, …" — and only
  changes what happens afterwards.
- **Microsoft Teams.** "By default, agents in group chats and channels only receive
  messages when they're directly @mentioned." Receiving everything requires
  resource-specific consent — an explicit, admin-granted capability on the installed app.
  A permission, not a judgement.
- **Linear.** Agents are activated by assignment, mention, or delegation, and "issues can
  only be assigned to humans, and only delegated to agents". Their stated principles are
  worth copying wholesale: an agent must give instant feedback, be transparent about its
  internal state, always disclose that it is an agent, and — because "an agent cannot be
  held accountable" — never hold the responsibility itself.

The convergence is not timidity. It is that a deterministic trigger is the only version
where the interface can promise something before the user presses send.

### 2. The model is bad at precisely this question

Addressee recognition in multi-party dialogue is a studied task, and the results are
unambiguous:

- *An LLM Benchmark for Addressee Recognition in Multi-modal Multi-party Dialogue*
  (arXiv:2501.16643) benchmarks GPT-4o on triadic conversations and reports accuracy
  **"only marginally above chance"**, concluding LLMs "cannot reliably perform addressee
  recognition in this context". It also measures that an addressee is explicitly marked in
  only about **20% of turns** — so 80% of the time there is no textual signal to find.
- *Do LLMs suffer from Multi-Party Hangover?* (arXiv:2409.18602) separates the two tasks
  and finds that **"response selection relies more on the textual content of
  conversations, while addressee recognition requires capturing their structural
  dimension."**

That second sentence is the whole decision. "Who was this for?" is a question about
conversation *structure* — who is present, who spoke last, who was replying to whom —
and the model is the wrong instrument for it. "Is there a question here I can answer from
the sources?" is a question about *content*, which is the task LLMs are measured as good
at.

We hold the structure already, exactly and for free: the participant roster, the
authorship of every message, and the open `mention_requests` rows. Handing the structural
question to a model would be replacing data we have with a guess about it.

## Decision

**Engagement is decided by deterministic, inspectable rules. The model is never asked who
a message was for.**

1. **The tag rules are absolute and unchanged.** `@Piloti` always answers. A message that
   tags only humans never starts a turn. Tagging both answers. No mode, flag, routine or
   model output may override these three — they are what makes a tag worth typing.

2. **Row four is governed by a per-thread `engagement` mode**, stored on the conversation,
   with two values:

   - **`ask`** — a plain message goes to Piloti. Today's behaviour, and the right one for
     the overwhelming majority of threads, which have one human in them.
   - **`mention`** — a plain message goes to the chat; Piloti answers only when tagged.
     The Slack/Teams/Linear default, and what a genuine multi-person discussion wants.

3. **The mode flips on a structural signal, not a judgement.** A thread starts in `ask`.
   The first time a *second human* contributes, it moves to `mention` and says so once,
   inline, in the thread. Participant count and message authorship are facts we hold;
   this costs nothing and is explainable in one sentence.

4. **Any participant can set the mode explicitly, and see it.** The composer's addressee
   line states the current mode in every state, and is the control that changes it. A mode
   the user cannot see is a mode they will be surprised by.

5. **The composer keeps a hard promise in both modes.** Before sending, the user is told
   who receives the message, and that statement is always true. This is the property the
   listener design cannot have, and it is not negotiable.

6. **A non-addressed human message still reaches the agent as context, not as a turn.**
   Unchanged from the current `context_only` path: `aupdate_state` into the checkpoint, no
   LLM call, no frames, no tokens. The agent stays current without answering.

7. **The classifier's extra job is content, never structure.** When the agent *is*
   addressed in a multi-person thread it receives the participant roster and per-message
   author attribution, so its answer can be addressed to the right person. It is never
   asked whether it was addressed.

8. **Standing instructions are the future path for proactivity, and they are explicit.**
   If Piloti should ever speak unbidden, it will be because a human wrote a named,
   listable, disableable rule for this thread ("watch this thread and flag anything that
   contradicts the OIB guideline"), evaluated on an event or a schedule and posting only on
   change — the Claude Tag routine shape. Deferred, but this ADR fixes its form: a rule a
   person wrote, not an inference about intent.

## Consequences

### Positive

- The reported bug is fixed by construction rather than mitigated: in a thread where two
  humans are talking, a plain message goes to the chat, so Piloti cannot answer a message
  meant for Anna.
- Zero added LLM calls. Row four costs what it costs today.
- Every routing outcome is explainable to a user in one sentence, and reproducible.
- The composer's promise survives, which is what users actually complained about not
  having.
- It behaves like a teammate for the reason a teammate behaves that way: a colleague in a
  group chat answers when addressed, not whenever a sentence ends in a question mark.

### Negative

- **A user in `mention` mode must tag Piloti to get an answer.** That is one extra
  gesture, in exactly the situation where the gesture carries meaning. Mitigated by the
  mode being visible and switchable, and by the transition being announced.
- **A new piece of per-thread state**, which is a thing that can be wrong. Mitigated by
  making it derivable: with no stored value, the mode is computed from the participant
  count, so an absent value is never a broken thread.
- **The mode transition can surprise someone mid-thread** — a plain message that would
  have gone to Piloti now goes to the chat. This is why the flip is announced inline and
  the composer's line changes at the same moment.

### Risks

- **The flip fires on a colleague merely saying "danke".** A second human contributing at
  all is a coarse signal. Accepted deliberately: the alternative is judging what their
  message meant, which is the thing this ADR declines to do. Any participant can set the
  mode back in one click.
- **Two threads, two behaviours** — the same criticism ADR-0033 accepts for its own seam.
  Mitigated by the composer stating the current behaviour rather than expecting the user
  to infer it.

## Alternatives Considered

- **The listener: always send, let the classifier judge addressing.** Rejected on the
  measured capability (near-chance addressee recognition; structural task, textual
  instrument), on cost (every human-to-human message becomes an LLM call where it is
  currently free), on the loss of the composer's pre-send promise, and on two new failure
  modes: a `BudgetExceededError` posting a budget notice into a thread the agent was never
  addressed in, and prompt injection gaining a structurally new surface, where colleague
  B's prose can steer whether the agent answers colleague C.
- **Ask the model a content question instead ("is there a question here I can answer?").**
  A better question, and one the research says LLMs handle. Still rejected as the *primary*
  gate, because "there is an answerable question in this message" is not the same as "this
  message was for me" — Matthias asking Anna a question satisfies the first and fails the
  second. Kept in reserve as a possible confidence floor *inside* an explicitly opted-in
  proactive routine (§8), where the user has already said they want to be interrupted.
- **Keep row four as "always Piloti unless waiting".** Rejected: this is the shipped
  behaviour and it is the reported bug. A wait clears the moment the colleague replies, so
  the very next message — the one most likely to be a human reply to a human — goes to the
  agent.
- **Require `@Piloti` always, in every thread, and drop row four.** Clean, and wrong for
  the product: the single-user thread is the overwhelming majority of use and Piloti is
  the main chatting point. Charging every user a tag on every message to fix a
  multi-person edge case inverts the priority.

## References

- ../design/collaboration-sharing-and-inbox-spec.md — MN-1, MN-7
- ADR-0034 (and its 2026-07-30 addendum on the two-state routing model)
- Claude in Slack: engagement triggers and routines —
  https://support.claude.com/en/articles/12461605-use-claude-in-slack,
  https://claude.com/docs/claude-tag/users/proactivity
- Microsoft Teams, agents in channel and group conversations —
  https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations
- Linear, approach to the Agent Interaction SDK —
  https://linear.app/now/our-approach-to-building-the-agent-interaction-sdk
- *An LLM Benchmark for Addressee Recognition in Multi-modal Multi-party Dialogue* —
  https://arxiv.org/abs/2501.16643
- *Do LLMs suffer from Multi-Party Hangover?* — https://arxiv.org/abs/2409.18602
