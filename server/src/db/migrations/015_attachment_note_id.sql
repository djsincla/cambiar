-- Allow attachments to be threaded under a specific note rather than just
-- attached to the change as a whole. Existing rows keep note_id = NULL,
-- meaning "change-wide" — same behavior as before. The CASCADE on
-- change_notes means deleting a note also deletes its attachments.
ALTER TABLE change_attachments ADD COLUMN note_id INTEGER
  REFERENCES change_notes(id) ON DELETE CASCADE;
CREATE INDEX idx_change_attachments_note ON change_attachments(note_id) WHERE note_id IS NOT NULL;
