// supabase/functions/telegram-webhook/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const BOT_TOKEN                 = Deno.env.get("BOT_TOKEN")!;
const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MINI_APP_URL              = Deno.env.get("MINI_APP_URL") || "https://t.me/HoneyBearBot/app";
const WEBHOOK_SECRET            = Deno.env.get("WEBHOOK_SECRET") || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function tgCall(method: string, params: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
}

async function sendWelcome(chatId: number, firstName: string) {
  await tgCall("sendMessage", {
    chat_id: chatId,
    text:
      `🐻 Привет, ${firstName}!\n\nДобро пожаловать в <b>HoneyBear</b> — игру про медведя, который собирает мёд!\n\n` +
      `Корми медведя, сражайся на арене и собирай рекордное количество мёда 🍯`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "🎮 Играть", web_app: { url: MINI_APP_URL } }]],
    },
  });
}

async function processReferral(newUserTgId: number, referrerCode: string) {
  const referrerTgId = parseInt(referrerCode, 10);
  if (!referrerTgId || referrerTgId === newUserTgId) return;

  const { data: referrer } = await supabase
    .from("users").select("id, tg_id, bear_name").eq("tg_id", referrerTgId).maybeSingle();
  if (!referrer) return;

  await tgCall("sendMessage", {
    chat_id: referrerTgId,
    text: `🎉 По вашей реферальной ссылке кто-то переходит в игру!`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "🐻 Открыть игру", web_app: { url: MINI_APP_URL } }]],
    },
  });
}

serve(async (req) => {
  // Verify Telegram webhook secret header
  if (WEBHOOK_SECRET) {
    const headerSecret = req.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (headerSecret !== WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // ── Проброс платёжных событий в verify-payment ──
  if (update?.pre_checkout_query || update?.message?.successful_payment) {
    await fetch(`${SUPABASE_URL}/functions/v1/verify-payment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
      },
      body: JSON.stringify(update),
    }).catch((e) => console.error("verify-payment forward error:", e));

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── Обработка сообщений ──
  const msg = update?.message;
  if (msg) {
    const chatId    = msg.chat?.id as number;
    const tgId      = msg.from?.id as number;
    const firstName = msg.from?.first_name || "игрок";
    const text      = msg.text || "";

    if (text.startsWith("/start")) {
      const parts = text.trim().split(" ");
      const param = parts[1] || "";

      if (param.startsWith("ref_")) {
        await sendWelcome(chatId, firstName);
        await processReferral(tgId, param.slice(4));
      } else {
        await sendWelcome(chatId, firstName);
      }
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
});