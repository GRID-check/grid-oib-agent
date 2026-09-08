-- 0079: cost is what Piloti pays, price is what the tenant pays, credits are
-- the unit the tenant sees. (ADR-0053, docs/architecture/usage-budgets.md)
--
-- ## The problem this fixes
--
-- The ledger stores `cost_usd` exactly as OpenRouter reported it, and until
-- now every tenant-facing surface showed that number converted to euros. That
-- is the platform's purchase price. A customer reading it sees our margin on
-- every request, which weakens every pricing conversation and contradicts a
-- value-based offer. Customers still need full usage transparency; they need
-- it in a unit that is theirs, not ours.
--
-- ## The model: two numbers, both linear, no currency conversion
--
--   price_usd = cost_usd × margin_multiplier   (margin 1 for BYOK)
--   credits   = price_usd ÷ usd_per_credit
--
-- USD throughout, because USD is what OpenRouter charges and the only figure
-- the platform actually knows. The old EUR display multiplied cost by a
-- hand-set rate that was neither the bank's nor OpenRouter's; it is gone, and
-- the platform owner reads the charge as it is. What a tenant pays per credit
-- in their own currency is a matter for the contract, not for this table.
--
-- Linear on purpose. A budget of 1,000 credits a month, a per-model breakdown,
-- a top-up, an invoice line — all of them are sums, and a sum is only meaningful
-- when the unit adds. A compressive transform (points = A·cost^p) was proposed
-- and rejected: two 1-point requests would not cost what one 2-point request
-- costs, and a monthly total in points would say nothing about the money behind
-- it.
--
-- ## Priced at write time, frozen on the row
--
-- The price of a generation is decided the moment it is recorded, from the
-- pricing version active at that moment, and never recomputed. A margin change
-- next quarter must not rewrite what a tenant was shown last month. That is why
-- `price_usd`, `credits` and `pricing_version_id` sit on the ledger row instead
-- of being derived at read time the way the old EUR conversion was.
-- `cost_usd` stays raw: it is the reconciliation key against OpenRouter and the
-- platform's own cost basis.
--
-- ## The pricing table
--
-- One active row, append-only with the supersede idiom `budget_policies` already
-- uses: changing a number writes a new row and marks the old one superseded, so
-- every ledger row can name the version that priced it and every change carries
-- an author. The two numbers plus the seeded org allowance are ONE row
-- because they are one decision — a margin without a credit price is not a
-- price list — and a version id has to point at the whole of it.
--
-- Global, NOT tenant-scoped (no organization_id): pricing is the platform's
-- price list. A PLATFORM table for the tenant boundary — every tenant reads it,
-- only the platform role writes it.
--
-- ## No row: the boot floor
--
-- The table starts empty and the application then prices at the boot floor:
-- margin 1, one credit = one US cent, seeded allowance 1,000 credits a day /
-- 10,000 a month ($10 / $100 of cost). Not seeded by this migration: a decision
-- nobody made must not appear in the audit trail as if someone had.
CREATE TABLE IF NOT EXISTS "platform_pricing_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Price ÷ cost. 1 = pass-through; 2.5 = a 150 % markup.
  "margin_multiplier" numeric(8, 4) NOT NULL,
  -- How much USD of PRICE one credit stands for. With margin 2.5 and 0.10 here,
  -- a call that cost the platform $0.04 is 1 credit.
  "usd_per_credit" numeric(10, 6) NOT NULL,
  -- The allowance an organization gets until its admins set explicit limits.
  -- NULL = that window is unlimited by default.
  "default_org_daily_credits" numeric(14, 4),
  "default_org_monthly_credits" numeric(14, 4),
  "status" text DEFAULT 'active' NOT NULL,
  "supersedes_id" uuid,
  "note" text,
  "created_by" text NOT NULL,
  "created_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- The database holds the line nobody has to remember: a zero or negative
  -- rate would price every generation at nothing or at a refund.
  CONSTRAINT "platform_pricing_margin_positive" CHECK ("margin_multiplier" > 0),
  CONSTRAINT "platform_pricing_usd_per_credit_positive" CHECK ("usd_per_credit" > 0),
  CONSTRAINT "platform_pricing_defaults_non_negative"
    CHECK (("default_org_daily_credits" IS NULL OR "default_org_daily_credits" >= 0)
       AND ("default_org_monthly_credits" IS NULL OR "default_org_monthly_credits" >= 0)),
  CONSTRAINT "platform_pricing_status_check" CHECK ("status" IN ('active', 'superseded'))
);
--> statement-breakpoint
-- At most ONE active price list.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_platform_pricing_active"
  ON "platform_pricing_versions" ("status") WHERE "status" = 'active';
--> statement-breakpoint
SELECT grid_secure_platform_table('platform_pricing_versions');
--> statement-breakpoint

-- ## The ledger learns the price
--
-- Nullable version id: rows priced at the boot floor point at no row, and the
-- rows that existed before today are backfilled at the boot floor below.
ALTER TABLE "llm_usage_events"
  ADD COLUMN IF NOT EXISTS "price_usd" numeric(14, 8) DEFAULT '0' NOT NULL,
  ADD COLUMN IF NOT EXISTS "credits" numeric(14, 6) DEFAULT '0' NOT NULL,
  ADD COLUMN IF NOT EXISTS "pricing_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "llm_usage_rollups"
  ADD COLUMN IF NOT EXISTS "price_usd" numeric(14, 8) DEFAULT '0' NOT NULL,
  ADD COLUMN IF NOT EXISTS "credits" numeric(14, 6) DEFAULT '0' NOT NULL;
--> statement-breakpoint
-- Backfill at the boot floor (margin 1, one credit = one US cent). These rows
-- were guardrail telemetry, never invoices; the floor keeps every existing
-- dashboard reading what it read yesterday, in the new unit.
UPDATE "llm_usage_events"
  SET "price_usd" = "cost_usd",
      "credits" = "cost_usd" * 100
  WHERE "price_usd" = 0 AND "cost_usd" <> 0;
--> statement-breakpoint
UPDATE "llm_usage_rollups"
  SET "price_usd" = "cost_usd",
      "credits" = "cost_usd" * 100
  WHERE "price_usd" = 0 AND "cost_usd" <> 0;
--> statement-breakpoint

-- ## Budget limits are credits now
--
-- A limit is what a tenant may consume, and the tenant consumes credits. The
-- old EUR limits were limits on the platform's cost, compared at the shipped
-- default of 0.86 EUR per USD; at the boot floor one US cent of cost is one
-- credit, so €1 of the old limit is 100 / 0.86 credits. Applied to every stored
-- row, active or superseded, so the history reads in one unit. A deployment
-- that ran on a different rate should have its admins re-check their limits
-- (release note). `currency` keeps its name and the constraint says the only
-- value it may hold.
UPDATE "budget_policies"
  SET "daily_limit" = round("daily_limit" * 100 / 0.86, 4),
      "monthly_limit" = round("monthly_limit" * 100 / 0.86, 4),
      "currency" = 'credit'
  WHERE "currency" = 'EUR';
--> statement-breakpoint
ALTER TABLE "budget_policies" ALTER COLUMN "currency" SET DEFAULT 'credit';
--> statement-breakpoint
ALTER TABLE "budget_policies"
  ADD CONSTRAINT "budget_policies_currency_check" CHECK ("currency" = 'credit');
