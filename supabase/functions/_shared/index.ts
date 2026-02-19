// supabase/functions/_shared/index.ts
// This is a helper-only folder for shared code imports.
// Deploying it is optional. If you deploy it, it will simply return OK.
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { cors, json } from "./tg.ts";

serve((req) => {
  if (req.method === "OPTIONS") return cors();
  return json({ ok: true, note: "_shared helper" });
});
