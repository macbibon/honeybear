// supabase/functions/create-invoice/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { cors, json, supabase, validateInitData } from "../_shared/tg.ts";
import { findPack } from "../_shared/shop.ts";

const BOT_TOKEN = Deno.env.get("BOT_TOKEN")!;

async function tgApi(method: string, payload: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`tg_api_error:${method}:${j.description || "unknown"}`);
  return j.result;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return cors();
  try {
    const auth = req.headers.get("Authorization") || "";
    const initData = auth.replace(/^Bearer\s+/i, "").trim();
    if (!initData) throw new Error("missing initData");
    const tgUser = await validateInitData(initData);

    const body = req.method === "POST" ? await req.json() : {};
    const product_id = body.product_id as string;
    if (!product_id) throw new Error("missing product_id");

    const pack = findPack(product_id);
    if (!pack) throw new Error("unknown_product");

    const { data: user, error: uErr } = await supabase
      .from("users")
      .select("id")
      .eq("tg_id", tgUser.id)
      .single();
    if (uErr) throw uErr;

    const { data: purchase, error: pErr } = await supabase
      .from("purchases")
      .insert({
        user_id: user.id,
        product_id,
        stars_amount: pack.stars,
        status: "created",
      })
      .select("id")
      .single();
    if (pErr) throw pErr;

    const invoiceLink = await tgApi("createInvoiceLink", {
      title: "Amber Pack",
      description: `${pack.amber} 💎 Amber`,
      payload: `purchase:${purchase.id}`,
      provider_token: "", // Stars for digital goods
      currency: "XTR",
      prices: [{ label: `${pack.amber} Amber`, amount: pack.stars }],
    });

    return json({ invoice_link: invoiceLink, purchase_id: purchase.id, stars: pack.stars, amber: pack.amber });
  } catch (e) {
    return json({ error: e?.message || String(e) }, 400);
  }
});
