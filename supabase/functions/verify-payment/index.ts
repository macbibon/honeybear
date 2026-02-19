// supabase/functions/verify-payment/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { cors, json, supabase } from "../_shared/tg.ts";
import { findPack } from "../_shared/shop.ts";

const BOT_TOKEN = Deno.env.get("BOT_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("TG_WEBHOOK_SECRET") || "";

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
    if (WEBHOOK_SECRET) {
      const got = req.headers.get("x-telegram-bot-api-secret-token") || "";
      if (got !== WEBHOOK_SECRET) return json({ ok: false, error: "bad_secret" }, 401);
    }

    const update = await req.json();

    // 1) pre_checkout_query -> approve
    if (update?.pre_checkout_query) {
      const q = update.pre_checkout_query;
      await tgApi("answerPreCheckoutQuery", {
        pre_checkout_query_id: q.id,
        ok: true,
      });
      return json({ ok: true });
    }

    // 2) successful_payment
    const sp = update?.message?.successful_payment;
    if (sp) {
      const payload: string = sp.invoice_payload;
      if (!payload?.startsWith("purchase:")) return json({ ok: true, ignored: true });

      const purchaseId = payload.split(":")[1];
      const { data: purchase, error: pErr } = await supabase
        .from("purchases")
        .select("id,user_id,product_id,status")
        .eq("id", purchaseId)
        .single();
      if (pErr) throw pErr;

      if (purchase.status === "paid") return json({ ok: true, already: true });

      const pack = findPack(purchase.product_id);
      if (!pack) throw new Error("unknown_product");

      // Credit amber to user
      const { data: user, error: uErr } = await supabase
        .from("users")
        .select("id,amber")
        .eq("id", purchase.user_id)
        .single();
      if (uErr) throw uErr;

      const newAmber = Number(user.amber) + pack.amber;

      const { error: upErr } = await supabase
        .from("users")
        .update({ amber: newAmber })
        .eq("id", user.id);
      if (upErr) throw upErr;

      const payId = sp.telegram_payment_charge_id || sp.provider_payment_charge_id || null;

      const { error: puErr } = await supabase
        .from("purchases")
        .update({ status: "paid", telegram_payment_id: payId })
        .eq("id", purchase.id);
      if (puErr) throw puErr;

      await supabase.from("transactions").insert({
        user_id: user.id,
        type: "stars_purchase",
        honey_delta: 0,
        amber_delta: pack.amber,
        rp_delta: 0,
        satiety_delta: 0,
        idempotency_key: `stars_purchase:${purchase.id}`,
      });

      return json({ ok: true, credited_amber: pack.amber });
    }

    return json({ ok: true, ignored: true });
  } catch (e) {
    return json({ ok: false, error: e?.message || String(e) }, 400);
  }
});
