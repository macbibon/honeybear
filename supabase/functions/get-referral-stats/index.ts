// supabase/functions/get-referral-stats/index.ts
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

const MILESTONES = [3, 5, 10, 25, 50];

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

    const { data: me, error: meErr } = await supabase
      .from("users")
      .select("id, tg_id, referral_count, referral_activated_count, referral_income_today, referral_income_today_date")
      .eq("tg_id", tgId)
      .maybeSingle();
    if (meErr) throw meErr;
    if (!me) return json({ error: "user not found" }, 404);

    // Normalize daily income field.
    const today = todayStr();
    let incomeToday = Number(me.referral_income_today || 0);
    const incomeDate = (me.referral_income_today_date || today).toString();
    if (incomeDate !== today) incomeToday = 0;

    // Ensure milestone rows exist.
    const upserts = MILESTONES.map((m) => ({ user_id: me.id, milestone: m }));
    await supabase.from("referral_milestones").upsert(upserts, { onConflict: "user_id,milestone" });

    const { data: msRows, error: msErr } = await supabase
      .from("referral_milestones")
      .select("milestone, claimed")
      .eq("user_id", me.id);
    if (msErr) throw msErr;

    const milestones = (msRows || [])
      .map((r: any) => {
        const m = Number(r.milestone);
        return {
          milestone: m,
          claimed: !!r.claimed,
          claimable: !r.claimed && Number(me.referral_activated_count || 0) >= m,
        };
      })
      .sort((a: any, b: any) => a.milestone - b.milestone);

    // Friends list.
    const { data: refs, error: rErr } = await supabase
      .from("referrals")
      .select(
        `
        status,
        fraud_flag,
        created_at,
        activated_at,
        referrer_passive_earned,
        referred_total_honey_earned,
        referred_id,
        referred:users!referrals_referred_id_fkey(id, tg_id, bear_name, rp, created_at)
      `,
      )
      .eq("referrer_id", me.id)
      .order("created_at", { ascending: false });
    if (rErr) throw rErr;

    const friends = (refs || []).map((r: any) => ({
      status: r.status,
      fraud_flag: !!r.fraud_flag,
      created_at: r.created_at,
      activated_at: r.activated_at,
      passive_earned: Math.floor(Number(r.referrer_passive_earned || 0) * 100) / 100,
      referred_total_honey_earned: Math.floor(Number(r.referred_total_honey_earned || 0) * 100) / 100,
      friend: {
        tg_id: r.referred?.tg_id,
        bear_name: r.referred?.bear_name,
        rp: r.referred?.rp,
        joined_at: r.referred?.created_at,
      },
    }));

    return json({
      stats: {
        invited: Number(me.referral_count || 0),
        activated: Number(me.referral_activated_count || 0),
        income_today: Math.floor(incomeToday * 100) / 100,
      },
      milestones,
      friends,
      referral_start_param: `ref_${tgId}`,
    });
  } catch (err: any) {
    console.error("get-referral-stats error:", err);
    return json({ error: err.message }, 500);
  }
});
