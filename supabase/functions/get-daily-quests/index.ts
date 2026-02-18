// supabase/functions/get-daily-quests/index.ts
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
async function validateInitData(initData: string): Promise<number> {
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
  const user = JSON.parse(raw);
  if (!user.id) throw new Error("missing user.id");
  return user.id;
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

// Quest pools
const EASY_QUESTS = [
  { type: "feed_bear", target: 1, name: "Покорми медведя", emoji: "🍽️" },
  { type: "tap_bear", target: 10, name: "Потыкай медведя 10 раз", emoji: "👆" },
  { type: "login", target: 1, name: "Зайди в игру", emoji: "📱" },
];

const MEDIUM_QUESTS = [
  { type: "play_arena", target: 2, name: "Сыграй 2 боя на арене", emoji: "⚔️" },
  { type: "win_arena", target: 1, name: "Победи на арене", emoji: "🏆" },
  { type: "watch_ad", target: 1, name: "Посмотри рекламу", emoji: "📺" },
];

const HARD_QUESTS = [
  { type: "win_streak_3", target: 1, name: "Набери серию из 3 побед", emoji: "🔥" },
  { type: "feed_3_times", target: 3, name: "Покорми медведя 3 раза", emoji: "🥘" },
  { type: "upgrade", target: 1, name: "Улучши берлогу", emoji: "🏗️" },
];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
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
    if (!initData) return json({ error: "missing initData" }, 401);
    const tgId = await validateInitData(initData);

    const { data: user, error: ue } = await supabase
      .from("users").select("id, login_streak, last_login_date").eq("tg_id", tgId).maybeSingle();
    if (ue) throw ue;
    if (!user) return json({ error: "user not found" }, 404);

    const today = new Date().toISOString().slice(0, 10);

    // Check if quests already exist for today
    let { data: dq, error: dqErr } = await supabase
      .from("daily_quests")
      .select("*")
      .eq("user_id", user.id)
      .eq("date", today)
      .maybeSingle();
    if (dqErr) throw dqErr;

    // Generate if not exist
    if (!dq) {
      const q1 = pickRandom(EASY_QUESTS);
      const q2 = pickRandom(MEDIUM_QUESTS);
      const q3 = pickRandom(HARD_QUESTS);

      const { data: newDq, error: insErr } = await supabase
        .from("daily_quests")
        .insert({
          user_id: user.id,
          date: today,
          quest_1_type: q1.type, quest_1_target: q1.target,
          quest_2_type: q2.type, quest_2_target: q2.target,
          quest_3_type: q3.type, quest_3_target: q3.target,
        })
        .select("*")
        .single();
      if (insErr) throw insErr;
      dq = newDq;

      // Auto-complete login quest if present
      if (q1.type === "login") {
        await supabase.from("daily_quests").update({
          quest_1_progress: 1, quest_1_done: true,
        }).eq("id", dq.id);
        dq.quest_1_progress = 1;
        dq.quest_1_done = true;
      }
    }

    // Build response with quest metadata
    const questMeta = (type: string) => {
      const all = [...EASY_QUESTS, ...MEDIUM_QUESTS, ...HARD_QUESTS];
      return all.find(q => q.type === type) || { name: type, emoji: "❓" };
    };

    const difficulty = (type: string): string => {
      if (EASY_QUESTS.some(q => q.type === type)) return "easy";
      if (MEDIUM_QUESTS.some(q => q.type === type)) return "medium";
      return "hard";
    };

    const rewards: Record<string, { honey: number; amber: number }> = {
      easy: { honey: 50, amber: 0 },
      medium: { honey: 100, amber: 2 },
      hard: { honey: 200, amber: 3 },
    };

    const quests = [];
    for (let i = 1; i <= 3; i++) {
      const type = dq[`quest_${i}_type`];
      const meta = questMeta(type);
      const diff = difficulty(type);
      quests.push({
        slot: i,
        type,
        name: meta.name,
        emoji: meta.emoji,
        difficulty: diff,
        progress: dq[`quest_${i}_progress`],
        target: dq[`quest_${i}_target`],
        done: dq[`quest_${i}_done`],
        claimed: dq[`quest_${i}_claimed`],
        reward: rewards[diff],
      });
    }

    return json({
      date: today,
      quests,
      all_done: quests.every(q => q.done),
      all_bonus_claimed: dq.all_bonus_claimed,
      all_bonus: { honey: 100, amber: 3 },
      login_streak: user.login_streak || 0,
      last_login_date: user.last_login_date,
    });
  } catch (err: any) {
    console.error("get-daily-quests error:", err);
    return json({ error: err.message }, 500);
  }
});