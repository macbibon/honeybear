// supabase/functions/get-leaderboard/index.ts
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

    // Get current user
    const { data: user, error: ue } = await supabase
      .from("users")
      .select("id, bear_name, season_rp, league")
      .eq("tg_id", tgId)
      .maybeSingle();
    if (ue) throw ue;
    if (!user) return json({ error: "user not found" }, 404);

    // Top 50
    const { data: top50, error: topErr } = await supabase
      .from("users")
      .select("id, bear_name, season_rp, league")
      .gt("season_rp", 0)
      .order("season_rp", { ascending: false })
      .limit(50);
    if (topErr) throw topErr;

    // Player rank
    const { count: aboveCount } = await supabase
      .from("users")
      .select("id", { count: "exact", head: true })
      .gt("season_rp", user.season_rp);
    const playerRank = (aboveCount || 0) + 1;

    // Total active
    const { count: totalActive } = await supabase
      .from("users")
      .select("id", { count: "exact", head: true })
      .gt("season_rp", 0);
    const total = totalActive || 1;

    // Estimated leagues for display
    const goldCutoff = Math.max(1, Math.ceil(total * 0.05));
    const silverCutoff = Math.max(1, Math.ceil(total * 0.20));

    const leaderboard = (top50 || []).map((u: any, idx: number) => {
      const rank = idx + 1;
      let estLeague = "bronze";
      if (rank <= goldCutoff) estLeague = "gold";
      else if (rank <= silverCutoff) estLeague = "silver";

      return {
        rank,
        bear_name: u.bear_name,
        season_rp: u.season_rp,
        league: estLeague,
        is_self: u.id === user.id,
      };
    });

    // Check if player is in top 50
    const selfInList = leaderboard.some((e: any) => e.is_self);

    let selfEntry = null;
    if (!selfInList && user.season_rp > 0) {
      let estLeague = "bronze";
      if (playerRank <= goldCutoff) estLeague = "gold";
      else if (playerRank <= silverCutoff) estLeague = "silver";

      selfEntry = {
        rank: playerRank,
        bear_name: user.bear_name,
        season_rp: user.season_rp,
        league: estLeague,
        is_self: true,
      };
    }

    return json({
      leaderboard,
      self: selfEntry,
      player_rank: playerRank,
      total_players: total,
      gold_cutoff: goldCutoff,
      silver_cutoff: silverCutoff,
    });
  } catch (err: any) {
    console.error("get-leaderboard error:", err);
    return json({ error: err.message }, 500);
  }
});