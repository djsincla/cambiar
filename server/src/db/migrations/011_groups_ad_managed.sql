-- AD-managed groups are reconciled from AD memberships on every AD login.
-- Manual edits via the API are refused while this flag is set, so admins
-- aren't double-managing membership against AD as the source of truth.
ALTER TABLE groups ADD COLUMN ad_managed INTEGER NOT NULL DEFAULT 0;
