// supabase/functions/equip-skin/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { cors, json, supabase, validateInitData } from "../_shared/tg.ts";
import { findSkin, ItemType } from "../_shared/shop.ts";

const FIELD_BY_TYPE: Record<ItemType, string> = {
  hat: "equipped_hat",
  accessory: "equipped_accessory",
  background: "equipped_background",
  color: "equipped_color",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return cors();
  try {
    const auth = req.headers.get("Authorization") || "";
    const initData = auth.replace(/^Bearer\s+/i, "").trim();
    if (!initData) throw new Error("missing initData");
    const tgUser = await validateInitData(initData);

    const body = req.method === "POST" ? await req.json() : {};
    const item_type = body.item_type as ItemType;
    const item_id = body.item_id as (string | null);
    if (!item_type) throw new Error("missing item_type");
    const field = FIELD_BY_TYPE[item_type];
    if (!field) throw new Error("unknown_type");

    const { data: user, error: uErr } = await supabase
      .from("users")
      .select("id")
      .eq("tg_id", tgUser.id)
      .single();
    if (uErr) throw uErr;

    if (item_id === null) {
      // unequip for hat/accessory; for background/color we keep defaults
      const patch: any = {};
      if (item_type === "background") patch[field] = "forest";
      else if (item_type === "color") patch[field] = "brown";
      else patch[field] = null;

      const { error: upErr } = await supabase.from("users").update(patch).eq("id", user.id);
      if (upErr) throw upErr;
      return json({ ok: true, equipped: patch[field] });
    }

    const skin = findSkin(item_type, item_id);
    if (!skin) throw new Error("unknown_item");

    // free items ok; otherwise must own in inventory
    if (skin.price_amber > 0) {
      const { data: inv, error: iErr } = await supabase
        .from("inventory")
        .select("item_id")
        .eq("user_id", user.id)
        .eq("item_type", item_type)
        .eq("item_id", item_id)
        .maybeSingle();
      if (iErr) throw iErr;
      if (!inv) throw new Error("not_owned");
    }

    const patch: any = {};
    patch[field] = item_id;
    const { error: upErr } = await supabase.from("users").update(patch).eq("id", user.id);
    if (upErr) throw upErr;

    return json({ ok: true, equipped: item_id });
  } catch (e) {
    return json({ error: e?.message || String(e) }, 400);
  }
});
