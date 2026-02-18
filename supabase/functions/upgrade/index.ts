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

async function updateQuestProgress(userId: string, questType: string, increment: number) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data: dq } = await supabase
      .from("daily_quests")
      .select("*")
      .eq("user_id", userId)
      .eq("date", today)
      .maybeSingle();
    if (!dq) return;

    for (let i = 1; i <= 3; i++) {
      if (dq[`quest_${i}_type`] === questType && !dq[`quest_${i}_done`]) {
        const newProg = Math.min(
          dq[`quest_${i}_progress`] + increment,
          dq[`quest_${i}_target`]
        );
        const done = newProg >= dq[`quest_${i}_target`];
        await supabase.from("daily_quests").update({
          [`quest_${i}_progress`]: newProg,
          [`quest_${i}_done`]: done,
        }).eq("id", dq.id);
        break;
      }
    }
  } catch (e) {
    console.error("updateQuestProgress error:", e);
  }
}

const UPGRADES: Record<string, { maxLevel: number; costs: Record<number, number>; column: string }> = {
  den: {
    maxLevel: 5,
    costs: { 2: 500, 3: 1500, 4: 4000, 5: 10000 },
    column: "den_level",
  },
  feeder: {
    maxLevel: 3,
    costs: { 2: 300, 3: 1000 },
    column: "feeder_level",
  },
  training: {
    maxLevel: 3,
    costs: { 2: 400, 3: 1200 },
    column: "training_level",
  },
  bed: {
    maxLevel: 3,
    costs: { 2: 600, 3: 2000 },
    column: "bed_level",
  },
};

function toState(u: any) {
  return {
    bear_name: u.bear_name,
    honey: Math.floor(u.honey * 100) / 100,
    amber: u.amber,
    rp: u.rp,
    satiety: Math.floor(u.satiety * 100) / 100,
    last_satiety_update: u.last_satiety_update,
    free_food_at: u.free_food_at || "1970-01-01T00:00:00Z",
    ads_today: u.ads_today || 0,
    ads_today_date: u.ads_today_date || new Date().toISOString().slice(0, 10),
    arena_streak: u.arena_streak || 0,
    den_level: u.den_level || 1,
    feeder_level: u.feeder_level || 1,
    training_level: u.training_level || 1,
    bed_level: u.bed_level || 1,
    created_at: u.created_at,
  };
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
    const upgradeType = body.upgrade_type as string;
    const targetLevel = body.target_level as number;

    if (!upgradeType || !UPGRADES[upgradeType]) {
      return json({ error: "invalid upgrade_type" }, 400);
    }

    const def = UPGRADES[upgradeType];

    if (!targetLevel || targetLevel < 2 || targetLevel > def.maxLevel) {
      return json({ error: "invalid target_level" }, 400);
    }

    const { data: user, error: userErr } = await supabase
      .from("users").select("*").eq("tg_id", tgId).maybeSingle();
    if (userErr) throw userErr;
    if (!user) return json({ error: "user not found" }, 404);

    const currentLevel = user[def.column] || 1;

    if (currentLevel !== targetLevel - 1) {
      return json({ error: `Нужен уровень ${targetLevel - 1}, сейчас ${currentLevel}` }, 400);
    }

    const cost = def.costs[targetLevel];
    if (!cost) return json({ error: "invalid level cost" }, 400);

    if (user.honey < cost) {
      return json({ error: `Недостаточно мёда (нужно ${cost})` }, 400);
    }

    const update: any = {
      honey: user.honey - cost,
      [def.column]: targetLevel,
    };

    const { error: updErr } = await supabase
      .from("users").update(update).eq("id", user.id);
    if (updErr) throw updErr;

    await updateQuestProgress(user.id, "upgrade", 1);

const tx = {
  user_id: user.id,
  type: `upgrade_${upgradeType}_${targetLevel}`,
  honey_delta: -cost,
  rp_delta: 0,
  satiety_delta: 0,
  idempotency_key: `upgrade_${user.id}_${upgradeType}_${targetLevel}`, // ✅ стабильный
};

const { error } = await supabase.from("transactions").insert(tx);
if (error) throw error;

    const merged = { ...user, ...update };
    return json({ success: true, state: toState(merged) });
  } catch (err: any) {
    console.error("upgrade error:", err);
    return json({ error: err.message }, 500);
  }
});