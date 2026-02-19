// supabase/functions/rotate-season/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  // Simple auth: check for a secret header
  const cronSecret = req.headers.get("x-cron-secret");
  const expected = Deno.env.get("CRON_SECRET") || "honeybear-rotate-2024";
  if (cronSecret !== expected) {
    return json({ error: "unauthorized" }, 401);
  }

  try {
    // Find expired active season
    const { data: expired, error: se } = await supabase
      .from("seasons")
      .select("*")
      .eq("status", "active")
      .lt("ends_at", new Date().toISOString())
      .maybeSingle();
    if (se) throw se;

    if (!expired) {
      // Check if any active season exists
      const { data: active } = await supabase
        .from("seasons")
        .select("id")
        .eq("status", "active")
        .maybeSingle();

      if (!active) {
        // Create first season
        const { error: createErr } = await supabase
          .from("seasons")
          .insert({
            number: 1,
            starts_at: new Date().toISOString(),
            ends_at: new Date(Date.now() + 14 * 86400000).toISOString(),
            status: "active",
          });
        if (createErr) throw createErr;
        return json({ action: "created_first_season" });
      }

      return json({ action: "nothing_to_do" });
    }

    // === ROTATE SEASON ===

    // 1. Get all players with season_rp > 0, ordered by RP
    const { data: players, error: pe } = await supabase
      .from("users")
      .select("id, season_rp")
      .gt("season_rp", 0)
      .order("season_rp", { ascending: false });
    if (pe) throw pe;

    const total = players?.length || 0;
    const goldCutoff = Math.max(1, Math.ceil(total * 0.05));
    const silverCutoff = Math.max(1, Math.ceil(total * 0.20));

    // 2. Assign leagues and save results
    const results: any[] = [];
    for (let i = 0; i < (players || []).length; i++) {
      const p = players![i];
      const rank = i + 1;
      let league = "bronze";
      if (rank <= goldCutoff) league = "gold";
      else if (rank <= silverCutoff) league = "silver";

      results.push({
        season_id: expired.id,
        user_id: p.id,
        season_rp: p.season_rp,
        league,
        rank,
      });

      // Update user's league badge
      await supabase
        .from("users")
        .update({ league })
        .eq("id", p.id);
    }

    // 3. Insert results in batches of 100
    for (let i = 0; i < results.length; i += 100) {
      const batch = results.slice(i, i + 100);
      const { error: insertErr } = await supabase
        .from("season_results")
        .insert(batch);
      if (insertErr) console.error("batch insert error:", insertErr);
    }

    // 4. Reset ALL users' season_rp
    const { error: resetErr } = await supabase
      .from("users")
      .update({ season_rp: 0 })
      .gte("season_rp", 0);
    if (resetErr) throw resetErr;

    // 5. Mark season as ended
    const { error: endErr } = await supabase
      .from("seasons")
      .update({ status: "ended" })
      .eq("id", expired.id);
    if (endErr) throw endErr;

    // 6. Create new season
    const newNumber = expired.number + 1;
    const newStart = new Date().toISOString();
    const newEnd = new Date(Date.now() + 14 * 86400000).toISOString();

    const { error: newErr } = await supabase
      .from("seasons")
      .insert({
        number: newNumber,
        starts_at: newStart,
        ends_at: newEnd,
        status: "active",
      });
    if (newErr) throw newErr;

    return json({
      action: "rotated",
      ended_season: expired.number,
      new_season: newNumber,
      players_ranked: total,
      gold_count: goldCutoff,
      silver_count: silverCutoff - goldCutoff,
    });
  } catch (err: any) {
    console.error("rotate-season error:", err);
    return json({ error: err.message }, 500);
  }
});