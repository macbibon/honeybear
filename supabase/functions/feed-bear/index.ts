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

const FEEDER_MULT: Record<number, number> = { 1: 1.0, 2: 1.3, 3: 1.6 };
const BED_INTERVAL: Record<number, number> = { 1: 6, 2: 7, 3: 8 };
const DEN_MULT: Record<number, number> = { 1: 1.0, 2: 1.3, 3: 1.7, 4: 2.2, 5: 3.0 };

interface FoodDef {
  baseSatiety: number;
  honeyCost: number;
  checkLimit: (u: any) => { ok: boolean; reason?: string };
}

const FOOD: Record<string, FoodDef> = {
  berries: {
    baseSatiety: 15, honeyCost: 0,
    checkLimit(u) {
      const ready = new Date(u.free_food_at || 0).getTime();
      if (Date.now() < ready) {
        const mins = Math.ceil((ready - Date.now()) / 60000);
        return { ok: false, reason: `Ягоды через ${mins} мин` };
      }
      return { ok: true };
    },
  },
  honey_food: {
    baseSatiety: 25, honeyCost: 30,
    checkLimit() { return { ok: true }; },
  },
  fish: {
    baseSatiety: 50, honeyCost: 80,
    checkLimit() { return { ok: true }; },
  },
  ad: {
    baseSatiety: 30, honeyCost: 0,
    checkLimit(u) {
      const today = new Date().toISOString().slice(0, 10);
      const count = u.ads_today_date === today ? u.ads_today : 0;
      if (count >= 2) return { ok: false, reason: "Лимит рекламы исчерпан" };
      return { ok: true };
    },
  },
};

function toState(u: any) {
  return {
    bear_name: u.bear_name,
    honey: Math.floor(u.honey * 100) / 100,
    amber: u.amber, rp: u.rp,
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
    created_at: u.created_at,
  };
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

    const body = await req.json().catch(() => ({}));
    const foodType = body.food_type as string;
    if (!foodType || !FOOD[foodType]) return json({ error: "invalid food_type" }, 400);
    const food = FOOD[foodType];

    const { data: user, error } = await supabase
      .from("users").select("*").eq("tg_id", tgId).maybeSingle();
    if (error) throw error;
    if (!user) return json({ error: "user not found" }, 404);

    // Lazy tick
    const bedLevel = user.bed_level || 1;
    const tickMs = (BED_INTERVAL[bedLevel] || 6) * 60 * 1000;
    const now = Date.now();
    const last = new Date(user.last_satiety_update).getTime();
    const elapsed = Math.max(0, now - last);
    const ticks = Math.floor(elapsed / tickMs);
    const lost = Math.min(ticks, user.satiety);
    user.satiety = Math.max(0, user.satiety - lost);

    const denMult = DEN_MULT[user.den_level || 1] || 1.0;
    const avgSat = ((user.satiety + lost) + user.satiety) / 2;
    const hours = elapsed / 3_600_000;
    user.honey += 60 * denMult * (avgSat / 100) * hours;
    user.last_satiety_update = new Date().toISOString();

    // Reset ads
    const today = new Date().toISOString().slice(0, 10);
    if (user.ads_today_date !== today) { user.ads_today = 0; user.ads_today_date = today; }

    // Check limits
    const limit = food.checkLimit(user);
    if (!limit.ok) return json({ error: limit.reason }, 429);

    if (food.honeyCost > 0 && user.honey < food.honeyCost) {
      return json({ error: "Недостаточно мёда" }, 400);
    }

    // Apply with feeder multiplier
    const feederMult = FEEDER_MULT[user.feeder_level || 1] || 1.0;
    const satGain = Math.round(food.baseSatiety * feederMult);

    user.honey -= food.honeyCost;
    user.satiety = Math.min(100, user.satiety + satGain);

    if (foodType === "berries") {
      user.free_food_at = new Date(Date.now() + 4 * 3600_000).toISOString();
    }
    if (foodType === "ad") { user.ads_today += 1; }

    await supabase.from("users").update({
      honey: user.honey, satiety: user.satiety,
      last_satiety_update: user.last_satiety_update,
      free_food_at: user.free_food_at,
      ads_today: user.ads_today, ads_today_date: user.ads_today_date,
    }).eq("id", user.id);

    await supabase.from("transactions").insert({
      user_id: user.id, type: `feed_${foodType}`,
      honey_delta: -food.honeyCost, satiety_delta: satGain,
      idempotency_key: `feed_${user.id}_${foodType}_${Date.now()}`,
    });

    return json({ success: true, state: toState(user) });
  } catch (err: any) {
    console.error("feed-bear error:", err);
    return json({ error: err.message }, 500);
  }
});