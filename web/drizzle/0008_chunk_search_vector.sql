-- Additive lexical candidate index for BM25 request-time retrieval.
-- The application still keeps its TypeScript BM25 scorer as the source of
-- truth; this vector only reduces how many rows need to cross the API.
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION public.refresh_source_search_vector()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_vector := to_tsvector(
    'simple',
    coalesce(NEW.title, '') || ' ' || coalesce(NEW.text, '')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sources_search_vector_before_write ON sources;
CREATE TRIGGER sources_search_vector_before_write
BEFORE INSERT OR UPDATE OF title, text ON sources
FOR EACH ROW
EXECUTE FUNCTION public.refresh_source_search_vector();

UPDATE sources
SET search_vector = to_tsvector(
  'simple',
  coalesce(title, '') || ' ' || coalesce(text, '')
)
WHERE search_vector IS NULL;

CREATE INDEX IF NOT EXISTS sources_search_vector_gin_idx
  ON sources USING gin (search_vector);

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION public.refresh_chunk_search_vector()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_title text;
BEGIN
  SELECT title INTO source_title
  FROM sources
  WHERE id = NEW.source_id;

  NEW.search_vector := to_tsvector(
    'simple',
    coalesce(source_title, '') || ' ' || coalesce(NEW.text, '')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chunks_search_vector_before_write ON chunks;
CREATE TRIGGER chunks_search_vector_before_write
BEFORE INSERT OR UPDATE OF source_id, text ON chunks
FOR EACH ROW
EXECUTE FUNCTION public.refresh_chunk_search_vector();

UPDATE chunks AS c
SET search_vector = to_tsvector(
  'simple',
  coalesce(s.title, '') || ' ' || coalesce(c.text, '')
)
FROM sources AS s
WHERE s.id = c.source_id
  AND c.search_vector IS NULL;

CREATE INDEX IF NOT EXISTS chunks_search_vector_gin_idx
  ON chunks USING gin (search_vector);

CREATE OR REPLACE FUNCTION public.refresh_chunks_for_source_title()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE chunks AS c
  SET search_vector = to_tsvector(
    'simple',
    coalesce(NEW.title, '') || ' ' || coalesce(c.text, '')
  )
  WHERE c.source_id = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS source_title_search_vector_after_update ON sources;
CREATE TRIGGER source_title_search_vector_after_update
AFTER UPDATE OF title ON sources
FOR EACH ROW
WHEN (OLD.title IS DISTINCT FROM NEW.title)
EXECUTE FUNCTION public.refresh_chunks_for_source_title();
