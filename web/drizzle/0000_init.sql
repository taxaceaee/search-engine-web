CREATE TABLE IF NOT EXISTS notebooks (
  id varchar(36) PRIMARY KEY,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
  id varchar(36) PRIMARY KEY,
  notebook_id varchar(36) NOT NULL,
  title text NOT NULL,
  mime text,
  text text NOT NULL,
  char_count integer,
  search_vector tsvector,
  blob_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  id varchar(36) PRIMARY KEY,
  source_id varchar(36) NOT NULL,
  notebook_id varchar(36) NOT NULL,
  chunk_index integer NOT NULL,
  text text NOT NULL,
  token_est integer,
  embedding_json jsonb,
  embedding_model text,
  search_vector tsvector
);

CREATE TABLE IF NOT EXISTS search_runs (
  id varchar(36) PRIMARY KEY,
  query text NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'completed',
  results_json jsonb,
  answer text,
  timing_json jsonb,
  metrics_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS search_sessions (
  id varchar(36) PRIMARY KEY,
  title text NOT NULL DEFAULT 'New chat',
  summary text,
  entities_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS search_messages (
  id varchar(36) PRIMARY KEY,
  session_id varchar(36) NOT NULL,
  role varchar(16) NOT NULL,
  content text NOT NULL,
  expanded_query text,
  results_json jsonb,
  timing_json jsonb,
  metrics_json jsonb,
  status varchar(32) NOT NULL DEFAULT 'completed',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chunks_notebook_idx ON chunks (notebook_id);
CREATE INDEX IF NOT EXISTS sources_notebook_idx ON sources (notebook_id);
CREATE INDEX IF NOT EXISTS search_runs_created_idx ON search_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS search_sessions_updated_idx ON search_sessions (updated_at DESC);
CREATE INDEX IF NOT EXISTS search_messages_session_idx ON search_messages (session_id, created_at ASC);
