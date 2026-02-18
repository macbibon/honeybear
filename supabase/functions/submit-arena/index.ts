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

// ── Deterministic bot scoring ──────────────────────────────
function seededRandom(seed: string, index: number): number {
  // Simple hash-based PRNG
  let hash = 0;
  const str = seed + '_' + index;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash % 1000) / 1000;
}

function calculateDamage(cursorPos: number, greenCenter: number, greenHalf: number, yellowHalf: number): { damage: number; zone: string } {
  const dist = Math.abs(cursorPos - greenCenter);
  if (dist <= greenHalf) return { damage: 30, zone: 'green' };
  if (dist <= yellowHalf) return { damage: 15, zone: 'yellow' };
  return { damage: 5, zone: 'red' };
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

    if (!arenaId || !hits || !Array.isArray(hits)) {
      return json({ error: "invalid request body" }, 400);
    }

    // Get user
    const { data: user, error: userErr } = await supabase
      .from("users").select("*").eq("tg_id", tgId).maybeSingle();
    if (userErr) throw userErr;
    if (!user) return json({ error: "user not found" }, 404);

    // Get arena
    const { data: arena, error: arenaErr } = await supabase
      .from("arenas").select("*").eq("id", arenaId).maybeSingle();
    if (arenaErr) throw arenaErr;
    if (!arena) return json({ error: "arena not found" }, 404);

    // Validate ownership
    if (arena.user_id !== user.id) {
      return json({ error: "not your arena" }, 403);
    }

    // Validate not completed
    if (arena.result !== null) {
      return json({ error: "arena already completed" }, 400);
    }

    const rounds = arena.rounds_data as Array<{
      round: number;
      green_center: number;
      green_half_width: number;
      yellow_half_width: number;
    }>;

    // ── Calculate player damage ────────────────────────────
    let playerHP = 100;
    let opponentHP = 100;
    const playerScores: any[] = [];
    const opponentScores: any[] = [];

    // Bot accuracy: based on opponent RP (40-70% chance of hitting green)
    const oppRp = arena.opponent_rp;
    // Accuracy scales: rp 10 → 40%, rp 100 → 55%, rp 500 → 65%, rp 1000 → 70%
    const botAccuracy = Math.min(0.70, 0.40 + (oppRp / 2000) * 0.30);

    for (let i = 0; i < rounds.length; i++) {
      const round = rounds[i];
      const hit = hits.find(h => h.round === round.round);

      // Player hit
      if (hit && opponentHP > 0 && playerHP > 0) {
        const cursorPos = Math.max(0, Math.min(1, hit.cursor_pos));
        const pResult = calculateDamage(
          cursorPos, round.green_center,
          round.green_half_width, round.yellow_half_width
        );
        opponentHP = Math.max(0, opponentHP - pResult.damage);
        playerScores.push({
          round: round.round,
          cursor_pos: cursorPos,
          damage: pResult.damage,
          zone: pResult.zone,
        });
      }

      // Bot hit (deterministic from arena ID)
      if (playerHP > 0 && opponentHP > 0) {
        const rng = seededRandom(arenaId, i);
        let botDamage: number;
        let botZone: string;

        if (rng < botAccuracy * 0.6) {
          // Hit green
          botDamage = 30;
          botZone = 'green';
        } else if (rng < botAccuracy) {
          // Hit yellow
          botDamage = 15;
          botZone = 'yellow';
        } else {
          // Miss (red)
          botDamage = 5;
          botZone = 'red';
        }

        playerHP = Math.max(0, playerHP - botDamage);
        opponentScores.push({
          round: round.round,
          damage: botDamage,
          zone: botZone,
        });
      }

      // Check if fight is over
      if (playerHP <= 0 || opponentHP <= 0) break;
    }

    // ── Determine result ───────────────────────────────────
    let result: string;
    if (opponentHP <= 0 && playerHP > 0) {
      result = 'win';
    } else if (playerHP <= 0 && opponentHP > 0) {
      result = 'loss';
    } else if (playerHP <= 0 && opponentHP <= 0) {
      // Both down — whoever did more total damage wins
      const pTotal = playerScores.reduce((s: number, x: any) => s + x.damage, 0);
      const oTotal = opponentScores.reduce((s: number, x: any) => s + x.damage, 0);
      result = pTotal >= oTotal ? 'win' : 'loss';
    } else {
      // All rounds done, compare HP
      result = opponentHP <= playerHP ? 'win' : 'loss';
    }

    // ── Rewards ────────────────────────────────────────────
    let honeyReward: number;
    let rpReward: number;
    let newStreak: number;
    let streakBonus = 0;

    const currentStreak = user.arena_streak || 0;

    if (result === 'win') {
      honeyReward = 50;
      rpReward = 15;
      newStreak = currentStreak + 1;

      // Streak bonus: every 3 wins → +20% honey
      const streakMultiplier = Math.floor(newStreak / 3);
      if (streakMultiplier > 0) {
        streakBonus = honeyReward * 0.20 * streakMultiplier;
        honeyReward += streakBonus;
      }
    } else {
      honeyReward = 5;
      rpReward = 2;
      newStreak = 0;
    }

    // ── Update arena ───────────────────────────────────────
    const { error: arenaUpdErr } = await supabase
      .from("arenas")
      .update({
        player_scores: playerScores,
        opponent_scores: opponentScores,
        player_hp: playerHP,
        opponent_hp: opponentHP,
        result,
        honey_delta: honeyReward,
        rp_delta: rpReward,
        streak_bonus: streakBonus,
      })
      .eq("id", arenaId);
    if (arenaUpdErr) throw arenaUpdErr;

    // ── Update user ────────────────────────────────────────
    const { error: userUpdErr } = await supabase
      .from("users")
      .update({
        honey: user.honey + honeyReward,
        rp: (user.rp || 0) + rpReward,
        arena_streak: newStreak,
      })
      .eq("id", user.id);
    if (userUpdErr) throw userUpdErr;

    // ── Log transaction ────────────────────────────────────
    await supabase.from("transactions").insert({
      user_id: user.id,
      type: `arena_${result}`,
      honey_delta: honeyReward,
      rp_delta: rpReward,
      idempotency_key: `arena_result_${arenaId}`,
    });

    return json({
      result,
      player_hp: playerHP,
      opponent_hp: opponentHP,
      player_scores: playerScores,
      opponent_scores: opponentScores,
      honey_reward: Math.floor(honeyReward * 100) / 100,
      rp_reward: rpReward,
      streak: newStreak,
      streak_bonus: Math.floor(streakBonus * 100) / 100,
    });

  } catch (err: any) {
    console.error("submit-arena error:", err);
    return json({ error: err.message }, 500);
  }
});