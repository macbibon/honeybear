// supabase/functions/claim-all-bonus/index.ts
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

const ALL_BONUS = { honey: 100, amber: 3 };

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
      .from("users").select("*").eq("tg_id", tgId).maybeSingle();
    if (ue) throw ue;
    if (!user) return json({ error: "user not found" }, 404);

    const today = new Date().toISOString().slice(0, 10);
    const { data: dq, error: dqErr } = await supabase
      .from("daily_quests").select("*")
      .eq("user_id", user.id).eq("date", today).maybeSingle();
    if (dqErr) throw dqErr;
    if (!dq) return json({ error: "no quests today" }, 404);

    // Check all 3 done and claimed
    for (let i = 1; i <= 3; i++) {
      if (!dq[`quest_${i}_done`]) return json({ error: "not all quests completed" }, 400);
      if (!dq[`quest_${i}_claimed`]) return json({ error: "claim individual rewards first" }, 400);
    }

    if (dq.all_bonus_claimed) return json({ error: "already claimed" }, 400);

    // Mark claimed
    await supabase.from("daily_quests").update({
      all_bonus_claimed: true,
    }).eq("id", dq.id);

    // Give rewards
    const newHoney = user.honey + ALL_BONUS.honey;
    const newAmber = (user.amber || 0) + ALL_BONUS.amber;
    await supabase.from("users").update({
      honey: newHoney, amber: newAmber,
    }).eq("id", user.id);

    await supabase.from("transactions").insert({
      user_id: user.id,
      type: "quest_all_bonus",
      honey_delta: ALL_BONUS.honey,
      idempotency_key: `quest_all_${user.id}_${today}`,
    });

    return json({
      success: true,
      reward: ALL_BONUS,
      honey: Math.floor(newHoney * 100) / 100,
      amber: newAmber,
    });
  } catch (err: any) {
    console.error("claim-all-bonus error:", err);
    return json({ error: err.message }, 500);
  }
});