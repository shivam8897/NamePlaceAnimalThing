-- ══════════════════════════════════════════════════
--  N·P·A·T  —  Supabase Schema
--  Paste this into Supabase SQL Editor and run it once.
-- ══════════════════════════════════════════════════

-- Players: one row per device (UUID generated client-side, stored in localStorage)
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
  played_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Leaderboard view: ranks computed live from match history
CREATE OR REPLACE VIEW leaderboard AS
SELECT
  p.id,
  p.username,
  p.country,
  COALESCE(SUM(mr.score), 0)::INTEGER  AS total_score,
  COUNT(mr.id)::INTEGER                 AS matches,
  COALESCE(MAX(mr.score), 0)::INTEGER  AS best_score,
  RANK() OVER (ORDER BY COALESCE(SUM(mr.score), 0) DESC)::INTEGER AS rank
FROM players p
INNER JOIN match_results mr ON mr.player_id = p.id
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

-- Public read (leaderboard is visible to everyone)
CREATE POLICY "public read players"  ON players       FOR SELECT USING (true);
CREATE POLICY "public read results"  ON match_results FOR SELECT USING (true);

-- Anyone can insert/update (server uses anon key; no auth required)
CREATE POLICY "insert players"       ON players       FOR INSERT WITH CHECK (true);
CREATE POLICY "update players"       ON players       FOR UPDATE USING (true);
CREATE POLICY "insert results"       ON match_results FOR INSERT WITH CHECK (true);
