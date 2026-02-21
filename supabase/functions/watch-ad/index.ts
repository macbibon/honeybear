// supabase/functions/watch-ad/index.ts
// Records a rewarded-ad view and grants the corresponding reward.
//
// Supported ad_type values:
//   "feed"        – +30 satiety (limit 2/day, same as food_type=ad in feed-bear)
//   "arena_double"– doubles honey reward of a finished arena battle (limit 3/day)
//   "daily_double"– grants another copy of today's login-streak reward (limit 1/day)
//   "bonus_honey" – awards 2 h of passive honey income (limit 2/day)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { validateInitData, json, cors } from "../_shared/tg.ts";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const DEN_MULT: Record<number, number>  = { 1: 1.0, 2: 1.3, 3: 1.7, 4: 2.2, 5: 3.0 };
const BED_INTERVAL: Record<number, number> = { 1: 6, 2: 7, 3: 8 };
const FEEDER_MULT: Record<number, number>  = { 1: 1.0, 2: 1.3, 3: 1.6 };

const STREAK_REWARDS: Record<number, { honey: number; amber: number }> = {
  1:  { honey: 50,   amber: 0  },
  2:  { honey: 75,   amber: 0  },
  3:  { honey: 100,  amber: 2  },
  5:  { honey: 200,  amber: 5  },
  7:  { honey: 500,  amber: 10 },
  14: { honey: 1000, amber: 20 },
  30: { honey: 2000, amber: 50 },
};
function streakReward(day: number) {
  return STREAK_REWARDS[day] ?? { honey: 50, amber: 0 };
}

