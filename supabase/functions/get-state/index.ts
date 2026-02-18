-- 00001_init.sql

-- ============================================================
-- ТАБЛИЦА ПОЛЬЗОВАТЕЛЕЙ
-- ============================================================
CREATE TABLE public.users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tg_id       BIGINT NOT NULL UNIQUE,
  bear_name   TEXT NOT NULL DEFAULT 'Медведь',
  honey       DOUBLE PRECISION NOT NULL DEFAULT 200,
  amber       BIGINT NOT NULL DEFAULT 0,
  rp          BIGINT NOT NULL DEFAULT 0,
  satiety     DOUBLE PRECISION NOT NULL DEFAULT 100,
  last_satiety_update TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Индекс для быстрого поиска по tg_id
CREATE INDEX idx_users_tg_id ON public.users (tg_id);

-- ============================================================
-- ТАБЛИЦА ТРАНЗАКЦИЙ (лог всех мутаций)
-- ============================================================
CREATE TABLE public.transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  honey_delta     DOUBLE PRECISION NOT NULL DEFAULT 0,
  amber_delta     BIGINT NOT NULL DEFAULT 0,
  rp_delta        BIGINT NOT NULL DEFAULT 0,
  satiety_delta   DOUBLE PRECISION NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_transactions_user_id ON public.transactions (user_id);
CREATE INDEX idx_transactions_idempotency ON public.transactions (idempotency_key);

-- ============================================================
-- RLS: пользователь читает только свою строку
-- ============================================================
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Анонимный / авторизованный пользователь читает только свою строку
-- Сопоставление через JWT claim raw_app_meta_data->tg_id
-- Но в нашем случае клиент НЕ ходит в Supabase напрямую —
-- все мутации через service_role. 
-- Для безопасности: SELECT только свою строку, никаких INSERT/UPDATE/DELETE.

CREATE POLICY "users_select_own"
  ON public.users
  FOR SELECT
  TO authenticated, anon
  USING (
    tg_id = COALESCE(
      (current_setting('request.jwt.claims', true)::json ->> 'tg_id')::BIGINT,
      0
    )
  );

-- Запрет любых мутаций для не-service_role
CREATE POLICY "users_no_insert"
  ON public.users FOR INSERT TO authenticated, anon
  WITH CHECK (false);

CREATE POLICY "users_no_update"
  ON public.users FOR UPDATE TO authenticated, anon
  USING (false) WITH CHECK (false);

CREATE POLICY "users_no_delete"
  ON public.users FOR DELETE TO authenticated, anon
  USING (false);

-- Транзакции: пользователь может читать свои, не может мутировать
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "transactions_select_own"
  ON public.transactions
  FOR SELECT
  TO authenticated, anon
  USING (
    user_id IN (
      SELECT id FROM public.users
      WHERE tg_id = COALESCE(
        (current_setting('request.jwt.claims', true)::json ->> 'tg_id')::BIGINT,
        0
      )
    )
  );

CREATE POLICY "transactions_no_insert"
  ON public.transactions FOR INSERT TO authenticated, anon
  WITH CHECK (false);

CREATE POLICY "transactions_no_update"
  ON public.transactions FOR UPDATE TO authenticated, anon
  USING (false) WITH CHECK (false);

CREATE POLICY "transactions_no_delete"
  ON public.transactions FOR DELETE TO authenticated, anon
  USING (false);