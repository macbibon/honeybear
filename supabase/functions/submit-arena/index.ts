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

const TRAINING_BONUS: Record<number, number> = { 1: 0, 2: 3, 3: 6 };

function seededRandom(seed: string, index: number): number {
  let hash = 0;
  const str = seed + "_" + index;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash % 1000) / 1000;
}

function calcDamage(pos: number, gc: number, ghw: number, yhw: number, bonus: number): { damage: number; zone: string } {
  const dist = Math.abs(pos - gc);
  let base: number;
  let zone: string;
  if (dist <= ghw) { base = 30; zone = "green"; }
  else if (dist <= yhw) { base = 15; zone = "yellow"; }
  else { base = 5; zone = "red"; }
  return { damage: base + bonus, zone };
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
    const arenaId = body.arena_id;
    const hits = body.hits as Array<{ round: number; cursor_pos: number }>;
    if (!arenaId || !hits || !Array.isArray(hits)) return json({ error: "invalid body" }, 400);

    const { data: user, error: ue } = await supabase
      .from("users").select("*").eq("tg_id", tgId).maybeSingle();
    if (ue) throw ue;
    if (!user) return json({ error: "user not found" }, 404);

    const { data: arena, error: ae } = await supabase
      .from("arenas").select("*").eq("id", arenaId).maybeSingle();
    if (ae) throw ae;
    if (!arena) return json({ error: "arena not found" }, 404);
    if (arena.user_id !== user.id) return json({ error: "not your arena" }, 403);
    if (arena.result !== null) return json({ error: "already completed" }, 400);

    const rounds = arena.rounds_data as any[];
    const trainingBonus = TRAINING_BONUS[user.training_level || 1] || 0;

    let pHP = 100, oHP = 100;
    const pScores: any[] = [], oScores: any[] = [];

    const oppRp = arena.opponent_rp;
    const botAcc = Math.min(0.70, 0.40 + (oppRp / 2000) * 0.30);

    for (let i = 0; i < rounds.length; i++) {
      const r = rounds[i];
      const hit = hits.find((h: any) => h.round === r.round);

      if (hit && oHP > 0 && pHP > 0) {
        const pos = Math.max(0, Math.min(1, hit.cursor_pos));
        const res = calcDamage(pos, r.green_center, r.green_half_width, r.yellow_half_width, trainingBonus);
        oHP = Math.max(0, oHP - res.damage);
        pScores.push({ round: r.round, cursor_pos: pos, damage: res.damage, zone: res.zone });
      }

      if (pHP > 0 && oHP > 0) {
        const rng = seededRandom(arenaId, i);
        let bd: number, bz: string;
        if (rng < botAcc * 0.6) { bd = 30; bz = "green"; }
        else if (rng < botAcc) { bd = 15; bz = "yellow"; }
        else { bd = 5; bz = "red"; }
        pHP = Math.max(0, pHP - bd);
        oScores.push({ round: r.round, damage: bd, zone: bz });
      }

      if (pHP <= 0 || oHP <= 0) break;
    }

    let result: string;
    if (oHP <= 0 && pHP > 0) result = "win";
    else if (pHP <= 0 && oHP > 0) result = "loss";
    else if (pHP <= 0 && oHP <= 0) {
      const pt = pScores.reduce((s: number, x: any) => s + x.damage, 0);
      const ot = oScores.reduce((s: number, x: any) => s + x.damage, 0);
      result = pt >= ot ? "win" : "loss";
    } else {
      result = oHP <= pHP ? "win" : "loss";
    }

    let honeyReward: number, rpReward: number, newStreak: number, streakBonus = 0;
    const curStreak = user.arena_streak || 0;

    if (result === "win") {
      honeyReward = 50; rpReward = 15; newStreak = curStreak + 1;
      const mult = Math.floor(newStreak / 3);
      if (mult > 0) { streakBonus = honeyReward * 0.20 * mult; honeyReward += streakBonus; }
    } else {
      honeyReward = 5; rpReward = 2; newStreak = 0;
    }

    await supabase.from("arenas").update({
      player_scores: pScores, opponent_scores: oScores,
      player_hp: pHP, opponent_hp: oHP, result,
      honey_delta: honeyReward, rp_delta: rpReward, streak_bonus: streakBonus,
    }).eq("id", arenaId);

    await supabase.from("users").update({
      honey: user.honey + honeyReward,
      rp: (user.rp || 0) + rpReward,
      arena_streak: newStreak,
    }).eq("id", user.id);

    await supabase.from("transactions").insert({
      user_id: user.id, type: `arena_${result}`,
      honey_delta: honeyReward, rp_delta: rpReward,
      idempotency_key: `arena_result_${arenaId}`,
    });

    return json({
      result, player_hp: pHP, opponent_hp: oHP,
      player_scores: pScores, opponent_scores: oScores,
      honey_reward: Math.floor(honeyReward * 100) / 100,
      rp_reward: rpReward, streak: newStreak,
      streak_bonus: Math.floor(streakBonus * 100) / 100,
    });
  } catch (err: any) {
    console.error("submit-arena error:", err);
    return json({ error: err.message }, 500);
  }
});