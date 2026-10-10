import * as db from "../_shared/db.ts";
import { amountToCents, nextPeriodEnd } from "../_shared/billing.ts";
import type { TelegramLike } from "../_shared/telegram.ts";

export interface CaktoWebhookDeps {
  supabase: db.DB;
  telegram: TelegramLike;
  webhookSecret: string;
  premiumProductId: string;
  premiumOfferId: string;
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const out = value.trim();
  return out ? out : null;
}

function nested(root: Json, path: string[]): unknown {
  let current: unknown = root;
  for (const part of path) {
    const obj = asObject(current);
    if (!obj) return null;
    current = obj[part];
  }
  return current;
}

function field(root: Json, ...paths: string[][]): string | null {
  for (const path of paths) {
    const found = text(nested(root, path));
    if (found) return found;
  }
  return null;
}

function parseRecurrenceDays(root: Json): number {
  const raw = nested(root, ["data", "subscription", "recurrence_period"]);
  const days = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(days) && days > 0 ? Math.round(days) : 30;
}

function parseCustomerEmail(root: Json): string | null {
  return field(root, ["data", "customer", "email"], ["customer", "email"]);
}

function parseEventId(root: Json): string | null {
  return field(root, ["data", "id"], ["id"]);
}

function parseOrderId(root: Json): string | null {
  return field(root, ["data", "refId"], ["data", "id"], ["refId"], ["id"]);
}

function parseSubscriptionId(root: Json): string | null {
  return field(root, ["data", "subscription", "id"], ["subscription", "id"]);
}

function parseProductId(root: Json): string | null {
  return field(root, ["data", "product", "id"], ["product", "id"]);
}

function parseOfferId(root: Json): string | null {
  return field(root, ["data", "offer", "id"], ["offer", "id"]);
}

function parseAmountCents(root: Json): number | null {
  return amountToCents(nested(root, ["data", "subscription", "amount"]) ?? nested(root, ["data", "amount"]));
}

function parseEvent(root: Json): string | null {
  return field(root, ["event"], ["data", "event"]);
}

function parseTrackingCode(root: Json): string | null {
  return field(root,
    ["data", "src"],
    ["data", "sck"],
    ["data", "tracking", "src"],
    ["data", "tracking", "sck"],
    ["src"],
    ["sck"],
  );
}

