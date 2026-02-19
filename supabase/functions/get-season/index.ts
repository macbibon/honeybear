// supabase/functions/get-season/index.ts
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
    const { data: user, error: ue } = await supabase
      .from("users")
      .select("id, bear_name, season_rp, league, rp")
      .eq("tg_id", tgId)
      .maybeSingle();
    if (ue) throw ue;
    if (!user) return json({ error: "user not found" }, 404);

    // Get active season
    const { data: season, error: se } = await supabase
      .from("seasons")
      .select("*")
      .eq("status", "active")
      .order("number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (se) throw se;

    if (!season) {
      return json({ error: "no active season" }, 404);
    }

    // Calculate days remaining
    const endsAt = new Date(season.ends_at).getTime();
    const now = Date.now();
    const daysLeft = Math.max(0, Math.ceil((endsAt - now) / 86400000));

    // Get player rank
    const { count: aboveCount } = await supabase
      .from("users")
      .select("id", { count: "exact", head: true })
      .gt("season_rp", user.season_rp);
    const playerRank = (aboveCount || 0) + 1;

    // Get total players with season_rp > 0
    const { count: totalActive } = await supabase
      .from("users")
      .select("id", { count: "exact", head: true })
      .gt("season_rp", 0);
    const total = totalActive || 1;

    // Estimate league boundaries
    const goldCutoff = Math.max(1, Math.ceil(total * 0.05));
    const silverCutoff = Math.max(1, Math.ceil(total * 0.20));

    let estimatedLeague = "bronze";
    if (user.season_rp > 0) {
      if (playerRank <= goldCutoff) estimatedLeague = "gold";
      else if (playerRank <= silverCutoff) estimatedLeague = "silver";
    }

    // Get RP thresholds
    let goldMinRp = 0, silverMinRp = 0;

    if (total > 1) {
      // Get RP at gold cutoff position
      const { data: goldRow } = await supabase
        .from("users")
        .select("season_rp")
        .gt("season_rp", 0)
        .order("season_rp", { ascending: false })
        .range(goldCutoff - 1, goldCutoff - 1)
        .maybeSingle();
      goldMinRp = goldRow?.season_rp || 0;

      const { data: silverRow } = await supabase
        .from("users")
        .select("season_rp")
        .gt("season_rp", 0)
        .order("season_rp", { ascending: false })
        .range(silverCutoff - 1, silverCutoff - 1)
        .maybeSingle();
      silverMinRp = silverRow?.season_rp || 0;
    }

    return json({
      season: {
        number: season.number,
        starts_at: season.starts_at,
        ends_at: season.ends_at,
        days_left: daysLeft,
      },
      player: {
        season_rp: user.season_rp,
        rank: playerRank,
        estimated_league: estimatedLeague,
        total_players: total,
      },
      thresholds: {
        gold_min_rp: goldMinRp,
        silver_min_rp: silverMinRp,
        gold_top: goldCutoff,
        silver_top: silverCutoff,
      },
    });
  } catch (err: any) {
    console.error("get-season error:", err);
    return json({ error: err.message }, 500);
  }
});
