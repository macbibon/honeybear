// supabase/functions/_shared/bot.ts

export type TgInlineKeyboard = {
  inline_keyboard: Array<Array<Record<string, unknown>>>;
};

function mustEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export function getBotToken(): string {
  return mustEnv("BOT_TOKEN");
}

export function getMiniAppUrl(): string {
  // Preferred: explicit MINIAPP_URL (your Vercel/Host URL or t.me deep-link)
  const explicit = Deno.env.get("MINIAPP_URL");
  if (explicit) return explicit;

  // Fallback: BOT_USERNAME => https://t.me/<bot>/app
  const username = Deno.env.get("BOT_USERNAME") || "";
  if (!username) throw new Error("Missing env: MINIAPP_URL or BOT_USERNAME");
  return `https://t.me/${username}/app`;
}

export async function tgSendMessage(args: {
  chat_id: number;
  text: string;
  reply_markup?: TgInlineKeyboard;
  disable_web_page_preview?: boolean;
}): Promise<void> {
  const token = getBotToken();
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: args.chat_id,
      text: args.text,
      disable_web_page_preview: args.disable_web_page_preview ?? true,
      reply_markup: args.reply_markup,
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${res.status} ${t}`);
  }
}

export function openGameKeyboard(): TgInlineKeyboard {
  const url = getMiniAppUrl();
  return {
    inline_keyboard: [[{ text: "Открыть игру", web_app: { url } }]],
  };
}
