// supabase/functions/_shared/tg.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const BOT_TOKEN = Deno.env.get("BOT_TOKEN")!;

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function hmacSHA256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
function hex(buf: Uint8Array): string {
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface TgUser { id: number; first_name?: string; last_name?: string; username?: string }

export async function validateInitData(initData: string): Promise<TgUser> {
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
  const user: TgUser = JSON.parse(raw);
  if (!user.id) throw new Error("missing user.id");
  return user;
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type, x-telegram-bot-api-secret-token",
    },
  });
}

export function cors() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type, x-telegram-bot-api-secret-token",
    },
  });
}
