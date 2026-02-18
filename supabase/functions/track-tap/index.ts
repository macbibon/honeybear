// supabase/functions/track-tap/index.ts
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

    const body = await req.json().catch(() => ({}));
    const taps = Math.min(50, Math.max(1, body.taps || 1));

    const { data: user } = await supabase
      .from("users").select("id").eq("tg_id", tgId).maybeSingle();
    if (!user) return json({ ok: true });

    const today = new Date().toISOString().slice(0, 10);
    const { data: dq } = await supabase
      .from("daily_quests").select("*")
      .eq("user_id", user.id).eq("date", today).maybeSingle();
    if (!dq) return json({ ok: true });

    for (let i = 1; i <= 3; i++) {
      if (dq[`quest_${i}_type`] === "tap_bear" && !dq[`quest_${i}_done`]) {
        const newProg = Math.min(dq[`quest_${i}_progress`] + taps, dq[`quest_${i}_target`]);
        const done = newProg >= dq[`quest_${i}_target`];
        await supabase.from("daily_quests").update({
          [`quest_${i}_progress`]: newProg,
          [`quest_${i}_done`]: done,
        }).eq("id", dq.id);
        break;
      }
    }

    return json({ ok: true });
  } catch (err: any) {
    console.error("track-tap error:", err);
    return json({ ok: true });
  }
});