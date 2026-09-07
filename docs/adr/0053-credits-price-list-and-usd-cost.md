---
status: accepted
date: 2026-09-07
decision-makers: Grid engineering, product owner
consulted: Piloti product & technical team ("Punkte statt Euro" discussion paper)
informed: everyone working in this repo
---

# Tenants see credits, the platform sees USD as charged, and a margin sits between them

## Context and Problem Statement

ADR-0015 meters every generation into a ledger with `cost_usd` exactly as
OpenRouter reported it, and every tenant-facing surface then showed that number
converted to euros at a hand-set rate. That number is the platform's purchase
price. A customer reading their "Usage & budgets" page saw Piloti's margin on
every request, which weakens every pricing conversation and contradicts a
value-based offer. Customers still need full usage transparency, and budgets
still have to stop a runaway run; both must work in a unit that is the
customer's, not the supplier's.

Two further faults sat underneath. The euro figure was neither the bank's rate
nor OpenRouter's; it was a deployment constant nobody maintained, so the
platform itself never saw the charge as it actually was. And the conversion
happened at read time, so changing the constant silently rewrote every
historical figure a tenant had been shown.

An internal proposal ("Punkte statt Euro") reached the right goal, a
customer-facing unit instead of euros, through a compressive formula,
`points = round(A × cost^p)` with `p < 1`, chosen to blur the cost spread
between cheap and expensive models. This record adopts the goal and rejects
the formula.

## Decision Drivers

* Tenants must never see the platform's purchase price, on any surface: the
  usage page, the model picker, the API responses behind them.
* The platform must read its cost as OpenRouter charges it, in USD, with no
  conversion in between: a figure nobody is charged is not worth showing.
* The margin must be one explicit number a platform owner can change in the
  product, not a redeploy.
* What a tenant was shown for a past request must never change because the
  price list changed afterwards.
* Budgets, breakdowns and future invoices are all sums, so the tenant unit must
  add: the credits of a month must be the sum of the credits of its requests.
* Nothing may change in the Python metering path; it reads OpenRouter's usage
  object and knows nothing about pricing.

## Considered Options

* **A compressive points formula** (`A × cost^p`), as proposed.
* **A linear credit unit with a platform price list**: price = cost × margin,
  credits = price ÷ credit price, both numbers set by the platform owner.
* **Hide the models** and show only tiers; tenants could no longer pick a
  model.
* **Do nothing**: keep showing cost in euros.

## Decision Outcome

Chosen option: "a linear credit unit with a platform price list", because it is
the only option under which the tenant's unit behaves like money.

Three words, kept apart everywhere in code and docs:

| Word | Unit | Meaning | Who sees it |
|---|---|---|---|
| cost | USD | what OpenRouter charged the platform, raw | platform owners only |
| price | USD | cost × margin; zero on a tenant's own key | platform owners only |
| credits | credits | price ÷ credit price | platform-billed tenants, everywhere |
| tokens | tokens | the row's token count | tenants on their own key, everywhere — no credits, no price |

1. **A price list, versioned** (`platform_pricing_versions`): the margin
   multiplier, the credit price in USD, and the allowance every organization is
   seeded with until its admins set limits. One row because they are one
   decision. Append-only with the supersede idiom, at most one active row, no
   `organization_id` (a platform table). An empty table means the boot floor:
   margin 1, one credit = one US cent, 1,000 / 10,000 credits a day / month,
   which is the previous guardrail in the new unit, so an upgraded deployment
   behaves as it did until a platform owner decides a price.
2. **Priced at write time, frozen on the row.** `recordUsageEvents` resolves
   the active pricing once per batch and stores `price_usd`, `credits` and
   `pricing_version_id` beside the raw `cost_usd`. Nothing is ever repriced.
   The write-through rollup (ADR-0019) carries the same three columns, so
   enforcement stays a rollup read.
3. **No currency conversion anywhere.** `GRID_BUDGET_EUR_PER_USD` is removed.
   Platform surfaces show USD as charged; the euro price of a credit bundle is
   the contract's business, outside the ledger.
4. **Budgets are credits.** `budget_policies` limits are credits (existing
   rows converted at the boot floor and the previous default rate); the
   seeded org allowance comes from the price list rather than a code constant.
5. **One unit per organization, from its key mode.** An organization the
   platform bills is on credits. An organization on its own provider key
   (ADR-0022) pays that provider, so the platform bills it nothing: its
   generations are priced at zero, it sees no credits and no price, and what it
   sees and limits is tokens, straight off the ledger row. Limits carry their
   unit (`budget_policies.currency`, CHECK `credit | token`) and only the
   current unit's limits are honoured; an own-key organization is seeded with
   no limit and sets its own. The rollup carries `tokens` and the own-key share
   of cost so enforcement and the platform overview stay rollup and ledger
   reads.
