// supabase/functions/get-shop/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { cors, json, supabase, validateInitData } from "../_shared/tg.ts";
import { AMBER_PACKS, SKINS_CATALOG } from "../_shared/shop.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return cors();
  try {
    const auth = req.headers.get("Authorization") || "";
    const initData = auth.replace(/^Bearer\s+/i, "").trim();
    if (!initData) throw new Error("missing initData");
    const tgUser = await validateInitData(initData);

    // user row
    const { data: user, error: uErr } = await supabase
      .from("users")
      .select("id,tg_id,honey,amber,rp,satiety,equipped_hat,equipped_accessory,equipped_background,equipped_color,bear_name")
      .eq("tg_id", tgUser.id)
      .maybeSingle();
    if (uErr) throw uErr;
    if (!user) {
      return json({ error: "user_not_found" }, 404);
    }

    const { data: inv, error: iErr } = await supabase
      .from("inventory")
      .select("item_type,item_id")
      .eq("user_id", user.id);
    if (iErr) throw iErr;

    const owned: Record<string, true> = {};
    for (const row of inv || []) owned[`${row.item_type}:${row.item_id}`] = true;

    // mark free as owned
    for (const [t, items] of Object.entries(SKINS_CATALOG)) {
      for (const it of items as any[]) {
        if (it.price_amber === 0) owned[`${t}:${it.id}`] = true;
      }
    }

    return json({
      catalog: SKINS_CATALOG,
      amber_packs: AMBER_PACKS,
      owned,
      equipped: {
        hat: user.equipped_hat,
        accessory: user.equipped_accessory,
        background: user.equipped_background,
        color: user.equipped_color,
      },
      balance: { amber: user.amber, honey: user.honey },
    });
  } catch (e) {
    return json({ error: e?.message || String(e) }, 400);
  }
});
