-- 0080: an organization on its own key sees tokens, not credits.
--
-- ## The decision
--
-- A generation that ran on the tenant's own provider key (`is_byok`) cost the
-- platform nothing, and the platform bills nothing for it. 0079 priced such
-- rows at margin 1, which showed those tenants credits that no invoice would
-- ever carry. That is gone: a BYOK row has price 0 and credits 0. What such an
-- organization sees, and limits, is the one thing it actually consumes on its
-- own bill — tokens. Credits stay the unit for everyone the platform bills.
--
-- ## Rollups learn tokens and own-key cost
--
-- Enforcement reads the rollup, never the month's ledger (ADR-0019), so a
-- token limit needs the tokens there. `own_key_cost_usd` is the share of
-- `cost_usd` that was the tenant's own bill: the platform overview subtracts
-- it, so "cost this month" is what OpenRouter charges the PLATFORM, and a
-- tenant on its own key does not inflate it.
ALTER TABLE "llm_usage_rollups"
  ADD COLUMN IF NOT EXISTS "tokens" bigint DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "own_key_cost_usd" numeric(14, 8) DEFAULT '0' NOT NULL;
--> statement-breakpoint
-- The 0079 backfill priced BYOK rows at the boot floor; un-price them.
UPDATE "llm_usage_events"
  SET "price_usd" = 0, "credits" = 0
  WHERE "is_byok" = true AND ("price_usd" <> 0 OR "credits" <> 0);
--> statement-breakpoint
-- Rebuild every rollup's derived columns from the ledger in one pass, so the
-- new columns are exact and the un-pricing above is reflected. Same grain as
-- the 0015 backfill: (org, UTC day, user, project).
UPDATE "llm_usage_rollups" AS r
  SET "price_usd" = s.price_usd,
      "credits" = s.credits,
      "tokens" = s.tokens,
      "own_key_cost_usd" = s.own_key_cost_usd,
      "updated_at" = now()
  FROM (
    SELECT
      organization_id,
      (created_at AT TIME ZONE 'UTC')::date AS day,
      coalesce(user_id, '') AS user_id,
      coalesce(project_id, '') AS project_id,
      coalesce(sum(price_usd), 0) AS price_usd,
      coalesce(sum(credits), 0) AS credits,
      coalesce(sum(total_tokens), 0) AS tokens,
      coalesce(sum(cost_usd) FILTER (WHERE is_byok = true), 0) AS own_key_cost_usd
    FROM "llm_usage_events"
    GROUP BY 1, 2, 3, 4
  ) AS s
  WHERE r.organization_id = s.organization_id
    AND r.day = s.day
    AND r.user_id = s.user_id
    AND r.project_id = s.project_id;
--> statement-breakpoint

-- ## A limit names its unit
--
-- `currency` on a budget policy now says which unit the limit is in: `credit`
-- for a platform-billed organization, `token` for one on its own key. A policy
-- is only honoured while the organization is on that unit; switching the key
-- mode leaves the other unit's rows in place, ignored, so switching back
-- restores them. The CHECK grows by one value; nothing else moves.
ALTER TABLE "budget_policies" DROP CONSTRAINT IF EXISTS "budget_policies_currency_check";
--> statement-breakpoint
ALTER TABLE "budget_policies"
  ADD CONSTRAINT "budget_policies_currency_check" CHECK ("currency" IN ('credit', 'token'));
