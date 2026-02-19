// supabase/functions/buy-skin/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { cors, json, supabase, validateInitData } from "../_shared/tg.ts";
import { findSkin, ItemType } from "../_shared/shop.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return cors();
  try {
    const auth = req.headers.get("Authorization") || "";
    const initData = auth.replace(/^Bearer\s+/i, "").trim();
    if (!initData) throw new Error("missing initData");
    const tgUser = await validateInitData(initData);

    const body = req.method === "POST" ? await req.json() : {};
    const item_type = body.item_type as ItemType;
    const item_id = body.item_id as string;
    if (!item_type || !item_id) throw new Error("missing item_type/item_id");

    const skin = findSkin(item_type, item_id);
    if (!skin) throw new Error("unknown_item");

    // Load user
    const { data: user, error: uErr } = await supabase
      .from("users")
      .select("id,amber")
      .eq("tg_id", tgUser.id)
      .single();
    if (uErr) throw uErr;

    // Free items don't require purchase; just ensure equipped works
    if (skin.price_amber <= 0) {
      return json({ ok: true, free: true });
    }

    // Already owned?
    const { data: existing, error: eErr } = await supabase
      .from("inventory")
      .select("user_id")
      .eq("user_id", user.id)
      .eq("item_type", item_type)
      .eq("item_id", item_id)
      .maybeSingle();
    if (eErr) throw eErr;
    if (existing) throw new Error("already_owned");

    if (Number(user.amber) < skin.price_amber) throw new Error("not_enough_amber");

    // Spend amber, insert inventory, log transaction
    const { error: upErr } = await supabase
      .from("users")
      .update({ amber: Number(user.amber) - skin.price_amber })
      .eq("id", user.id);
    if (upErr) throw upErr;

    const { error: insErr } = await supabase
      .from("inventory")
      .insert({ user_id: user.id, item_type, item_id });
    if (insErr) throw insErr;

    await supabase.from("transactions").insert({
      user_id: user.id,
      type: "buy_skin",
      honey_delta: 0,
      amber_delta: -skin.price_amber,
      rp_delta: 0,
      satiety_delta: 0,
      idempotency_key: `buy_skin:${user.id}:${item_type}:${item_id}`,
    });

    return json({ ok: true, spent_amber: skin.price_amber });
  } catch (e) {
    return json({ error: e?.message || String(e) }, 400);
  }
});
