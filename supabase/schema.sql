-- ══════════════════════════════════════════════════
--  N·P·A·T  —  Supabase Schema
--  Paste this into Supabase SQL Editor and run it once.
--
--  NOTE: Enable Supabase Auth in your project.
--  For a smooth game experience, disable email confirmation:
--  Authentication → Providers → Email → "Confirm email" → OFF
-- ══════════════════════════════════════════════════

-- Players: one row per authenticated user (id = Supabase auth user UUID)
CREATE TABLE IF NOT EXISTS players (
  id         UUID PRIMARY KEY,
  username   TEXT NOT NULL,
  country    TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Match results: one row per competitive game per player
CREATE TABLE IF NOT EXISTS match_results (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id  UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  score      INTEGER NOT NULL,
  ai_scored  BOOLEAN NOT NULL DEFAULT FALSE,
  played_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Funny Words of the Day: top 3 per day, reset at midnight
CREATE TABLE IF NOT EXISTS funny_words (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rank        INTEGER NOT NULL,
  answer      TEXT NOT NULL,
  field       TEXT NOT NULL,
  letter      CHAR(1) NOT NULL,
  player_name TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT '',
  word_date   DATE NOT NULL DEFAULT CURRENT_DATE
);

-- Leaderboard view: only AI-validated scores count
CREATE OR REPLACE VIEW leaderboard AS
SELECT
  p.id,
  p.username,
  p.country,
  COALESCE(SUM(mr.score), 0)::INTEGER   AS total_score,
  COUNT(mr.id)::INTEGER                  AS matches,
  COALESCE(MAX(mr.score), 0)::INTEGER   AS best_score,
  RANK() OVER (ORDER BY COALESCE(SUM(mr.score), 0) DESC)::INTEGER AS rank
FROM players p
INNER JOIN match_results mr ON mr.player_id = p.id
WHERE mr.ai_scored = TRUE
GROUP BY p.id, p.username, p.country
ORDER BY total_score DESC
LIMIT 100;

-- Auto-update updated_at on every player upsert
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_players_updated ON players;
CREATE TRIGGER trg_players_updated
  BEFORE UPDATE ON players
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Row Level Security
ALTER TABLE players       ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE funny_words   ENABLE ROW LEVEL SECURITY;

-- Public read
DROP POLICY IF EXISTS "public read players"     ON players;
DROP POLICY IF EXISTS "public read results"     ON match_results;
DROP POLICY IF EXISTS "public read funny_words" ON funny_words;
CREATE POLICY "public read players"      ON players       FOR SELECT USING (true);
CREATE POLICY "public read results"      ON match_results FOR SELECT USING (true);
CREATE POLICY "public read funny_words"  ON funny_words   FOR SELECT USING (true);

-- Write policies (server uses anon key; no auth required for these operations)
DROP POLICY IF EXISTS "insert players"     ON players;
DROP POLICY IF EXISTS "update players"     ON players;
DROP POLICY IF EXISTS "insert results"     ON match_results;
DROP POLICY IF EXISTS "update results"     ON match_results;
DROP POLICY IF EXISTS "insert funny_words" ON funny_words;
DROP POLICY IF EXISTS "delete funny_words" ON funny_words;
CREATE POLICY "insert players"       ON players       FOR INSERT WITH CHECK (true);
CREATE POLICY "update players"       ON players       FOR UPDATE USING (true);
CREATE POLICY "insert results"       ON match_results FOR INSERT WITH CHECK (true);
CREATE POLICY "update results"       ON match_results FOR UPDATE USING (true);
CREATE POLICY "insert funny_words"   ON funny_words   FOR INSERT WITH CHECK (true);
CREATE POLICY "delete funny_words"   ON funny_words   FOR DELETE USING (true);
