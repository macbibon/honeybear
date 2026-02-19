// supabase/functions/claim-quest-reward/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { awardReferralPassive } from "../_shared/referrals.ts";

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

const REWARDS: Record<string, { honey: number; amber: number }> = {
  easy: { honey: 50, amber: 0 },
  medium: { honey: 100, amber: 2 },
  hard: { honey: 200, amber: 3 },
};

const EASY_TYPES = ["feed_bear", "tap_bear", "login"];
const MEDIUM_TYPES = ["play_arena", "win_arena", "watch_ad"];

function difficulty(type: string): string {
  if (EASY_TYPES.includes(type)) return "easy";
  if (MEDIUM_TYPES.includes(type)) return "medium";
  return "hard";
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
    const slot = body.slot as number;
    if (!slot || slot < 1 || slot > 3) return json({ error: "invalid slot" }, 400);

    const { data: user, error: ue } = await supabase
      .from("users").select("*").eq("tg_id", tgId).maybeSingle();
    if (ue) throw ue;
    if (!user) return json({ error: "user not found" }, 404);

    const today = new Date().toISOString().slice(0, 10);
    const { data: dq, error: dqErr } = await supabase
      .from("daily_quests").select("*")
      .eq("user_id", user.id).eq("date", today).maybeSingle();
    if (dqErr) throw dqErr;
    if (!dq) return json({ error: "no quests today" }, 404);

    const doneKey = `quest_${slot}_done`;
    const claimedKey = `quest_${slot}_claimed`;
    const typeKey = `quest_${slot}_type`;

    if (!dq[doneKey]) return json({ error: "quest not completed" }, 400);
    if (dq[claimedKey]) return json({ error: "already claimed" }, 400);

    const diff = difficulty(dq[typeKey]);
    const reward = REWARDS[diff];

    // Mark claimed
    await supabase.from("daily_quests").update({
      [claimedKey]: true,
    }).eq("id", dq.id);

    // Give rewards
    const newHoney = user.honey + reward.honey;
    const newAmber = (user.amber || 0) + reward.amber;
    await supabase.from("users").update({
      honey: newHoney, amber: newAmber,
    }).eq("id", user.id);

    await supabase.from("transactions").insert({
      user_id: user.id,
      type: `quest_reward_${slot}_${dq[typeKey]}`,
      honey_delta: reward.honey,
      idempotency_key: `quest_${user.id}_${today}_slot${slot}`,
    });

    if (reward.honey > 0) {
      await awardReferralPassive({
        supabase,
        referredUserId: user.id,
        honeyEarned: reward.honey,
        sourceIdempotencyKey: `quest_${user.id}_${today}_slot${slot}`,
      });
    }

    return json({
      success: true,
      reward,
      honey: Math.floor(newHoney * 100) / 100,
      amber: newAmber,
    });
  } catch (err: any) {
    console.error("claim-quest-reward error:", err);
    return json({ error: err.message }, 500);
  }
});