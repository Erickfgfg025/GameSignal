import { createClient } from "npm:@supabase/supabase-js@2";
import { env, secret, serviceKey } from "../_shared/env.ts";
import { TelegramClient } from "../_shared/telegram.ts";
import { createCaktoWebhookHandler } from "./handler.ts";

const premiumProductId = Deno.env.get("CAKTO_PREMIUM_PRODUCT_ID")?.trim() ?? "";
const premiumOfferId = Deno.env.get("CAKTO_PREMIUM_OFFER_ID")?.trim() ?? "";
if (!premiumProductId && !premiumOfferId) throw new Error("Configure CAKTO_PREMIUM_PRODUCT_ID ou CAKTO_PREMIUM_OFFER_ID");

Deno.serve(createCaktoWebhookHandler({
  supabase: createClient(env("SUPABASE_URL"), serviceKey()),
  telegram: new TelegramClient(env("TELEGRAM_BOT_TOKEN")),
  webhookSecret: secret("CAKTO_WEBHOOK_SECRET", 32),
  premiumProductId,
  premiumOfferId,
}));
