// supabase/functions/check-notifications/index.ts
// Called by Supabase cron every 30 minutes.
// Iterates active users and sends Telegram push-notifications via Bot API.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN                 = Deno.env.get("BOT_TOKEN")!;
const MINI_APP_URL              = Deno.env.get("MINI_APP_URL") || "https://t.me/HoneyBearBot/app";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────
function utcHour(timezoneOffset: number): number {
  const nowUtc = new Date();
  // timezoneOffset is minutes ahead of UTC (same sign as JS getTimezoneOffset inverted)
  const localMs = nowUtc.getTime() + timezoneOffset * 60_000;
  return new Date(localMs).getUTCHours();
}

function todayLocal(timezoneOffset: number): string {
  const localMs = Date.now() + timezoneOffset * 60_000;
  return new Date(localMs).toISOString().slice(0, 10);
}

function hoursSince(ts: string | null): number {
  if (!ts) return Infinity;
  return (Date.now() - new Date(ts).getTime()) / 3_600_000;
}

async function sendMessage(
  tgId: number,
  text: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: tgId,
          text,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              {
                text: "🐻 Открыть игру",
                web_app: { url: MINI_APP_URL },
              },
            ]],
          },
        }),
      },
    );
    const json = await res.json();
    return json.ok === true;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────
// Main cron handler
// ──────────────────────────────────────────────────────────────────
serve(async (req) => {
  // Allow cron/internal calls (no auth for cron; protect via secret if needed)
  const secret = Deno.env.get("CRON_SECRET");
  if (secret) {
    const authHeader = req.headers.get("Authorization") || "";
    if (authHeader !== `Bearer ${secret}`) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const todayUtc = nowIso.slice(0, 10);

  // ── Check if season ends in ~2 days ──
  const { data: activeSeason } = await supabase
    .from("seasons").select("id, number, ends_at").eq("status", "active").maybeSingle();
  const seasonEndsIn2Days = activeSeason
    && Math.abs((new Date(activeSeason.ends_at).getTime() - now.getTime()) / 86_400_000 - 2) < 0.5;

  // Fetch all notification-enabled users who exist and have tg_id
  // We process in batches of 500 to avoid memory issues
  const PAGE = 500;
  let offset = 0;
  let processed = 0;
  let sent = 0;

  while (true) {
    const { data: users, error } = await supabase
      .from("users")
      .select(
        "id, tg_id, bear_name, honey, satiety, arena_streak, season_rp, " +
        "notifications_enabled, last_notification_at, notifications_today, " +
        "notifications_today_date, timezone_offset, last_login_date, " +
        "login_streak, created_at",
      )
      .eq("notifications_enabled", true)
      .not("tg_id", "is", null)
      .range(offset, offset + PAGE - 1);

    if (error) {
      console.error("fetch users error:", error);
      break;
    }
    if (!users || users.length === 0) break;

    for (const u of users) {
      processed++;
      const tz = u.timezone_offset ?? 0; // minutes
      const localHour = utcHour(tz);
      const localToday = todayLocal(tz);

      // ── Quiet hours: 23:00–09:00 local ──
      if (localHour >= 23 || localHour < 9) continue;

      // ── Max 3 notifications per day ──
      const notifDate = u.notifications_today_date;
      let countToday = notifDate === localToday ? (u.notifications_today ?? 0) : 0;
      if (countToday >= 3) continue;

      // ── If not active for 7+ days → final message then stop ──
      const daysSinceLogin =
        u.last_login_date
          ? (Date.now() - new Date(u.last_login_date).getTime()) / 86_400_000
          : Infinity;

      if (daysSinceLogin >= 7) {
        // Already handled if we sent before and they still haven't come back
        // Send one final "we miss you" then disable notifications
        const lastNotif = u.last_notification_at;
        const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
        if (!lastNotif || lastNotif < sevenDaysAgo) {
          const ok = await sendMessage(
            u.tg_id,
            `🐻 ${u.bear_name} скучает по тебе уже 7 дней... Возвращайся! 🍯`,
          );
          if (ok) {
            await supabase.from("users").update({
              notifications_enabled: false,
              last_notification_at: nowIso,
            }).eq("id", u.id);
            sent++;
          }
        }
        continue;
      }

      // ── Determine which notification to send (priority order) ──
      let message: string | null = null;
      const hoursSinceNotif = hoursSince(u.last_notification_at);

      // 1. Hunger (satiety < 25, not notified in 4+ h)
      if (!message && u.satiety < 25 && hoursSinceNotif >= 4) {
        message = `😢 ${u.bear_name} проголодался... Сытость: ${Math.round(u.satiety)}%`;
      }

      // 2. Honey accumulated (honey > 1000, not logged in 8+ h)
      if (!message && u.honey > 1000 && hoursSince(u.last_login_date + "T00:00:00Z") >= 8) {
        // Use last_notification_at for 8h gate too
        if (hoursSinceNotif >= 8) {
          message = `💰 У ${u.bear_name} накопилось ${Math.round(u.honey)} мёда!`;
        }
      }

      // 3. Arena: hasn't played today (after 14:00 local)
      if (!message && localHour >= 14) {
        const lastPlay = u.last_login_date; // rough proxy; ideally last_arena_date
        if (lastPlay !== localToday && hoursSinceNotif >= 4) {
          message = `⚔️ ${u.bear_name} готов к бою! Серия побед: ${u.arena_streak}`;
        }
      }

      // 4. Streak risk (streak > 3, not logged in today, after 18:00)
      if (!message && localHour >= 18 && u.login_streak > 3) {
        if (u.last_login_date !== localToday && hoursSinceNotif >= 4) {
          message = `🔥 Не потеряй серию ${u.login_streak} дней!`;
        }
      }

      // 5. Season end (check season end within 2 days) — fetched separately
      // Skipped here to avoid extra query per user; handled by rotate-season

      // 5. Season ends in 2 days (once per day gate via hoursSinceNotif ≥ 20)
      if (!message && seasonEndsIn2Days && localHour >= 12 && hoursSinceNotif >= 20) {
        message = `🏆 До конца сезона 2 дня! Рейтинг: ${u.season_rp ?? u.rp ?? 0} RP — успей занять место!`;
      }

      // 6. Referral notifications are sent immediately by apply-referral function

      if (!message) continue;

      const ok = await sendMessage(u.tg_id, message);
      if (ok) {
        sent++;
        await supabase.from("users").update({
          last_notification_at: nowIso,
          notifications_today: countToday + 1,
          notifications_today_date: localToday,
        }).eq("id", u.id);
      }
    }

    if (users.length < PAGE) break;
    offset += PAGE;
  }

  return new Response(
    JSON.stringify({ ok: true, processed, sent }),
    { headers: { "Content-Type": "application/json" } },
  );
});