function currentPeriodEnd(root: Json, recurrenceDays: number): string {
  const explicit = field(root,
    ["data", "subscription", "current_period_end"],
    ["data", "subscription", "currentPeriodEnd"],
    ["data", "subscription", "next_payment_date"],
    ["data", "subscription", "nextPaymentDate"],
    ["data", "next_payment_date"],
  );
  if (explicit) {
    const date = new Date(explicit);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const paidAt = field(root, ["data", "paidAt"], ["data", "paid_at"], ["paidAt"]);
  const base = paidAt ? new Date(paidAt) : new Date();
  return nextPeriodEnd(Number.isNaN(base.getTime()) ? new Date() : base, recurrenceDays);
}

function secretMatches(req: Request, body: Json, expected: string): boolean {
  const headerCandidates = [
    req.headers.get("x-cakto-webhook-secret"),
    req.headers.get("x-webhook-secret"),
    req.headers.get("x-cakto-secret"),
  ];
  return headerCandidates.some((value) => value === expected) || body.secret === expected;
}

export function createCaktoWebhookHandler(deps: CaktoWebhookDeps) {
  const { supabase, telegram, webhookSecret, premiumProductId, premiumOfferId } = deps;

  return async function handleRequest(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    let body: Json;
    try {
      body = await req.json() as Json;
    } catch {
      return new Response("bad request", { status: 400 });
    }

    if (!secretMatches(req, body, webhookSecret)) return new Response("unauthorized", { status: 401 });

    const event = parseEvent(body);
    const eventId = parseEventId(body);
    if (!event || !eventId) return new Response("bad request", { status: 400 });

    const orderId = parseOrderId(body);
    const subscriptionId = parseSubscriptionId(body);
    const productId = parseProductId(body);
    const offerId = parseOfferId(body);
    const eventKey = `${event}:${eventId}:${subscriptionId ?? ""}`.slice(0, 450);
    // purchase_approved precisa sempre bater no produto/oferta configurado.
    // Nos eventos seguintes a Cakto pode omitir product/offer; nesse caso
    // aceitamos o evento somente se já conhecemos a assinatura como Premium.
    let knownPremiumSubscription = false;
    if (event !== "purchase_approved") {
      if (subscriptionId) knownPremiumSubscription = !!(await db.getCaktoSubscriptionBySubscriptionId(supabase, subscriptionId));
      if (!knownPremiumSubscription && orderId) knownPremiumSubscription = !!(await db.getCaktoSubscriptionByOrderId(supabase, orderId));
    }
    if (!matchesPremium(productId, offerId, premiumProductId, premiumOfferId) && !knownPremiumSubscription) {
      console.warn(JSON.stringify({ event: "cakto_unmapped_product", webhookEvent: event, productId, offerId, subscriptionId, orderId }));
      return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200, headers: { "content-type": "application/json" } });
    }

    const { isNew, processed } = await db.beginCaktoWebhookEvent(supabase, eventKey, event, orderId, subscriptionId);
    if (!isNew && processed) return new Response(JSON.stringify({ ok: true, duplicate: true }), { status: 200, headers: { "content-type": "application/json" } });

    try {
      if (event === "purchase_approved") await onPurchaseApproved(body, { orderId, subscriptionId, productId, offerId });
      else if (event === "subscription_renewed") await onSubscriptionRenewed(body, { orderId, subscriptionId, productId, offerId });
      else if (event === "subscription_canceled") await onSubscriptionCanceled(body, { subscriptionId });
      else if (event === "refund" || event === "chargeback") await onReversal(body, event, { orderId, subscriptionId });
      else if (event === "purchase_refused") { /* sem alteração de acesso */ }
      else { /* evento válido, porém não usado pelo GameSignal */ }
      await db.markCaktoWebhookProcessed(supabase, eventKey);
      return ok();
    } catch (error) {
      console.error(JSON.stringify({ event: "cakto_webhook_error", webhookEvent: event, error: error instanceof Error ? error.message : "unknown" }));
      return new Response(JSON.stringify({ error: "temporary error" }), { status: 500, headers: { "content-type": "application/json" } });
    }
  };

  async function onPurchaseApproved(body: Json, ids: { orderId: string | null; subscriptionId: string | null; productId: string | null; offerId: string | null }): Promise<void> {
    const { orderId, subscriptionId, productId, offerId } = ids;
    const email = parseCustomerEmail(body);
    if (!email) throw new Error("compra Cakto sem e-mail do cliente");
    const recurrenceDays = parseRecurrenceDays(body);
    const periodEnd = currentPeriodEnd(body, recurrenceDays);
    const subscriptionStatus = text(nested(body, ["data", "subscription", "status"])) ?? "active";
    const trackingCode = parseTrackingCode(body);
    const pendingByTracking = trackingCode ? await db.findPendingCaktoCheckoutByTrackingCode(supabase, trackingCode) : null;
    const pending = pendingByTracking ?? await db.findPendingCaktoCheckoutByEmail(supabase, email);
    let subscription = subscriptionId ? await db.getCaktoSubscriptionBySubscriptionId(supabase, subscriptionId) : null;
    if (!subscription && pending) {
      await db.markCaktoCheckoutPaid(supabase, pending.id, orderId, subscriptionId);
      await db.activatePremium(supabase, pending.telegram_user_id, periodEnd, email);
      await db.upsertCaktoSubscription(supabase, {
        userId: pending.telegram_user_id,
        subscriptionId,
        orderId,
        productId,
        offerId,
        customerEmail: email,
        status: subscriptionStatus,
        currentPeriodEnd: periodEnd,
        amountCents: parseAmountCents(body),
        recurrenceDays,
        event: "purchase_approved",
      });
      subscription = await db.getCaktoSubscriptionBySubscriptionId(supabase, subscriptionId ?? "");
      await notifyUser(pending.telegram_user_id, "⭐ <b>Pronto! Seu Premium foi ativado.</b>\n\nAgora você pode monitorar até 30 jogos e usar o filtro de menor preço histórico. Aproveita! 🎮");
      return;
    }
    if (subscription) {
      await db.activatePremium(supabase, subscription.telegram_user_id, periodEnd, email);
      await db.upsertCaktoSubscription(supabase, {
        userId: subscription.telegram_user_id,
        subscriptionId,
        orderId,
        productId,
        offerId,
        customerEmail: email,
        status: subscriptionStatus,
        currentPeriodEnd: periodEnd,
        amountCents: parseAmountCents(body),
        recurrenceDays,
        event: "purchase_approved",
      });
    }
  }

  async function onSubscriptionRenewed(body: Json, ids: { orderId: string | null; subscriptionId: string | null; productId: string | null; offerId: string | null }): Promise<void> {
    const { orderId, subscriptionId, productId, offerId } = ids;
    if (!subscriptionId) return;
    const existing = await db.getCaktoSubscriptionBySubscriptionId(supabase, subscriptionId);
    if (!existing) return;
    const recurrenceDays = parseRecurrenceDays(body);
    const email = parseCustomerEmail(body) ?? existing.customer_email;
    const periodEnd = currentPeriodEnd(body, recurrenceDays);
    await db.activatePremium(supabase, existing.telegram_user_id, periodEnd, email);
    await db.upsertCaktoSubscription(supabase, {
      userId: existing.telegram_user_id,
      subscriptionId,
      orderId,
      productId,
      offerId,
      customerEmail: email,
      status: "active",
      currentPeriodEnd: periodEnd,
      amountCents: parseAmountCents(body),
      recurrenceDays,
      event: "subscription_renewed",
    });
    await notifyUser(existing.telegram_user_id, `✅ <b>Renovação confirmada!</b> Seu Premium continua ativo até <b>${new Date(periodEnd).toLocaleDateString("pt-BR")}</b>. 💙`);
  }

  async function onSubscriptionCanceled(body: Json, ids: { subscriptionId: string | null }): Promise<void> {
    const { subscriptionId } = ids;
    if (!subscriptionId) return;
    const existing = await db.getCaktoSubscriptionBySubscriptionId(supabase, subscriptionId);
    if (!existing) return;
    const status = text(nested(body, ["data", "subscription", "status"])) ?? "canceled";
    await db.updateCaktoSubscriptionStatus(supabase, subscriptionId, status, existing.current_period_end);
    if (existing.current_period_end && new Date(existing.current_period_end).getTime() > Date.now()) {
      await notifyUser(existing.telegram_user_id, `ℹ️ <b>Assinatura cancelada.</b> Seu Premium continua disponível até <b>${new Date(existing.current_period_end).toLocaleDateString("pt-BR")}</b>. Depois disso, sua conta volta para o Free.`);
    } else {
      await db.deactivatePremium(supabase, existing.telegram_user_id);
      await notifyUser(existing.telegram_user_id, "ℹ️ Sua assinatura foi cancelada e o Premium foi encerrado. Seu histórico de jogos continua aqui no GameSignal.");
    }
  }

  async function onReversal(body: Json, reason: string, ids: { orderId: string | null; subscriptionId: string | null }): Promise<void> {
    const { orderId, subscriptionId } = ids;
    let existing = subscriptionId ? await db.getCaktoSubscriptionBySubscriptionId(supabase, subscriptionId) : null;
    if (!existing && orderId) existing = await db.getCaktoSubscriptionByOrderId(supabase, orderId);
    if (!existing) return;
    if (subscriptionId) await db.updateCaktoSubscriptionStatus(supabase, subscriptionId, reason, new Date().toISOString());
    await db.deactivatePremium(supabase, existing.telegram_user_id);
    await notifyUser(existing.telegram_user_id, reason === "refund"
      ? "ℹ️ O pagamento do Premium foi reembolsado, então o acesso Premium foi encerrado. Seu GameSignal continua no Free."
      : "⚠️ A Cakto informou um chargeback. O acesso Premium foi encerrado até a situação ser resolvida.");
  }

  async function notifyUser(telegramUserId: string, message: string): Promise<void> {
    const { data, error } = await supabase.from("telegram_users").select("telegram_id").eq("id", telegramUserId).maybeSingle();
    if (error || !data?.telegram_id) return;
    await telegram.sendMessage(Number(data.telegram_id), message).catch((error) => {
      console.error(JSON.stringify({ event: "cakto_notification_error", error: error instanceof Error ? error.message : "unknown" }));
    });
  }

  function ok(): Response {
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }
}

export function matchesPremium(productId: string | null, offerId: string | null, premiumProductId: string, premiumOfferId: string): boolean {
  if (premiumOfferId && offerId === premiumOfferId) return true;
  if (premiumProductId && productId === premiumProductId) return true;
  return false;
}

