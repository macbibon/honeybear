// supabase/functions/apply-referral/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { getClientIp } from "../_shared/referrals.ts";

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

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
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
    const refTgId = Number(body.ref_tg_id);
    if (!refTgId || !Number.isFinite(refTgId)) return json({ error: "invalid ref_tg_id" }, 400);

    if (refTgId === tgId) return json({ error: "self_referral" }, 400);

    const { data: me, error: meErr } = await supabase
      .from("users")
      .select("*")
      .eq("tg_id", tgId)
      .maybeSingle();
    if (meErr) throw meErr;
    if (!me) return json({ error: "user not found" }, 404);

    if (me.referrer_id) {
      return json({ ok: true, already_applied: true });
    }

    const { data: referrer, error: rfErr } = await supabase
      .from("users")
      .select("id, tg_id, referrer_id, honey, amber, referral_count")
      .eq("tg_id", refTgId)
      .maybeSingle();
    if (rfErr) throw rfErr;
    if (!referrer) return json({ error: "referrer_not_found" }, 404);

    // Ring check (A→B→A): don't allow if referrer was referred by me.
    if (referrer.referrer_id && referrer.referrer_id === me.id) {
      return json({ error: "referral_ring" }, 400);
    }

    // Hard daily limit: 5 refs per day per referrer.
    const today = todayStr();
    const { count, error: cntErr } = await supabase
      .from("referrals")
      .select("referred_id", { count: "exact", head: true })
      .eq("referrer_id", referrer.id)
      .gte("created_at", `${today}T00:00:00Z`)
      .lt("created_at", `${today}T23:59:59Z`);
    if (cntErr) throw cntErr;
    if ((count || 0) >= 5) return json({ error: "daily_referral_limit" }, 429);

    // Get IP (best-effort).
    const ip = getClientIp(req);
    let fraudFlag = false;
    if (ip) {
      const { count: ipCount, error: ipErr } = await supabase
        .from("referrals")
        .select("referred_id", { count: "exact", head: true })
        .eq("referrer_id", referrer.id)
        .eq("referred_ip", ip);
      if (ipErr) throw ipErr;
      if ((ipCount || 0) >= 2) fraudFlag = true; // current would be 3rd+
    }

    // Insert referral (unique referred_id ensures one-time).
    const { error: insErr } = await supabase.from("referrals").insert({
      referrer_id: referrer.id,
      referred_id: me.id,
      status: "registered",
      instant_reward_claimed: true,
      activation_reward_claimed: false,
      referred_total_honey_earned: 0,
      referrer_passive_earned: 0,
      referred_ip: ip,
      fraud_flag: fraudFlag,
    });
    if (insErr) {
      // If already exists (duplicate), return idempotently.
      if ((insErr as any).code === "23505") return json({ ok: true, already_applied: true });
      throw insErr;
    }

    // Update users linkage.
    const { error: u1Err } = await supabase
      .from("users")
      .update({ referrer_id: referrer.id })
      .eq("id", me.id);
    if (u1Err) throw u1Err;

    const { error: u2Err } = await supabase
      .from("users")
      .update({ referral_count: Number(referrer.referral_count || 0) + 1 })
      .eq("id", referrer.id);
    if (u2Err) throw u2Err;

    // Instant rewards: both +200 honey, +3 amber
    const instantHoney = 200;
    const instantAmber = 3;

    await supabase.from("users").update({
      honey: Number(me.honey || 0) + instantHoney,
      amber: Number(me.amber || 0) + instantAmber,
    }).eq("id", me.id);

    await supabase.from("users").update({
      honey: Number(referrer.honey || 0) + instantHoney,
      amber: Number(referrer.amber || 0) + instantAmber,
    }).eq("id", referrer.id);

    await supabase.from("transactions").insert([
      {
        user_id: me.id,
        type: "referral_instant_reward_referred",
        honey_delta: instantHoney,
        amber_delta: instantAmber,
        idempotency_key: `ref_instant_referred_${me.id}`,
      },
      {
        user_id: referrer.id,
        type: "referral_instant_reward_referrer",
        honey_delta: instantHoney,
        amber_delta: instantAmber,
        idempotency_key: `ref_instant_referrer_${me.id}`,
      },
    ]);

    // ── Notify referrer via Telegram (best-effort) ──
    const botToken = Deno.env.get("BOT_TOKEN");
    const miniAppUrl = Deno.env.get("MINI_APP_URL") || "https://t.me/HoneyBearBot/app";
    if (botToken && referrer.tg_id) {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: referrer.tg_id,
          text: `🎉 Новый друг присоединился! +${instantHoney}🍯 +${instantAmber}💎`,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: "🐻 Открыть игру", web_app: { url: miniAppUrl } }]],
          },
        }),
      }).catch(() => {});
    }

    return json({ ok: true, fraud_flag: fraudFlag });
  } catch (err: any) {
    console.error("apply-referral error:", err);
    return json({ error: err.message }, 500);
  }
});
