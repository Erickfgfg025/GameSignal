// supabase/functions/telegram-webhook/index.ts
// Só a fiação: constrói os clients reais e liga ao Deno.serve. A lógica de
// roteamento está em handler.ts (é o que os testes importam).
import { createClient } from "npm:@supabase/supabase-js@2";
import { env, parseShopIds, serviceKey } from "../_shared/env.ts";
import { ItadClient } from "../_shared/itad.ts";
import { TelegramClient } from "../_shared/telegram.ts";
import { HypeClient } from "../_shared/hype.ts";
import { StoreClient } from "../_shared/storeClient.ts";
import { createHandler } from "./handler.ts";

Deno.serve(createHandler({
  supabase: createClient(env("SUPABASE_URL"), serviceKey()),
  telegram: new TelegramClient(env("TELEGRAM_BOT_TOKEN")),
  itad: new StoreClient(new ItadClient(env("ITAD_API_KEY"), { shopOverrides: parseShopIds(Deno.env.get("ITAD_SHOP_IDS") ?? "") }), new HypeClient()),
  webhookSecret: env("TELEGRAM_WEBHOOK_SECRET"),
}));
