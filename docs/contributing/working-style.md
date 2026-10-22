# Working style

The rules in [`AGENTS.md`](../../AGENTS.md) are the short form. This is the
long form: the cases that produced each one, kept out of always-loaded context
because a case teaches once and then costs on every turn.

## Value driven

Before you touch anything, answer one question in writing. What does the user
actually expect to be true when this is done? Not what the ticket says, not what
the spec file contains. What changes for the person who asked.

The request is evidence about the expectation, not the expectation itself. A
spec, a handover package, a simulation HTML: those are someone's guess at how to
reach the outcome. Implementing the guess faithfully while the outcome stays out
of reach is the most expensive way to fail here, because it looks like delivery.

So the order is expectation, then "does the requested change produce it", then
code. When the middle step comes back no, say so before writing the code, and
say what would.

The test that produced this rule. A wizard handover package (`wizard_spec.json`
v1.2 plus concept plus clickable simulation) specified `B2_upl`, "Bebauungsplan
ablegen", as a question of `type: 'upload'`. Implementing that literally means
rendering an upload control in the wizard. Doing so would have satisfied the
spec completely and delivered nothing, because the expectation behind it is that
the assistant knows which file is the Bebauungsplan for this project, and this
repo has no per-project notion of a document's ROLE at all. Tags
(`document_classification.ALLOWED_TAGS`) are LLM-guessed content labels.
`doc_class` is the base-corpus norm hierarchy. Folders are user-arranged
furniture. None of them can answer "which file is THE Bebauungsplan here", which
is what every downstream feature in that package is built on: extraction, the B3
Kernset review, Modul I's completeness checklist, the agent's project context.
The upload control was the visible tip. The missing declaration was the work.

Corollary, and it cuts both ways. Value driven is not licence to widen a task
because you spotted something adjacent, and it is not licence to narrow it to
the part that is comfortable. It obliges you to name the gap between what was
asked and what was expected, then let the user decide which one they are paying
for.

## Aim at the north star, land on the clouds

A capability gets designed twice, on purpose, and the two passes must not be
mixed.

**First pass: the north star, with no technical limits.** Describe what the
person would experience if anything were buildable: what the colleague in the
office would do, see and show. Write it as a scene, not a feature list. In this
pass, technology is what makes the scene possible, never a reason against it.
"We have no page-range read" belongs in the second pass. In the first it only
means "something has to read a document through".

**Second pass: the landing.** Take the scene apart into what we can build now,
measure, and ship, and say which part of the star each slice moves toward.
This is where realism belongs: cost, latency, staleness, what the evidence
supports, and what has to be measured before anyone calls it better. A slice
that cannot name the part of the star it serves is not on the path.

Keep both written down. The star goes at the top of the design (the ADR's
context, or the capability register in
[`agent-capabilities.md`](../architecture/agent-capabilities.md)), and the
landing is the plan underneath it. When later work lands short, the star is
still there to say how far short.

Why both, and why in this order. Starting from the realistic version anchors the
design on today's tools: you extend what exists by a step and call that the
roadmap. Starting from the star alone produces a vision nobody can ship. The
star sets the direction; the landing keeps it honest, including the honest
sentence "this is not measured yet".