6. **The Python tracker meters both.** It already counts cost and tokens off
   the same usage object; the `x-grid-budget` snapshot carries whichever family
   applies — USD of cost (the exact inverse of pricing) for a credit
   organization, tokens for a token organization — and it enforces both.
7. **Tenant responses carry one unit only.** The usage service narrows every
   window to `{amount, events}` in the organization's unit in one projection,
   so a new tenant endpoint reusing it cannot leak cost, price or the other
   unit. The model picker shows "≈ N credits per request" for a fixed
   reference request priced at the active list to credit organizations and no
   hint at all to own-key ones; the catalog's per-token USD prices no longer
   reach a tenant.
8. **Platform → Overview** carries the price list editor (margin, credit price,
   seeded allowance, change note, version trail) and shows the platform's own
   cost (own-key usage subtracted and named), revenue and gross margin per
   organization and in total, badging organizations whose usage ran on their
   own key.

### Consequences

* Good, because credits add: a limit of 1,000 credits means 1,000 credits of
  price whatever mix of models produced it, and a per-model breakdown sums to
  the total. Invoicing and top-ups become possible on the same numbers.
* Good, because the margin is one number in one place, auditable, effective on
  the next request, and every ledger row names the version that priced it.
* Good, because a price change never rewrites history.
* Good, because the platform finally reads its cost as charged.
* Bad, because an organization that switches key mode sees its limits change
  unit: the other unit's limits are kept but ignored until it switches back,
  and nothing converts between them. Accepted: there is no honest exchange rate
  between a token on the tenant's bill and a credit on ours.
* Bad, because a tenant who knows a model's public list price and their
  contract's euro price per credit can still back out the margin. That is
  accepted: the goal is not to display the margin, not to make it secret, and
  the compressive formula would not have achieved secrecy either.
* Bad, because existing explicit budget policies were converted at the shipped
  default rate; a deployment that ran on another rate has limits off by that
  ratio until an admin re-checks them (release note).

### Confirmation

* `platform_pricing_versions` CHECK constraints refuse zero or negative rates
  and a partial unique index refuses a second active row; the service bounds
  refuse slipped decimals before the write (`lib/pricing/service.ts`).
* `budget_policies_currency_check` refuses any unit but `credit`.
* `lib/pricing/model.spec.ts` pins additivity, that an own-key generation is
  priced at nothing, and that the budget conversion is the exact inverse of
  pricing. `tests/aiq_agent/common/test_cost_tracking.py` pins that the
  tracker enforces the token family and stays unlimited on it for a snapshot
  from an older BFF.
* `rls-coverage.spec.ts` lists the table as a platform table;
  `platform-permission-coverage.spec.ts` pins the pricing route's permissions;
  the pricing route spec pins 422-before-write and the audit event.
* The tenant projection in `getUsageOverview` is the only path tenant usage
  responses take; the budget card spec renders credits and asserts no currency
  text.
* Nothing yet enforces that a NEW tenant-facing endpoint uses that projection
  rather than the repository shapes; review is the gate there.

## Pros and Cons of the Options

### A compressive points formula

* Good, because it is cheap to implement and visibly blurs the cost spread.
* Bad, because points do not add: two 1-point requests and one 2-point request
  cost different amounts of money, so a monthly total, a per-model breakdown,
  a budget limit or an invoice line in points says nothing about the money
  behind it. Every downstream feature would have to undo the transform.
* Bad, because it hides nothing from a reader who knows the model ids (shown
  beside the points) and OpenRouter's public list prices.
* Bad, because `A` and `p` are two opaque parameters where the business needs
  one named number, the margin.

### Hide the models, show tiers

* Good, because it is the only option that actually hides the cost spread.
* Bad, because tenants lose the model choice ADR-0014 deliberately gave them,
  and the tier boundaries become a second pricing artefact to maintain.

### Do nothing

* Bad, for the reasons in the problem statement.

## More Information

* The design and every touch point: `docs/architecture/usage-budgets.md`.
* Supersedes the currency paragraph of ADR-0015 (§Decision 6) and its
  `GRID_BUDGET_EUR_PER_USD` variable; the rest of ADR-0015 and ADR-0019 stand.
* Decided after the first cut: own-key organizations see tokens and nothing
  else (migration 0080). Open: whether the seeded allowance should become a
  per-plan setting once plans exist.
* The new audit action `platform.pricing.updated` has to be provisioned in every
  WorkOS environment (`bun run provision:audit-schemas`) before the event is
  accepted there; until then the save succeeds and the emitter logs the
  rejection, as for every other unprovisioned action.
