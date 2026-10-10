// supabase/functions/check-prices/index.ts
// Acionada pelo pg_cron (ver README). A lógica de verdade está em handler.ts.
import { createClient } from "npm:@supabase/supabase-js@2";
import { env, parseShopIds, serviceKey } from "../_shared/env.ts";
import { ItadClient } from "../_shared/itad.ts";
import { TelegramClient } from "../_shared/telegram.ts";
import { HypeClient } from "../_shared/hype.ts";
import { StoreClient } from "../_shared/storeClient.ts";
import { createCheckPricesHandler } from "./handler.ts";

Deno.serve(createCheckPricesHandler({
  supabase: createClient(env("SUPABASE_URL"), serviceKey()),
  telegram: new TelegramClient(env("TELEGRAM_BOT_TOKEN")),
  itad: new StoreClient(new ItadClient(env("ITAD_API_KEY"), { shopOverrides: parseShopIds(Deno.env.get("ITAD_SHOP_IDS") ?? "") }), new HypeClient()),
  cronSecret: env("CRON_SECRET"),
}));
