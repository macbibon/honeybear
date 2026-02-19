// supabase/functions/get-shop/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { cors, json, supabase, validateInitData } from "../_shared/tg.ts";
import { AMBER_PACKS, SKINS_CATALOG } from "../_shared/shop.ts";

type SkinItem = {
  id: string;
  priceAmber: number;
  seasonal?: boolean;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return cors();
  try {
    const auth = req.headers.get("Authorization") || "";
    const initData = auth.replace(/^Bearer\s+/i, "").trim();
    if (!initData) throw new Error("missing initData");

    const tgUser = await validateInitData(initData);

    const { data: user, error: uErr } = await supabase
      .from("users")
      .select(
        "id,tg_id,honey,amber,rp,satiety,equipped_hat,equipped_accessory,equipped_background,equipped_color,bear_name",
      )
      .eq("tg_id", tgUser.id)
      .maybeSingle();

    if (uErr) throw uErr;
    if (!user) return json({ error: "user_not_found" }, 404);

    const { data: inv, error: iErr } = await supabase
      .from("inventory")
      .select("item_type,item_id")
      .eq("user_id", user.id);

    if (iErr) throw iErr;

    // owned -> arrays per type (как ждёт UI)
    const ownedByType: Record<string, string[]> = {
      hat: [],
      accessory: [],
      background: [],
      color: [],
    };

    for (const row of inv || []) {
      if (!ownedByType[row.item_type]) ownedByType[row.item_type] = [];
      ownedByType[row.item_type].push(row.item_id);
    }

    // helper: normalize catalog items to {id, priceAmber, seasonal}
    const normalizedCatalog: Record<string, SkinItem[]> = {};
    for (const [t, items] of Object.entries(SKINS_CATALOG)) {
      normalizedCatalog[t] = (items as any[]).map((it) => {
        const priceAmber = Number(it.priceAmber ?? it.price_amber ?? it.price ?? it.amber ?? 0);
        return {
          id: String(it.id),
          priceAmber,
          seasonal: !!it.seasonal,
        };
      });

      // free items считаем owned (если их нет в inventory)
      for (const it of normalizedCatalog[t]) {
        if (it.priceAmber === 0 && !ownedByType[t].includes(it.id)) {
          ownedByType[t].push(it.id);
        }
      }
    }

    return json({
      catalog: normalizedCatalog,
      packs: AMBER_PACKS, // ✅ как ждёт UI
      owned: ownedByType, // ✅ как ждёт UI
      equipped: {
        hat: user.equipped_hat,
        accessory: user.equipped_accessory,
        background: user.equipped_background,
        color: user.equipped_color,
      },
      balances: { amber: user.amber, honey: user.honey }, // ✅ как ждёт UI
    });
  } catch (e) {
    return json({ error: e?.message || String(e) }, 400);
  }
});