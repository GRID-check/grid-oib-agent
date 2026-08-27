-- Down for 0070: restore the 0068 action list. Any 'flagged_ineffective'
-- events must be removed first or the narrower CHECK cannot be validated —
-- they are sweep-derived (recomputable from lesson_reports), not source data.
DELETE FROM "platform_lesson_events" WHERE "action" = 'flagged_ineffective';
--> statement-breakpoint
ALTER TABLE "platform_lesson_events"
  DROP CONSTRAINT "platform_lesson_events_action_check";
--> statement-breakpoint
ALTER TABLE "platform_lesson_events"
  ADD CONSTRAINT "platform_lesson_events_action_check"
    CHECK ("action" IN ('created', 'report_linked', 'activated', 'retired',
                        'reactivated', 'edited', 'root_cause_updated'));
