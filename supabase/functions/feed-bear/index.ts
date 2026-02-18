import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN = Deno.env.get("BOT_TOKEN")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ── Telegram auth ──────────────────────────────────────────
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

// ── Lazy tick (same as get-state) ──────────────────────────
const TICK_MS = 6 * 60 * 1000;
const HONEY_PER_HOUR = 60;

interface UserRow {
  id: string; tg_id: number; bear_name: string;
  honey: number; amber: number; rp: number;
  satiety: number; last_satiety_update: string;
  free_food_at: string; ads_today: number; ads_today_date: string;
  created_at: string;
}

function lazyTick(u: UserRow) {
  const now = Date.now();
  const last = new Date(u.last_satiety_update).getTime();
  const elapsed = Math.max(0, now - last);
  const ticks = Math.floor(elapsed / TICK_MS);
  const lost = Math.min(ticks, u.satiety);
  const newSat = Math.max(0, u.satiety - lost);
  const avg = (u.satiety + newSat) / 2;
  const hours = elapsed / 3_600_000;
  const earned = HONEY_PER_HOUR * (avg / 100) * hours;
  return { newSatiety: newSat, honeyEarned: earned, elapsed };
}

// ── Food config ────────────────────────────────────────────
interface FoodDef {
  satietyGain: number;
  honeyCost: number;
  checkLimit: (u: UserRow) => { ok: boolean; reason?: string };
}

const FOOD: Record<string, FoodDef> = {
  berries: {
    satietyGain: 15,
    honeyCost: 0,
    checkLimit(u) {
      const ready = new Date(u.free_food_at).getTime();
      if (Date.now() < ready) {
        const mins = Math.ceil((ready - Date.now()) / 60000);
        return { ok: false, reason: `Ягоды будут через ${mins} мин` };
      }
      return { ok: true };
    },
  },
  honey_food: {
    satietyGain: 25,
    honeyCost: 30,
    checkLimit() { return { ok: true }; },
  },
  fish: {
    satietyGain: 50,
    honeyCost: 80,
    checkLimit() { return { ok: true }; },
  },
  ad: {
    satietyGain: 30,
    honeyCost: 0,
    checkLimit(u) {
      const today = new Date().toISOString().slice(0, 10);
      const count = u.ads_today_date === today ? u.ads_today : 0;
      if (count >= 2) return { ok: false, reason: "Лимит рекламы на сегодня исчерпан" };
      return { ok: true };
    },
  },
};

// ── Response helper ────────────────────────────────────────
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function toState(u: UserRow) {
  return {
    bear_name: u.bear_name,
    honey: Math.floor(u.honey * 100) / 100,
    amber: u.amber,
    rp: u.rp,
    satiety: Math.floor(u.satiety * 100) / 100,
    last_satiety_update: u.last_satiety_update,
    free_food_at: u.free_food_at,
    ads_today: u.ads_today,
    ads_today_date: u.ads_today_date,
    created_at: u.created_at,
  };
}

// ── Handler ────────────────────────────────────────────────
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
    // Auth
    const auth = req.headers.get("Authorization") || "";
    const initData = auth.replace(/^Bearer\s+/i, "").trim();
    if (!initData) return json({ error: "missing initData" }, 401);
    const tgUser = await validateInitData(initData);

    // Body
    const body = await req.json().catch(() => ({}));
    const foodType = body.food_type as string;
    if (!foodType || !FOOD[foodType]) {
      return json({ error: "invalid food_type" }, 400);
    }
    const food = FOOD[foodType];

    // Get user
    const { data: user, error } = await supabase
      .from("users").select("*").eq("tg_id", tgUser.id).maybeSingle();
    if (error) throw error;
    if (!user) return json({ error: "user not found" }, 404);

    const u = user as UserRow;

    // Lazy tick first
    const tick = lazyTick(u);
    u.honey += tick.honeyEarned;
    u.satiety = tick.newSatiety;
    u.last_satiety_update = new Date().toISOString();

    // Reset ads counter if new day
    const today = new Date().toISOString().slice(0, 10);
    if (u.ads_today_date !== today) {
      u.ads_today = 0;
      u.ads_today_date = today;
    }

    // Check limits
    const limit = food.checkLimit(u);
    if (!limit.ok) return json({ error: limit.reason }, 429);

    // Check balance
    if (food.honeyCost > 0 && u.honey < food.honeyCost) {
      return json({ error: "Недостаточно мёда" }, 400);
    }

    // Apply
    u.honey -= food.honeyCost;
    u.satiety = Math.min(100, u.satiety + food.satietyGain);

    // Update limits
    if (foodType === "berries") {
      u.free_food_at = new Date(Date.now() + 4 * 3600_000).toISOString();
    }
    if (foodType === "ad") {
      u.ads_today += 1;
    }

    // Idempotency key
    const idemKey = `feed_${u.id}_${foodType}_${Date.now()}`;

    // Save
    const { error: updErr } = await supabase
      .from("users")
      .update({
        honey: u.honey,
        satiety: u.satiety,
        last_satiety_update: u.last_satiety_update,
        free_food_at: u.free_food_at,
        ads_today: u.ads_today,
        ads_today_date: u.ads_today_date,
      })
      .eq("id", u.id);
    if (updErr) throw updErr;

    // Log transaction
    await supabase.from("transactions").insert({
      user_id: u.id,
      type: `feed_${foodType}`,
      honey_delta: -food.honeyCost,
      satiety_delta: food.satietyGain,
      idempotency_key: idemKey,
    });

    return json({ success: true, state: toState(u) });
  } catch (err: any) {
    console.error("feed-bear error:", err);
    return json({ error: err.message || "internal error" }, 500);
  }
});