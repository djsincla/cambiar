-- Change-to-change relationships. Two kinds of link today:
--   depends_on : directional. A -> B means "A depends on B"; A can't be
--                started or implemented until B is implemented or closed.
--   relates_to : symmetric soft link, no enforcement, "see also".
-- Self-links and duplicates are blocked at the app level.
CREATE TABLE change_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_change_id INTEGER NOT NULL,
  to_change_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('depends_on', 'relates_to')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  FOREIGN KEY (from_change_id) REFERENCES changes(id) ON DELETE CASCADE,
  FOREIGN KEY (to_change_id)   REFERENCES changes(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by)     REFERENCES users(id)   ON DELETE SET NULL,
  UNIQUE(from_change_id, to_change_id, kind)
);

CREATE INDEX idx_change_links_from ON change_links(from_change_id);
CREATE INDEX idx_change_links_to   ON change_links(to_change_id);
