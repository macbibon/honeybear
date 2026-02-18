import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN = Deno.env.get("BOT_TOKEN")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function hmacSHA256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, data);
  return new Uint8Array(sig);
}

function hexEncode(buf: Uint8Array): string {
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface TelegramUser {
  id: number;
  first_name?: string;
}

async function validateInitData(initData: string): Promise<TelegramUser> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new Error("missing hash");

  params.delete("hash");
  const entries: string[] = [];
  params.forEach((value, key) => {
    entries.push(`${key}=${value}`);
  });
  entries.sort();
  const dataCheckString = entries.join("\n");

  const encoder = new TextEncoder();
  const secretKey = await hmacSHA256(
    encoder.encode("WebAppData"),
    encoder.encode(BOT_TOKEN)
  );

  const computedHash = hexEncode(
    await hmacSHA256(secretKey, encoder.encode(dataCheckString))
  );

  if (computedHash !== hash) {
    throw new Error("invalid initData signature");
  }

  const userRaw = params.get("user");
  if (!userRaw) throw new Error("missing user in initData");
  const user: TelegramUser = JSON.parse(userRaw);
  if (!user.id) throw new Error("missing user.id");

  return user;
}

interface UserRow {
  id: string;
  tg_id: number;
  bear_name: string;
  honey: number;
  amber: number;
  rp: number;
  satiety: number;
  last_satiety_update: string;
  created_at: string;
}

const SATIETY_INTERVAL_MS = 6 * 60 * 1000;
const BASE_HONEY_PER_HOUR = 60;

function computeLazyUpdate(user: UserRow) {
  const now = Date.now();
  const lastUpdate = new Date(user.last_satiety_update).getTime();
  const elapsedMs = Math.max(0, now - lastUpdate);

  const ticks = Math.floor(elapsedMs / SATIETY_INTERVAL_MS);
  const oldSatiety = user.satiety;
  const satietyLost = Math.min(ticks, oldSatiety);
  const newSatiety = Math.max(0, oldSatiety - satietyLost);
  const avgSatiety = (oldSatiety + newSatiety) / 2;
  const elapsedHours = elapsedMs / (1000 * 60 * 60);
  const honeyEarned = BASE_HONEY_PER_HOUR * (avgSatiety / 100) * elapsedHours;

  return { newSatiety, honeyEarned, elapsedMs };
}

function toGameState(u: UserRow) {
  return {
    bear_name: u.bear_name,
    honey: Math.floor(u.honey * 100) / 100,
    amber: u.amber,
    rp: u.rp,
    satiety: Math.floor(u.satiety * 100) / 100,
    last_satiety_update: u.last_satiety_update,
    free_food_at: u.free_food_at || '1970-01-01T00:00:00Z',
    ads_today: u.ads_today || 0,
    ads_today_date: u.ads_today_date || new Date().toISOString().slice(0,10),
    created_at: u.created_at,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
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
    const authHeader = req.headers.get("Authorization") || "";
    const initData = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!initData) {
      return jsonResponse({ error: "missing initData" }, 401);
    }

    const tgUser = await validateInitData(initData);
    const tgId = tgUser.id;

    let { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("tg_id", tgId)
      .maybeSingle();

    if (error) throw error;

    if (!user) {
      const bearName = tgUser.first_name
        ? `${tgUser.first_name}'s Bear`
        : "Bear";

      const { data: newUser, error: insertErr } = await supabase
        .from("users")
        .insert({
          tg_id: tgId,
          bear_name: bearName,
          honey: 200,
          amber: 0,
          rp: 0,
          satiety: 100,
          last_satiety_update: new Date().toISOString(),
        })
        .select("*")
        .single();

      if (insertErr) throw insertErr;
      user = newUser;

      await supabase.from("transactions").insert({
        user_id: user.id,
        type: "registration",
        honey_delta: 200,
        satiety_delta: 100,
        idempotency_key: `reg_${tgId}`,
      });

      return jsonResponse(toGameState(user as UserRow));
    }

    const typed = user as UserRow;
    const { newSatiety, honeyEarned, elapsedMs } = computeLazyUpdate(typed);

    if (elapsedMs > 1000) {
      const newHoney = typed.honey + honeyEarned;
      const now = new Date().toISOString();

      const { error: updateErr } = await supabase
        .from("users")
        .update({
          honey: newHoney,
          satiety: newSatiety,
          last_satiety_update: now,
        })
        .eq("id", typed.id);

      if (updateErr) throw updateErr;

      if (honeyEarned > 0.01 || newSatiety !== typed.satiety) {
        await supabase.from("transactions").insert({
          user_id: typed.id,
          type: "lazy_tick",
          honey_delta: honeyEarned,
          satiety_delta: newSatiety - typed.satiety,
        });
      }

      typed.honey = newHoney;
      typed.satiety = newSatiety;
      typed.last_satiety_update = now;
    }

    return jsonResponse(toGameState(typed));
  } catch (err: any) {
    console.error("get-state error:", err);
    const status = err.message?.includes("invalid") ? 403 : 500;
    return jsonResponse({ error: err.message || "internal error" }, status);
  }
});