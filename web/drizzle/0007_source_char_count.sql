-- Cache source lengths so workspace/sidebar reads do not fetch full document text.
-- Additive and safe for existing projects; the backfill keeps the UI counts exact.
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS char_count integer;

UPDATE sources
SET char_count = char_length(text)
WHERE char_count IS NULL;

CREATE INDEX IF NOT EXISTS sources_notebook_created_idx
  ON sources (notebook_id, created_at DESC);
