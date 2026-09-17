-- 0070: lesson effectiveness — teach the event trail two automatic verdicts.
--
-- The vote counters (0069) are a shared clock: every active lesson counts the
-- same fleet-wide feedback window, so they can say "the fleet got worse" but
-- never "THIS lesson is not working". The per-lesson signal the pipeline does
-- have is RECURRENCE: a new report that semantically links to an already
-- ACTIVE lesson means the failure the lesson exists to prevent happened again
-- while it was being injected. Two sweep steps act on that:
--
--   'flagged_ineffective' — recorded once per activation when linked reports
--     since activation cross the threshold. The bandage stays ON (the wound is
--     demonstrably open); the flag routes attention to the root cause.
--   automatic 'retired' — when the root cause is marked addressed and a quiet
--     period passes with zero recurrences, the sweep retires the lesson with
--     detail.automatic = true. This is the "owner retires once the fix is
--     verified" rule from 0068, with the verification made mechanical:
--     no recurrence after the fix IS the evidence.
--
-- Only the action CHECK changes; 'retired' already exists as an action and the
-- automatic path reuses it, distinguished by detail.automatic.
ALTER TABLE "platform_lesson_events"
  DROP CONSTRAINT "platform_lesson_events_action_check";
--> statement-breakpoint
ALTER TABLE "platform_lesson_events"
  ADD CONSTRAINT "platform_lesson_events_action_check"
    CHECK ("action" IN ('created', 'report_linked', 'activated', 'retired',
                        'reactivated', 'edited', 'root_cause_updated',
                        'flagged_ineffective'));
