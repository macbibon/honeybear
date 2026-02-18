// supabase/functions/get-state/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN = Deno.env.get("BOT_TOKEN")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function hmacSHA256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
function hex(buf: Uint8Array): string {
  return [...buf].map(b => b.toString(16).padStart(2, "0")).join("");
}

interface TgUser { id: number; first_name?: string }

async function validateInitData(initData: string): Promise<TgUser> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new Error("missing hash");
  params.delete("hash");
  const entries: string[] = [];
  params.forEach((v, k) => entries.push(`${k}=${v}`));
  entries.sort();
  const enc = new TextEncoder();
  const secret = await hmacSHA256(enc.encode("WebAppData"), enc.encode(BOT_TOKEN));
  const computed = hex(await hmacSHA256(secret, enc.encode(entries.join("\n"))));
  if (computed !== hash) throw new Error("invalid signature");
  const raw = params.get("user");
  if (!raw) throw new Error("missing user");
  const user: TgUser = JSON.parse(raw);
  if (!user.id) throw new Error("missing user.id");
  return user;
}

const DEN_MULT: Record<number, number> = { 1: 1.0, 2: 1.3, 3: 1.7, 4: 2.2, 5: 3.0 };
const BED_INTERVAL: Record<number, number> = { 1: 6, 2: 7, 3: 8 };
const BASE_HONEY_PER_HOUR = 60;

// Streak rewards: day → { honey, amber }
const STREAK_REWARDS: Record<number, { honey: number; amber: number }> = {
  1:  { honey: 50,   amber: 0 },
  2:  { honey: 75,   amber: 0 },
  3:  { honey: 100,  amber: 2 },
  5:  { honey: 200,  amber: 5 },
  7:  { honey: 500,  amber: 10 },
  14: { honey: 1000, amber: 20 },
  30: { honey: 2000, amber: 50 },
};

function getStreakReward(day: number): { honey: number; amber: number } {
  // Find the exact milestone or give base reward
  if (STREAK_REWARDS[day]) return STREAK_REWARDS[day];
  // Between milestones: base 50 honey
  return { honey: 50, amber: 0 };
}

function computeLazyUpdate(u: any) {
  const now = Date.now();
  const last = new Date(u.last_satiety_update).getTime();
  const elapsedMs = Math.max(0, now - last);
  const bedLevel = u.bed_level || 1;
  const tickMs = (BED_INTERVAL[bedLevel] || 6) * 60 * 1000;
  const ticks = Math.floor(elapsedMs / tickMs);
  const oldSat = u.satiety;
  const lost = Math.min(ticks, oldSat);
  const newSat = Math.max(0, oldSat - lost);
  const avgSat = (oldSat + newSat) / 2;
  const denLevel = u.den_level || 1;
  const denMult = DEN_MULT[denLevel] || 1.0;
  const hours = elapsedMs / 3_600_000;
  const honeyEarned = BASE_HONEY_PER_HOUR * denMult * (avgSat / 100) * hours;
  return { newSatiety: newSat, honeyEarned, elapsedMs };
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
    ads_today_date: u.ads_today_date || new Date().toISOString().slice(0, 10),
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

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dateStr(d);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    });
  }

  try {
    const auth = req.headers.get("Authorization") || "";
    const initData = auth.replace(/^Bearer\s+/i, "").trim();
    if (!initData) return jsonResp({ error: "missing initData" }, 401);

    const tgUser = await validateInitData(initData);
    const tgId = tgUser.id;

    let { data: user, error } = await supabase
      .from("users").select("*").eq("tg_id", tgId).maybeSingle();
    if (error) throw error;

    // ── New user registration ──
    if (!user) {
      const bearName = tgUser.first_name ? `${tgUser.first_name}'s Bear` : "Bear";
      const today = dateStr(new Date());
      const { data: newUser, error: insErr } = await supabase
        .from("users")
        .insert({
          tg_id: tgId, bear_name: bearName,
          honey: 250, amber: 0, rp: 0, satiety: 100,
          last_satiety_update: new Date().toISOString(),
          login_streak: 1, last_login_date: today,
        })
        .select("*").single();
      if (insErr) throw insErr;
      user = newUser;

      await supabase.from("transactions").insert({
        user_id: user.id, type: "registration",
        honey_delta: 250, satiety_delta: 100,
        idempotency_key: `reg_${tgId}`,
      });

      return jsonResp({
        ...toState(user),
        login_reward: { honey: 50, amber: 0, streak: 1, is_new: true },
      });
    }

    // ── Lazy tick ──
    const { newSatiety, honeyEarned, elapsedMs } = computeLazyUpdate(user);

    if (elapsedMs > 1000) {
      user.honey += honeyEarned;
      user.satiety = newSatiety;
      user.last_satiety_update = new Date().toISOString();
    }

    // ── Login streak ──
    const today = dateStr(new Date());
    const lastLogin = user.last_login_date;
    let loginReward = null;

    if (lastLogin !== today) {
      // Calculate new streak
      let newStreak: number;
      if (lastLogin === yesterday()) {
        newStreak = (user.login_streak || 0) + 1;
      } else {
        newStreak = 1;
      }

      const reward = getStreakReward(newStreak);
      user.honey += reward.honey;
      user.amber = (user.amber || 0) + reward.amber;
      user.login_streak = newStreak;
      user.last_login_date = today;

      loginReward = {
        honey: reward.honey,
        amber: reward.amber,
        streak: newStreak,
        is_new: false,
      };

      // Log streak reward
      await supabase.from("transactions").insert({
        user_id: user.id,
        type: `login_streak_day_${newStreak}`,
        honey_delta: reward.honey,
        idempotency_key: `login_${user.id}_${today}`,
      });

      // Also track login quest progress
      await updateQuestProgress(user.id, today, "login", 1);
    }

    // ── Save user ──
    await supabase.from("users").update({
      honey: user.honey,
      amber: user.amber,
      satiety: user.satiety,
      last_satiety_update: user.last_satiety_update,
      login_streak: user.login_streak,
      last_login_date: user.last_login_date,
    }).eq("id", user.id);

    const resp: any = toState(user);
    if (loginReward) resp.login_reward = loginReward;

    return jsonResp(resp);
  } catch (err: any) {
    console.error("get-state error:", err);
    return jsonResp({ error: err.message }, 500);
  }
});

// Helper: update quest progress (best-effort, no throw)
async function updateQuestProgress(userId: string, date: string, questType: string, increment: number) {
  try {
    const { data: dq } = await supabase
      .from("daily_quests")
      .select("*")
      .eq("user_id", userId)
      .eq("date", date)
      .maybeSingle();
    if (!dq) return;

    for (let i = 1; i <= 3; i++) {
      if (dq[`quest_${i}_type`] === questType && !dq[`quest_${i}_done`]) {
        const newProg = Math.min(dq[`quest_${i}_progress`] + increment, dq[`quest_${i}_target`]);
        const done = newProg >= dq[`quest_${i}_target`];
        await supabase.from("daily_quests").update({
          [`quest_${i}_progress`]: newProg,
          [`quest_${i}_done`]: done,
        }).eq("id", dq.id);
        break;
      }
    }
  } catch (e) {
    console.error("updateQuestProgress error:", e);
  }
}