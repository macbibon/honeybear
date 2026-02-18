-- 00003_arena.sql

CREATE TABLE public.arenas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  opponent_name   TEXT NOT NULL,
  opponent_rp     INTEGER NOT NULL DEFAULT 10,
  rounds_data     JSONB NOT NULL DEFAULT '[]',
  player_scores   JSONB NOT NULL DEFAULT '[]',
  opponent_scores JSONB NOT NULL DEFAULT '[]',
  player_hp       INTEGER NOT NULL DEFAULT 100,
  opponent_hp     INTEGER NOT NULL DEFAULT 100,
  result          TEXT DEFAULT NULL,
  honey_delta     DOUBLE PRECISION NOT NULL DEFAULT 0,
  rp_delta        INTEGER NOT NULL DEFAULT 0,
  streak_bonus    DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_arenas_user_id ON public.arenas (user_id);

ALTER TABLE public.arenas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "arenas_select_own" ON public.arenas
  FOR SELECT TO authenticated, anon
  USING (false);

CREATE POLICY "arenas_no_insert" ON public.arenas
  FOR INSERT TO authenticated, anon
  WITH CHECK (false);

CREATE POLICY "arenas_no_update" ON public.arenas
  FOR UPDATE TO authenticated, anon
  USING (false) WITH CHECK (false);

CREATE POLICY "arenas_no_delete" ON public.arenas
  FOR DELETE TO authenticated, anon
  USING (false);

-- Streak field on users
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS arena_streak INTEGER NOT NULL DEFAULT 0;