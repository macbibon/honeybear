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

// ── Opponent names ─────────────────────────────────────────
const OPPONENT_NAMES = [
  "Гризли Макс","Бурый Джо","Панда Ли","Коала Сэм","Барибал Рик",
  "Топтыгин","Мишка Тед","Потапыч","Умка","Балу",
  "Винни","Паддингтон","Йоги","Гамми","Базз",
  "Клык","Рокки","Тайсон","Шатун","Берсерк",
  "Малыш Бу","Ворчун","Громила","Пухляш","Зефир",
  "Бисквит","Карамель","Трюфель","Ириска","Мармелад",
  "Буран","Вихрь","Гром","Молния","Шторм",
  "Кедр","Дуб","Клён","Берёза","Тайга",
  "Север","Айсберг","Полярис","Аврора","Космос",
  "Титан","Атлас","Зевс","Один","Тор",
];

const ENTRY_COST = 20;
const NUM_ROUNDS = 5;

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

    // Get user
    const { data: user, error: userErr } = await supabase
      .from("users").select("*").eq("tg_id", tgId).maybeSingle();
    if (userErr) throw userErr;
    if (!user) return json({ error: "user not found" }, 404);

    // Check balance
    if (user.honey < ENTRY_COST) {
      return json({ error: "Недостаточно мёда (нужно 20 🍯)" }, 400);
    }

    // Deduct entry fee
    const { error: deductErr } = await supabase
      .from("users")
      .update({ honey: user.honey - ENTRY_COST })
      .eq("id", user.id);
    if (deductErr) throw deductErr;

    // Generate rounds: each round has a green_zone_center (0.0 to 1.0)
    const rounds = [];
    for (let i = 0; i < NUM_ROUNDS; i++) {
      // Green zone center between 0.15 and 0.85 so it fits on the bar
      const center = 0.15 + Math.random() * 0.7;
      rounds.push({
        round: i + 1,
        green_center: Math.round(center * 1000) / 1000,
        green_half_width: 0.10, // ±10% = 20% total width
        yellow_half_width: 0.175, // ±17.5% = 35% total width
      });
    }

    // Generate opponent
    const oppName = OPPONENT_NAMES[Math.floor(Math.random() * OPPONENT_NAMES.length)];
    const playerRp = Math.max(10, user.rp || 0);
    const variance = 0.2;
    const oppRp = Math.max(10, Math.round(playerRp * (1 + (Math.random() * 2 - 1) * variance)));

    // Create arena
    const { data: arena, error: arenaErr } = await supabase
      .from("arenas")
      .insert({
        user_id: user.id,
        opponent_name: oppName,
        opponent_rp: oppRp,
        rounds_data: rounds,
        player_scores: [],
        opponent_scores: [],
        player_hp: 100,
        opponent_hp: 100,
        result: null,
      })
      .select("id, opponent_name, opponent_rp, rounds_data")
      .single();
    if (arenaErr) throw arenaErr;

    // Log transaction
    await supabase.from("transactions").insert({
      user_id: user.id,
      type: "arena_entry",
      honey_delta: -ENTRY_COST,
      idempotency_key: `arena_entry_${arena.id}`,
    });

    return json({
      arena_id: arena.id,
      opponent_name: arena.opponent_name,
      opponent_rp: arena.opponent_rp,
      rounds: arena.rounds_data,
      player_rp: playerRp,
      arena_streak: user.arena_streak || 0,
    });
  } catch (err: any) {
    console.error("enter-arena error:", err);
    const status = err.message?.includes("invalid") ? 403 : 500;
    return json({ error: err.message }, status);
  }
});