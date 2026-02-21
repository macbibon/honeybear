-- 00007_notifications_ads.sql
-- Push-notification fields + extended ad tracking per type

-- ── Notification fields ──────────────────────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS notifications_enabled   BOOLEAN      NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS last_notification_at    TIMESTAMPTZ  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS notifications_today      INT          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notifications_today_date DATE         NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS timezone_offset          INT          NOT NULL DEFAULT 0;

-- ── Per-type ad counters (beyond the existing ads_today / ads_today_date for feed) ──
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS ad_arena_today   INT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ad_daily_today   INT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ad_bonus_today   INT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ad_types_date    DATE NOT NULL DEFAULT CURRENT_DATE;

-- ── Index for notification cron queries ─────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_notifications
  ON public.users (notifications_enabled, notifications_today_date, last_notification_at)
  WHERE notifications_enabled = TRUE;
