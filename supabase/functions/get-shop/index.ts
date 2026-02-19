// supabase/functions/get-shop/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { cors, json, supabase, validateInitData } from "../_shared/tg.ts";
import { AMBER_PACKS, SKINS_CATALOG } from "../_shared/shop.ts";

type SkinItem = {
  id: string;
  priceAmber: number;
  seasonal?: boolean;
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return cors();

  try {
    const auth = req.headers.get("Authorization") || "";
    const initData = auth.replace(/^Bearer\s+/i, "").trim();
    if (!initData) throw new Error("missing initData");

    const tgUser = await validateInitData(initData);

    const { data: user, error: uErr } = await supabase
      .from("users")
      .select("id,tg_id,honey,amber,equipped_hat,equipped_accessory,equipped_background,equipped_color")
      .eq("tg_id", tgUser.id)
      .maybeSingle();

    if (uErr) throw uErr;
    if (!user) return json({ error: "user_not_found" }, 404);

    const { data: inv, error: iErr } = await supabase
      .from("inventory")
      .select("item_type,item_id")
      .eq("user_id", user.id);

    if (iErr) throw iErr;

    // owned как ожидает UI: массивы по типам
    const ownedByType: Record<string, string[]> = {
      hat: [],
      accessory: [],
      background: [],
      color: [],
    };

    for (const row of inv || []) {
      const t = String(row.item_type);
      const id = String(row.item_id);
      if (!ownedByType[t]) ownedByType[t] = [];
      ownedByType[t].push(id);
    }

    // normalize catalog items => {id, priceAmber, seasonal}
    const normalizedCatalog: Record<string, SkinItem[]> = {};
    for (const [t, items] of Object.entries(SKINS_CATALOG)) {
      normalizedCatalog[t] = (items as any[]).map((it) => {
        const priceAmber = Number(it.priceAmber ?? it.price_amber ?? it.price ?? it.amber ?? 0);
        return {
          id: String(it.id),
          priceAmber,
          seasonal: Boolean(it.seasonal),
        };
      });

      // free items считаем owned
      for (const it of normalizedCatalog[t]) {
        if (it.priceAmber === 0 && !ownedByType[t].includes(it.id)) {
          ownedByType[t].push(it.id);
        }
      }
    }

    return json({
      catalog: normalizedCatalog,
      packs: AMBER_PACKS,
      owned: ownedByType,
      equipped: {
        hat: user.equipped_hat,
        accessory: user.equipped_accessory,
        background: user.equipped_background,
        color: user.equipped_color,
      },
      balances: { amber: user.amber, honey: user.honey },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 400);
  }
});