function toState(u: any) {
  return {
    bear_name: u.bear_name,
    honey: Math.floor(u.honey * 100) / 100,
    amber: u.amber,
    rp: u.rp,
    satiety: Math.floor(u.satiety * 100) / 100,
    last_satiety_update: u.last_satiety_update,
    free_food_at: u.free_food_at || "1970-01-01T00:00:00Z",
    ads_today: u.ads_today || 0,
    ads_today_date: u.ads_today_date,
    ad_arena_today: u.ad_arena_today || 0,
    ad_daily_today: u.ad_daily_today || 0,
    ad_bonus_today: u.ad_bonus_today || 0,
    ad_types_date: u.ad_types_date,
    arena_streak: u.arena_streak || 0,
    den_level: u.den_level || 1,
    feeder_level: u.feeder_level || 1,
    training_level: u.training_level || 1,
    bed_level: u.bed_level || 1,
    login_streak: u.login_streak || 0,
    last_login_date: u.last_login_date,
    created_at: u.created_at,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return cors();

  try {
    const auth = req.headers.get("Authorization") || "";
    const initData = auth.replace(/^Bearer\s+/i, "").trim();
    if (!initData) return json({ error: "missing initData" }, 401);

    const tgUser = await validateInitData(initData);
    const tgId = tgUser.id;

    const body = await req.json().catch(() => ({}));
    const adType = body.ad_type as string;
    const arenaId = body.arena_id as string | undefined;

    const validTypes = ["feed", "arena_double", "daily_double", "bonus_honey"];
    if (!validTypes.includes(adType)) {
      return json({ error: "invalid ad_type" }, 400);
    }

    // Load user
    const { data: user, error: userErr } = await supabase
      .from("users").select("*").eq("tg_id", tgId).maybeSingle();
    if (userErr) throw userErr;
    if (!user) return json({ error: "user not found" }, 404);

    const today = new Date().toISOString().slice(0, 10);

    // ── Reset per-type counters if new day ──
    if (user.ad_types_date !== today) {
      user.ad_arena_today = 0;
      user.ad_daily_today = 0;
      user.ad_bonus_today = 0;
      user.ad_types_date  = today;
    }
    if (user.ads_today_date !== today) {
      user.ads_today      = 0;
      user.ads_today_date = today;
    }

    // ── Apply lazy tick so honey is current ──
    const bedLevel = user.bed_level || 1;
    const tickMs   = (BED_INTERVAL[bedLevel] || 6) * 60 * 1000;
    const now      = Date.now();
    const last     = new Date(user.last_satiety_update).getTime();
    const elapsed  = Math.max(0, now - last);
    const ticks    = Math.floor(elapsed / tickMs);
    const lost     = Math.min(ticks, user.satiety);
    user.satiety   = Math.max(0, user.satiety - lost);
    const denMult  = DEN_MULT[user.den_level || 1] || 1.0;
    const avgSat   = ((user.satiety + lost) + user.satiety) / 2;
    const hours    = elapsed / 3_600_000;
    user.honey    += 60 * denMult * (avgSat / 100) * hours;
    user.last_satiety_update = new Date().toISOString();

    // ──────────────────────────────────────────────────────────────
    // Process reward by type
    // ──────────────────────────────────────────────────────────────
    let rewardDescription = "";
    let honeyGained = 0;
    let amberGained = 0;
    let satGained   = 0;

    if (adType === "feed") {
      // Limit: 2/day
      if ((user.ads_today || 0) >= 2) {
        return json({ error: "Лимит рекламы кормления исчерпан (2/день)" }, 429);
      }
      const feederMult = FEEDER_MULT[user.feeder_level || 1] || 1.0;
      satGained = Math.round(30 * feederMult);
      user.satiety = Math.min(100, user.satiety + satGained);
      user.ads_today = (user.ads_today || 0) + 1;
      rewardDescription = `+${satGained} сытости`;

    } else if (adType === "arena_double") {
      // Limit: 3/day
      if ((user.ad_arena_today || 0) >= 3) {
        return json({ error: "Лимит удвоения арены исчерпан (3/день)" }, 429);
      }
      if (!arenaId) return json({ error: "arena_id required" }, 400);

      // Load the finished arena
      const { data: arena, error: arenaErr } = await supabase
        .from("arenas").select("*").eq("id", arenaId).eq("user_id", user.id).maybeSingle();
      if (arenaErr) throw arenaErr;
      if (!arena) return json({ error: "arena not found" }, 404);
      if (!arena.result) return json({ error: "arena not finished" }, 400);

      // Grant equal to original honey_delta (doubling it)
      honeyGained = Math.max(0, arena.honey_delta);
      user.honey += honeyGained;
      user.ad_arena_today = (user.ad_arena_today || 0) + 1;
      rewardDescription = `+${Math.round(honeyGained)} 🍯`;

    } else if (adType === "daily_double") {
      // Limit: 1/day
      if ((user.ad_daily_today || 0) >= 1) {
        return json({ error: "Удвоение дейли-бонуса уже использовано сегодня" }, 429);
      }
      const reward = streakReward(user.login_streak || 1);
      honeyGained = reward.honey;
      amberGained = reward.amber;
      user.honey += honeyGained;
      user.amber = (user.amber || 0) + amberGained;
      user.ad_daily_today = (user.ad_daily_today || 0) + 1;
      rewardDescription = `+${honeyGained} 🍯` + (amberGained > 0 ? ` +${amberGained} 💎` : "");

    } else if (adType === "bonus_honey") {
      // Limit: 2/day — awards 2 h of passive income at current satiety
      if ((user.ad_bonus_today || 0) >= 2) {
        return json({ error: "Лимит бонусного мёда исчерпан (2/день)" }, 429);
      }
      const rate = 60 * denMult * (user.satiety / 100); // honey/h
      honeyGained = rate * 2; // 2 hours
      user.honey += honeyGained;
      user.ad_bonus_today = (user.ad_bonus_today || 0) + 1;
      rewardDescription = `+${Math.round(honeyGained)} 🍯 (2 ч дохода)`;
    }

    // ── Persist ──
    const { error: updErr } = await supabase.from("users").update({
      honey:               user.honey,
      amber:               user.amber,
      satiety:             user.satiety,
      last_satiety_update: user.last_satiety_update,
      ads_today:           user.ads_today,
      ads_today_date:      user.ads_today_date,
      ad_arena_today:      user.ad_arena_today,
      ad_daily_today:      user.ad_daily_today,
      ad_bonus_today:      user.ad_bonus_today,
      ad_types_date:       user.ad_types_date,
    }).eq("id", user.id);
    if (updErr) throw updErr;

    // ── Log transaction ──
    await supabase.from("transactions").insert({
      user_id: user.id,
      type: `ad_${adType}`,
      honey_delta:  honeyGained > 0 ? honeyGained : undefined,
      satiety_delta: satGained  > 0 ? satGained  : undefined,
      idempotency_key: `ad_${adType}_${user.id}_${now}`,
    }).then(() => {}); // best-effort

    return json({
      success: true,
      reward: { honey: honeyGained, amber: amberGained, satiety: satGained, description: rewardDescription },
      state: toState(user),
    });
  } catch (err: any) {
    console.error("watch-ad error:", err);
    return json({ error: err.message }, 500);
  }
});
