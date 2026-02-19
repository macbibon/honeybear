// supabase/functions/claim-milestone/index.ts
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
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
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

const REWARDS: Record<number, { honey: number; amber: number; skin: string }> = {
  3: { honey: 500, amber: 5, skin: "friend_scarf" },
  5: { honey: 1000, amber: 10, skin: "friend_hat" },
  10: { honey: 2500, amber: 20, skin: "friend_glow" },
  25: { honey: 8000, amber: 50, skin: "friend_king" },
  50: { honey: 20000, amber: 120, skin: "friend_legend" },
};

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
    const milestone = Number(body.milestone);
    if (!REWARDS[milestone]) return json({ error: "invalid milestone" }, 400);

    const { data: me, error: meErr } = await supabase
      .from("users")
      .select("id, honey, amber, referral_activated_count")
      .eq("tg_id", tgId)
      .maybeSingle();
    if (meErr) throw meErr;
    if (!me) return json({ error: "user not found" }, 404);

    if (Number(me.referral_activated_count || 0) < milestone) {
      return json({ error: "milestone_not_reached" }, 400);
    }

    // Ensure row exists.
    await supabase.from("referral_milestones").upsert({ user_id: me.id, milestone }, { onConflict: "user_id,milestone" });
    const { data: row, error: rErr } = await supabase
      .from("referral_milestones")
      .select("claimed")
      .eq("user_id", me.id)
      .eq("milestone", milestone)
      .maybeSingle();
    if (rErr) throw rErr;
    if (row?.claimed) return json({ error: "already_claimed" }, 400);

    const reward = REWARDS[milestone];

    await supabase.from("referral_milestones").update({ claimed: true }).eq("user_id", me.id).eq("milestone", milestone);

    const newHoney = Number(me.honey || 0) + reward.honey;
    const newAmber = Number(me.amber || 0) + reward.amber;
    await supabase.from("users").update({ honey: newHoney, amber: newAmber }).eq("id", me.id);

    await supabase.from("transactions").insert({
      user_id: me.id,
      type: `referral_milestone_${milestone}`,
      honey_delta: reward.honey,
      amber_delta: reward.amber,
      idempotency_key: `ref_milestone_${me.id}_${milestone}`,
    });

    return json({ ok: true, reward });
  } catch (err: any) {
    console.error("claim-milestone error:", err);
    return json({ error: err.message }, 500);
  }
});
