-- Standard-change support: types can be marked auto-approve (skip the manual
-- approval gate). Conceptually mutually exclusive with approver groups; the
-- API enforces that.
ALTER TABLE change_types ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0;

-- Inbox queue ordering needs the moment of submission, not the creation time
-- (drafts may sit before being submitted). Backfill from the audit log so
-- existing pending changes still sort sensibly.
ALTER TABLE changes ADD COLUMN submitted_at TEXT;

UPDATE changes
   SET submitted_at = (
       SELECT MIN(created_at) FROM audit_log
        WHERE audit_log.change_id = changes.id
          AND audit_log.action = 'submit'
   )
 WHERE submitted_at IS NULL;