The case: Piloti could already render any region of a page at 1200 dpi, but
only looked when a person had drawn a box, and the chat never showed a look at
all. The realistic framing ("the tool exists, add a prompt line") would have
stopped there. The north star ("talk to a senior architect who opens the
folder, reads the report through, looks at the stairwell on plan 03 and puts
a finger on it") turned the same tool into four slices: a standing look rule,
a card for the look that supports the answer, a Herleitung step, and parity
between chat and canvas. See ADR-0127 and ADR-0128.

One restraint survives the star: show what supports the answer, not
everything that happened. An expert shows you the crop that proves the point.
Every glance goes in the notebook (the Herleitung), not the answer.

## Prefer visuals

The maintainer values visual explanations. When explaining architecture, data
flows, deployment topology, sequence/interaction, or any non-trivial design,
render a diagram with the **Excalidraw** tool (`create_view`) rather than
describing it in prose alone. Keep diagrams structured: a clear layered/left-to
-right flow, aligned grid, orthogonal arrows that don't cross boxes, and a short
legend. Offer a diagram proactively for architecture/design discussions.

## Buy, don't build

Complexity that belongs to somebody else's domain is a dependency, not a module
you write. Geometry, cryptography, time zones, PDF rendering, identity, object
storage, observability: each is a field with its own decade of edge cases, and
the hand-rolled version does not fail loudly. It works on your example and is
wrong on the one you did not think of.

Most of this system is already somebody else's problem, on purpose, and each one
went through an ADR rather than a weekend:

| Instead of | We run |
|---|---|
| A user table, sessions, SSO, SCIM | WorkOS ([ADR-0002](../adr/0002-outsource-identity-to-workos.md), [ADR-0007](../adr/0007-no-local-identity-sync.md)) |
| A cache tier | Dragonfly ([ADR-0020](../adr/0020-dragonfly-shared-cache.md)) |
| A blob store | SeaweedFS ([ADR-0005](../adr/0005-object-storage-for-documents-minio.md), [ADR-0043](../adr/0043-seaweedfs-split-topology-and-per-tenant-buckets.md)) |
| An LLM trace viewer | Langfuse ([ADR-0044](../adr/0044-langfuse-durable-llm-observability.md)) |
| A log pane, error tracking | PostHog ([ADR-0100](../adr/0100-posthog-is-the-product-platform-and-langfuse-feeds-it.md)); the Aspire dashboard of [ADR-0029](../adr/0029-aspire-dashboard-telemetry.md) is retired |
| A changelog pipeline | reno |
| A skill installer | apm |

The move, before the second hundred lines of anything general: search for the
library, then say in the pull request what you found and why it did or did not
fit. "I looked and there is nothing" is a fine answer. Not looking is not.

### The three reasons to write it anyway

**The library's shape does not answer your question.** `ifc-spatial`'s minimum
enclosing rectangle is the worked example. `shapely.minimum_rotated_rectangle`
exists, is installed, and is trustworthy. It agrees with ours to 2.2e-16 m².
It is not used because it hands back a *polygon*, and the operator needs the
axis and the two extents; re-deriving those from the corners is the same
rotating-caliper arithmetic with an extra parse in front of it.

**It would drag a native toolchain into the image.** `render.plan` rasterises a
storey with Pillow rather than cairosvg, even though cairosvg would let us reuse
`ifcopenshell.draw`'s SVG output. cairosvg pulls native cairo, pango and libffi
in to serve one call, and pure wheels are the difference between this working
everywhere and working where somebody remembered to `apt-get`.

**The thing is the product.** The OIB knowledge layer, the card contract, the
authorization catalog, the norm registry. Nobody sells these, and they are what
we are for.

### When you do build it, keep the library as the oracle

This is the part people skip. `ifc-spatial-py` pins `shapely>=2.1.0` *for its
test suite, not for its operators*. Nothing under `src/` calls anything newer
than 2.0. 2.1 is where `minimum_rotated_rectangle` and
`maximum_inscribed_circle` arrived, and those two GEOS functions are what the
suite checks the hand-rolled clearance and accessibility geometry against.

An independent implementation you compare against is what turns "it works on my
example" into evidence. A cross-check that cannot run is not a cross-check,
which is why the floor is a hard requirement rather than a nice-to-have.

### The cost, stated honestly

A dependency is not free, and this repo pays for the ones it has: a 21 KB
`.trivyignore.yaml`, a `security.yml` workflow, and a standing list of Dependabot
advisories on the default branch. So "buy" is not licence to add a package for
something a function would do.

The two rules meet at scale. "The best part is no part" ([Scope](../../AGENTS.md#scope))
decides whether the thing should exist. This rule decides who writes it once the
answer is yes. For genuinely small, genuinely local things, neither buying nor
building is the answer. Deleting the requirement is.

Prefer dependencies that are pure wheels, keep heavy transports optional
(`ifc-spatial-py` puts the MCP SDK and `ifctester` behind extras so a host
embedding the library does not install starlette and uvicorn to get a tool
surface), and pin them.

## Fix causes, not symptoms

Solve the problem at the level it actually exists. A change that makes a number
better without changing what produced it is a bandage, and it makes the real
fault harder to see later because the signal that pointed at it is gone.

The test that surfaced this: `InputArea.spec.tsx` took 45.9s of the UI suite's
209.6s of test execution. Three fixes were available.

| | what it does | level |
|---|---|---|
| Raise the shard count | spreads the same work over more runners | hides it |
| Split the spec file | spreads the same work over more shards | hides it |
| Decompose the component | removes the work | fixes it |

The first two move a 172ms-per-test mount around; only the third makes it stop
costing 172ms. The slow test was never the problem. It was the readout on a
1999-line component that needed eleven mocked modules to render at all. Optimise
that away and the design fault is still there, minus the evidence.

The cause is specific and this repo already solves it elsewhere. 37 of those 102
tests assert on *logic*, on mention rules, addressee resolution and draft
persistence, and each mounts the whole React tree to do it, because the logic lives in the
render function. Compare two specs in the same suite:

| spec | tests | test time | per test |
|------|-------|-----------|----------|
| `layout/lib/source-presets.spec.ts` (logic in a module) | 10 | 13ms | **1.3ms** |
| `layout/components/InputArea.spec.tsx` (logic in a component) | 102 | 17,550ms | **172ms** |

132x, from nothing but where the code sits. `src/features/layout/lib/` is the
established pattern, pure modules with their own fast specs. Extend it rather
than reaching for shards.

So: before optimising a measurement, establish what the measurement is *of*.
Ask what would have to be true for this number to be legitimate, and if it
isn't, fix that instead. When a fast fix and a correct fix disagree, take the
correct one or say plainly that you are deferring it and why. Never ship the
fast one described as the correct one.

Corollary, learned the same way: verify the cause before acting on it. Two
plausible explanations for that 172ms (userEvent's default keystroke delay, an
unmocked motion library) were both measured and both wrong. A cause that has not
been measured is a guess, and a fix built on a guess is a bandage even when it
happens to work.

## Finish the task

Reversible work does not get a permission checkpoint. Carry on to the end state
the user described, then present the result.

The distinction that matters is between *reporting* and *asking*. Reporting
progress at a boundary is good: it lets the user redirect cheaply. Asking
permission to continue is not, because the answer is almost always yes and the
question costs a whole turn to get it.

The case that produced this rule. A user asked for a document-role system,
"end to end". Two slices in, with the domain model green against a real
PostgreSQL and the BFF layer green with twelve tests, the agent stopped and
asked: carry on
into the UI, or review the plan first? The user's reply was, in effect, keep
going, and the instruction to treat the interruption itself as a failure.

They were right to. Nothing about the next slice was irreversible or ambiguous:
the plan had been stated and agreed two turns earlier, the work was on a branch,
and every part of it was revertible. The pause bought no safety and spent a
turn. Worse, it is the *shape* of diligence, because checking in reads as careful, so
it survives review while producing exactly the friction the user is paying an
agent to remove.

The tell is the question's own answer. Before asking "should I continue?",
predict the reply. If the prediction is "yes", the question is a stall: proceed
and report. Reserve the interruption for the cases where you genuinely cannot
predict it, and there, say what you need rather than offering a menu. A menu is
a way of making the user do the deciding you were asked to do.

A related failure with the same root: stopping because the remaining work is
large. Size is not ambiguity. A long task is finished by working through it, and
"this is a lot, shall I?" is the same stall wearing a different hat.

## Ratchet every correction

A **ratchet** turns one way and cannot slip back. A correction that changes only
the output leaves the layer that allowed it exactly as it was, so the same class
of error is free to recur and the next person pays again. Fix the output, then
close the layer. Prefer the layer that holds while people are tired: a database
CHECK constraint asks nobody to remember anything, where a rule in this file
asks every future reader.

The section above is about diagnosing deep enough. This one is about what
happens after the diagnosis, so they compound rather than overlap.

Reach for the playbook, which names the layer to close for each kind of failure
and where each lives in this repo, whenever a reviewer corrects you, something
surprises you, or you correct yourself twice for one reason:
[`correction-ratchet.md`](correction-ratchet.md).

## Everything you learn is written down

Reworking the project mail inbox (PR #831) in October 2026 began with eleven
scouts and thirteen consultants reading the code for a day. Their reports turned
up dozens of facts no doc held: an operation description that named the wrong
status code, an ADR still „proposed“ for a feature in production, a processor
register naming a database the platform had already left, the eight steps to add
a notification type, the rule that a migration journal's `when` must exceed the
last applied one. All of it sat in a scratch directory that dies with the
session. The owner's verdict: everything we learn about the system is written
down, and that is a hard rule, not a courtesy.

Before, the obligation said "Nothing, once" in its failure column: a fact left
unwritten cost nothing until the next person re-earned it. Now the rule in
`AGENTS.md` counts a subagent's report as your own research, asks for each fact
to be re-checked in the code first (a consultant can be confidently wrong, and a
wrong note costs more than a missing one), and the closing checklist of the
definition of done carries a **What we learned** line: each fact and the file it
went to, or "none, because …".

A discrepancy between a doc and the code is fixed in the same change, in
whichever of the two is wrong. Writing "the doc says 400, the code says 409" in
a PR body and moving on leaves the next agent to act on the wrong one.

## Slice work so it runs in parallel

When a change is large enough to hand to several agents (or people), cut it
into slices that own **disjoint files**, and write the contract between them
first (a types file, a wire schema, a route shape) so each slice builds against
it without waiting for the others. A slice is small: one layer of one feature,
an hour of work, not "the backend half".

The case: the Anmerkungen canvas was built by three builders each owning a
large area. Every later piece touched one of those areas and queued behind it,
so the work ran mostly in series and took far longer than it needed to. The
fix was a contract file (`frontends/ui/src/lib/proposals/types.ts`) written
first, and five slices started at once, each told which files it owns and which
it must not touch.

Rules that kept the parallel slices from colliding:

* **Hot files have one owner at a time:** migration bookkeeping
  (`drizzle/meta/_journal.json`, `rls-coverage.spec.ts`, `scripts/rls-test-db.sh`),
  `lib/db/schema/index.ts`, each i18n namespace, a shared service. A slice that
  needs one reports the exact lines instead of editing.
* **Only the integrator touches git.** Builders make file changes; a shared
  index means one builder's staged move lands in another's commit (see
  [`gotchas.md`](gotchas.md)).
* **Integrate as each slice reports**, with the checks run on the combined tree,
  rather than waiting for all of them.

## Ask which object already owns the work before giving it a record

Before adding a table, a status or a list for "work somebody handed over", find
the object the work is ABOUT and read its lifecycle. When it already has a
responsible person, a status and a place to discuss it, the work belongs there,
and what is missing is at most a record of the agent's activity on it, not a
second work item that has to be kept in step with the first forever.

The case: asked whether event-woken turns rebuilt tasks, the first answer was
"make a mark delegated to Piloti a task run". It would have given one piece of
work two records (the mark's offen → erledigt and the task's queued → accepted),
two lists, and no delegation on the Büroablage, whose documents have no
project. The mark already had the person, the status and the thread; the wake
only lacked an end. Twenty minutes of design went into the wrong record before
the question was asked. The decision, and the shape that answered it (Linear's:
work is delegated to an agent, the agent's activity is a session on the issue),
is in ADR-0106.

## Prompting advice has a three-month shelf life

Guidance on how to prompt a model, write its tool descriptions or size its
context goes stale with every model generation. Before a prompt or a tool
description changes on the strength of outside advice, the advice comes from
the vendor's live documentation or engineering posts published or updated in
the last three months, each source cited with its date; anything older or
undated is listed as excluded, not used. A consultant agent asked for this
research runs on the strongest model available, never a small one.

The case: on 2026-10-22 a prompt rewrite for the chat agent was briefed from a
consultant that ran on a small model with undated sources. The product owner
stopped it; the research was redone with dated, in-window sources only.

The philosophy those sources serve, in the owner's words: unhobble the model.
Say what the agent is for, what a good answer is and which rails hold, give it
well-described tools, and leave the thinking to it. A rule earns its place by
the reason it states, once, where it applies.
