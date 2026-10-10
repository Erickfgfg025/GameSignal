// Camada de dados. Um só lugar com toda interação com o Postgres via
// supabase-js (client server-side, com a service role key — ignora RLS por
// definição, e é assim que a Edge Function deve acessar as tabelas: ver o
// comentário de RLS em supabase/migrations/0001_init.sql).
//
// Padrão oficial da Supabase para idempotência (INSERT ... ON CONFLICT DO
// NOTHING) é upsert(..., { ignoreDuplicates: true }).select(): quando o
// conflito acontece, a linha não muda e não volta no .select() — é assim
// que sabemos que "já existia" sem precisar de um SELECT antes (a corrida
// que a seção 23 do prompt pede para evitar).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { StoreKey } from "./itad.ts";

export type DB = SupabaseClient;

export type Plan = "free" | "premium";

export interface TelegramUserRow {
  id: string;
  telegram_id: number;
  username: string | null;
  active: boolean;
  plan: Plan;
  premium_until: string | null;
  billing_email: string | null;
  pending_billing_email: string | null;
  first_name: string | null;
  last_name: string | null;
  min_discount: 25 | 50 | 75;
  stores: StoreKey[];
  only_historical_low: boolean;
  pending_watch_game: string | null;
}

export interface GameRow {
  id: string;
  itad_id: string;
  title: string;
  history_low_cents: number | null;
  history_low_checked_at: string | null;
}

export interface UserGameRow {
  id: string;
  telegram_user_id: string;
  game_id: string;
  target_price_cents: number | null;
  target_discount: number | null;
  notify_enabled: boolean;
}

function fail(action: string, error: { message: string }): never {
  throw new Error(`falha ao ${action}: ${error.message}`);
}

/** Cria o usuário no primeiro contato, ou só atualiza os dados de perfil do
 * Telegram (nome/username podem mudar) sem tocar nas preferências. */
export async function getOrCreateUser(db: DB, tg: { id: number; username?: string; first_name?: string; last_name?: string; language_code?: string }): Promise<TelegramUserRow> {
  const { data, error } = await db
    .from("telegram_users")
    .upsert(
      { telegram_id: tg.id, username: tg.username ?? null, first_name: tg.first_name ?? null, last_name: tg.last_name ?? null, language_code: tg.language_code ?? null, active: true },
      { onConflict: "telegram_id" },
    )
    .select()
    .single();
  if (error) fail("criar/atualizar usuário", error);
  return data as TelegramUserRow;
}




export function isPremiumActive(user: Pick<TelegramUserRow, "plan" | "premium_until">): boolean {
  return user.plan === "premium" && !!user.premium_until && new Date(user.premium_until).getTime() > Date.now();
}

export async function setPendingBillingEmail(db: DB, userId: string, email: string | null): Promise<void> {
  const { error } = await db.from("telegram_users").update({ pending_billing_email: email }).eq("id", userId);
  if (error) fail("atualizar e-mail pendente do checkout", error);
}

export async function createCaktoCheckoutSession(db: DB, userId: string, email: string): Promise<{ id: string; checkoutToken: string; trackingCode: string }> {
  const checkoutToken = crypto.randomUUID().replace(/-/g, "");
  const trackingCode = `gs_${checkoutToken.slice(0, 24)}`;
  const { data, error } = await db.from("cakto_checkout_sessions").insert({
    telegram_user_id: userId,
    checkout_token: checkoutToken,
    tracking_code: trackingCode,
    customer_email: email.toLowerCase(),
  }).select("id, checkout_token, tracking_code").single();
  if (error) fail("criar sessão de checkout Cakto", error);
  return { id: String(data.id), checkoutToken: String(data.checkout_token), trackingCode: String(data.tracking_code) };
}

export async function findPendingCaktoCheckoutByTrackingCode(db: DB, trackingCode: string): Promise<{ id: string; telegram_user_id: string; customer_email: string; tracking_code: string } | null> {
  const { data, error } = await db.from("cakto_checkout_sessions")
    .select("id, telegram_user_id, customer_email, tracking_code")
    .eq("status", "pending")
    .eq("tracking_code", trackingCode)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) fail("localizar checkout Cakto pelo rastreamento", error);
  return data as { id: string; telegram_user_id: string; customer_email: string; tracking_code: string } | null;
}

export async function findPendingCaktoCheckoutByEmail(db: DB, email: string): Promise<{ id: string; telegram_user_id: string; customer_email: string } | null> {
  const { data, error } = await db.from("cakto_checkout_sessions")
    .select("id, telegram_user_id, customer_email")
    .eq("status", "pending")
    .ilike("customer_email", email.toLowerCase())
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) fail("localizar checkout Cakto", error);
  return data as { id: string; telegram_user_id: string; customer_email: string } | null;
}

export async function getCaktoSubscriptionBySubscriptionId(db: DB, subscriptionId: string): Promise<{ id: string; telegram_user_id: string; status: string; current_period_end: string | null; customer_email: string } | null> {
  const { data, error } = await db.from("cakto_subscriptions")
    .select("id, telegram_user_id, status, current_period_end, customer_email")
    .eq("cakto_subscription_id", subscriptionId)
    .maybeSingle();
  if (error) fail("localizar assinatura Cakto", error);
  return data as { id: string; telegram_user_id: string; status: string; current_period_end: string | null; customer_email: string } | null;
}

export async function getCaktoSubscriptionByOrderId(db: DB, orderId: string): Promise<{ id: string; telegram_user_id: string; status: string; current_period_end: string | null; customer_email: string } | null> {
  const { data, error } = await db.from("cakto_subscriptions")
    .select("id, telegram_user_id, status, current_period_end, customer_email")
    .eq("cakto_order_id", orderId)
    .maybeSingle();
  if (error) fail("localizar assinatura pelo pedido Cakto", error);
  return data as { id: string; telegram_user_id: string; status: string; current_period_end: string | null; customer_email: string } | null;
}

export async function beginCaktoWebhookEvent(db: DB, eventKey: string, eventType: string, orderId: string | null, subscriptionId: string | null): Promise<{ isNew: boolean; processed: boolean }> {
  const { error } = await db.from("cakto_webhook_events").insert({
    event_key: eventKey, event_type: eventType, order_id: orderId, subscription_id: subscriptionId, processed_at: null,
  });
  if (!error) return { isNew: true, processed: false };

  // Evento já recebido: só considere finalizado quando processed_at estiver preenchido.
  const { data, error: readError } = await db.from("cakto_webhook_events")
    .select("processed_at")
    .eq("event_key", eventKey)
    .maybeSingle();
  if (readError) fail("consultar estado do evento Cakto", readError);
  return { isNew: false, processed: !!data?.processed_at };
}

export async function markCaktoWebhookProcessed(db: DB, eventKey: string): Promise<void> {
  const { error } = await db.from("cakto_webhook_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("event_key", eventKey);
  if (error) fail("marcar evento Cakto como processado", error);
}

export async function markCaktoCheckoutPaid(db: DB, checkoutId: string, orderId: string | null, subscriptionId: string | null): Promise<void> {
  const { error } = await db.from("cakto_checkout_sessions").update({
    status: "paid",
    cakto_order_id: orderId,
    cakto_subscription_id: subscriptionId,
    completed_at: new Date().toISOString(),
  }).eq("id", checkoutId);
  if (error) fail("marcar checkout Cakto como pago", error);
}

export async function upsertCaktoSubscription(db: DB, input: {
  userId: string;
  subscriptionId: string | null;
  orderId: string | null;
  productId: string | null;
  offerId: string | null;
  customerEmail: string;
  status: string;
  currentPeriodEnd: string | null;
  amountCents: number | null;
  recurrenceDays: number | null;
  event: string;
}): Promise<void> {
  const { error } = await db.from("cakto_subscriptions").upsert({
    telegram_user_id: input.userId,
    cakto_subscription_id: input.subscriptionId,
    cakto_order_id: input.orderId,
    product_id: input.productId,
    offer_id: input.offerId,
    customer_email: input.customerEmail.toLowerCase(),
    status: input.status,
    current_period_end: input.currentPeriodEnd,
    amount_cents: input.amountCents,
    recurrence_days: input.recurrenceDays,
    last_event: input.event,
    last_event_at: new Date().toISOString(),
  }, { onConflict: "telegram_user_id" });
  if (error) fail("salvar assinatura Cakto", error);
}

export async function activatePremium(db: DB, userId: string, until: string, email: string): Promise<void> {
  const { error } = await db.from("telegram_users").update({ plan: "premium", premium_until: until, billing_email: email.toLowerCase(), pending_billing_email: null, active: true }).eq("id", userId);
  if (error) fail("ativar Premium", error);
}

export async function deactivatePremium(db: DB, userId: string): Promise<void> {
  const { error } = await db.from("telegram_users").update({ plan: "free", premium_until: null, pending_billing_email: null }).eq("id", userId);
  if (error) fail("voltar usuário ao Free", error);
}

export async function updateCaktoSubscriptionStatus(db: DB, subscriptionId: string, status: string, currentPeriodEnd?: string | null): Promise<void> {
  const patch: Record<string, unknown> = { status, last_event_at: new Date().toISOString() };
  if (currentPeriodEnd !== undefined) patch.current_period_end = currentPeriodEnd;
  const { error } = await db.from("cakto_subscriptions").update(patch).eq("cakto_subscription_id", subscriptionId);
  if (error) fail("atualizar status da assinatura Cakto", error);
}

export async function expirePremiumUsers(db: DB): Promise<number> {
  const { data, error } = await db.rpc("expire_cakto_premium_users");
  if (error) fail("expirar planos Premium", error);
  return Number(data ?? 0);
}

export async function setUserActive(db: DB, userId: string, active: boolean): Promise<void> {
  const { error } = await db.from("telegram_users").update({ active }).eq("id", userId);
  if (error) fail("atualizar status do usuário", error);
}

export async function updateUserPrefs(db: DB, userId: string, patch: Partial<Pick<TelegramUserRow, "stores" | "min_discount" | "only_historical_low">>): Promise<TelegramUserRow> {
  const { data, error } = await db.from("telegram_users").update(patch).eq("id", userId).select().single();
  if (error) fail("atualizar preferências", error);
  return data as TelegramUserRow;
}

export async function listActiveUsers(db: DB): Promise<TelegramUserRow[]> {
  const { data, error } = await db.from("telegram_users").select("*").eq("active", true);
  if (error) fail("listar usuários ativos", error);
  return (data ?? []) as TelegramUserRow[];
}

/** Guarda "estou esperando você digitar um preço para ESTE jogo" (ou limpa,
 * com gameId null, depois que o número chega ou o usuário desiste). */
export async function setPendingWatch(db: DB, userId: string, gameId: string | null): Promise<void> {
  const { error } = await db.from("telegram_users").update({ pending_watch_game: gameId }).eq("id", userId);
  if (error) fail("atualizar jogo pendente de preço-alvo", error);
}

/** Upsert por itad_id: o mesmo jogo, visto de novo, atualiza só o título. */
export async function upsertGame(db: DB, game: { itadId: string; title: string; coverUrl?: string | null }): Promise<GameRow> {
  const { data, error } = await db
    .from("games")
    .upsert({ itad_id: game.itadId, title: game.title, cover_url: game.coverUrl ?? null }, { onConflict: "itad_id" })
    .select()
    .single();
  if (error) fail("salvar jogo", error);
  return data as GameRow;
}

export async function updateGameHistoryLow(db: DB, gameId: string, cents: number | null, currency: string | null): Promise<void> {
  const { error } = await db
    .from("games")
    .update({ history_low_cents: cents, history_low_currency: currency, history_low_checked_at: new Date().toISOString() })
    .eq("id", gameId);
  if (error) fail("atualizar menor preço histórico", error);
}

export async function upsertUserGameWithLimit(db: DB, params: { userId: string; gameId: string; targetPriceCents?: number | null; targetDiscount?: number | null; limit: number }): Promise<UserGameRow> {
  const { data, error } = await db.rpc("upsert_user_game_with_limit_v2", {
    p_user_id: params.userId,
    p_game_id: params.gameId,
    p_target_price_cents: params.targetPriceCents ?? null,
    p_target_discount: params.targetDiscount ?? null,
    p_limit: params.limit,
  });
  if (error) fail("adicionar jogo à watchlist", error);
  return data as UserGameRow;
}

export async function upsertUserGame(db: DB, params: { userId: string; gameId: string; targetPriceCents?: number | null; targetDiscount?: number | null }): Promise<UserGameRow> {
  const { data, error } = await db
    .from("user_games")
    .upsert(
      { telegram_user_id: params.userId, game_id: params.gameId, target_price_cents: params.targetPriceCents ?? null, target_discount: params.targetDiscount ?? null, notify_enabled: true },
      { onConflict: "telegram_user_id,game_id" },
    )
    .select()
    .single();
  if (error) fail("adicionar jogo à watchlist", error);
  return data as UserGameRow;
}

export async function removeUserGame(db: DB, userId: string, gameId: string): Promise<void> {
  const { error } = await db.from("user_games").delete().eq("telegram_user_id", userId).eq("game_id", gameId);
  if (error) fail("remover jogo da watchlist", error);
}

export async function listUserGames(db: DB, userId: string): Promise<(UserGameRow & { games: GameRow })[]> {
  const { data, error } = await db.from("user_games").select("*, games(*)").eq("telegram_user_id", userId).order("created_at");
  if (error) fail("listar jogos monitorados", error);
  // deno-lint-ignore no-explicit-any
  return (data ?? []) as any;
}

/** Todo game_id (UUID interno) com pelo menos 1 usuário monitorando —
 * é isso que o check-prices consulta no ITAD, 1 vez por jogo (seção 15). */
export async function distinctWatchedGames(db: DB): Promise<GameRow[]> {
  const { data, error } = await db.from("user_games").select("games(*)").eq("notify_enabled", true);
  if (error) fail("listar jogos monitorados por todos os usuários", error);
  const byId = new Map<string, GameRow>();
  // deno-lint-ignore no-explicit-any
  for (const row of (data ?? []) as any[]) if (row.games) byId.set(row.games.id, row.games);
  return [...byId.values()];
}

export async function usersWatchingGame(db: DB, gameId: string): Promise<(UserGameRow & { telegram_users: TelegramUserRow })[]> {
  const { data, error } = await db.from("user_games").select("*, telegram_users(*)").eq("game_id", gameId).eq("notify_enabled", true);
  if (error) fail("listar quem monitora o jogo", error);
  // deno-lint-ignore no-explicit-any
  return (data ?? []) as any;
}

export interface PriceRow { gameId: string; storeSlug: StoreKey; priceCents: number; regularCents: number; discountPercent: number; currency: string; url: string }

export async function upsertPriceCache(db: DB, storeIdBySlug: Record<StoreKey, number>, rows: PriceRow[]): Promise<void> {
  if (rows.length === 0) return;
  const payload = rows.map((r) => ({
    game_id: r.gameId, store_id: storeIdBySlug[r.storeSlug], price_cents: r.priceCents, regular_cents: r.regularCents,
    discount_percent: r.discountPercent, currency: r.currency, url: r.url, checked_at: new Date().toISOString(),
  }));
  const { error } = await db.from("price_cache").upsert(payload, { onConflict: "game_id,store_id" });
  if (error) fail("atualizar cache de preços", error);
}

export async function getStores(db: DB): Promise<{ idBySlug: Record<StoreKey, number>; slugById: Map<number, StoreKey> }> {
  const { data, error } = await db.from("stores").select("id, slug").eq("active", true);
  if (error) fail("carregar lojas", error);
  const idBySlug = {} as Record<StoreKey, number>;
  const slugById = new Map<number, StoreKey>();
  for (const row of (data ?? []) as { id: number; slug: StoreKey }[]) {
    idBySlug[row.slug] = row.id;
    slugById.set(row.id, row.slug);
  }
  return { idBySlug, slugById };
}

/** true = é a primeira vez que vemos ESSE update_id (deve processar);
 * false = já processamos antes (Telegram reenviou por timeout — ignora). */
export async function markUpdateProcessed(db: DB, updateId: number): Promise<boolean> {
  const { data, error } = await db.from("telegram_updates").upsert({ update_id: updateId }, { onConflict: "update_id", ignoreDuplicates: true }).select();
  if (error) fail("registrar update do Telegram", error);
  return (data ?? []).length > 0;
}

/** true = alerta inédito, pode enviar; false = essa chave já foi avisada a
 * esse usuário — não manda de novo (dedupe atômico, sem SELECT antes). */
export async function recordAlertIfNew(db: DB, userId: string, gameId: string | null, alertKey: string): Promise<boolean> {
  const { data, error } = await db
    .from("alerts")
    .upsert({ telegram_user_id: userId, game_id: gameId, alert_key: alertKey }, { onConflict: "telegram_user_id,alert_key", ignoreDuplicates: true })
    .select();
  if (error) fail("registrar alerta", error);
  return (data ?? []).length > 0;
}

export async function cleanupOldAlerts(db: DB, olderThanDays: number): Promise<void> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const { error } = await db.from("alerts").delete().lt("sent_at", cutoff);
  if (error) fail("limpar alertas antigos", error);
}

/** "Devolve" uma chave de alerta reservada quando o envio falha por um
 * motivo transitório (rede, rate limit) — sem isso, um erro passageiro do
 * Telegram suprimiria aquele alerta para sempre, já que a chave inclui o
 * preço e o preço pode não mudar no próximo ciclo. */
export async function releaseAlert(db: DB, userId: string, alertKey: string): Promise<void> {
  const { error } = await db.from("alerts").delete().eq("telegram_user_id", userId).eq("alert_key", alertKey);
  if (error) fail("liberar alerta para nova tentativa", error);
}

export async function hasAnyPriceCache(db: DB): Promise<boolean> {
  const { count, error } = await db.from("price_cache").select("*", { count: "exact", head: true });
  if (error) fail("verificar se é o primeiro ciclo", error);
  return (count ?? 0) > 0;
}


export async function userHasGame(db: DB, userId: string, gameId: string): Promise<boolean> {
  const { count, error } = await db.from("user_games").select("id", { count: "exact", head: true }).eq("telegram_user_id", userId).eq("game_id", gameId).eq("notify_enabled", true);
  if (error) fail("verificar jogo monitorado", error);
  return (count ?? 0) > 0;
}

export async function countUserGames(db: DB, userId: string): Promise<number> {
  const { count, error } = await db.from("user_games").select("id", { count: "exact", head: true }).eq("telegram_user_id", userId).eq("notify_enabled", true);
  if (error) fail("contar jogos monitorados", error);
  return count ?? 0;
}

export async function consumeRateLimit(db: DB, subjectKey: string, bucket: string, limit: number, windowSeconds = 60): Promise<boolean> {
  const { data, error } = await db.rpc("consume_security_rate_limit", {
    p_subject_key: subjectKey,
    p_bucket: bucket,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) fail("consumir rate limit", error);
  return Boolean(data);
}


export interface PersonalWatchlistPrice {
  storeSlug: StoreKey;
  storeName: string;
  priceCents: number;
  regularCents: number;
  discountPercent: number;
  currency: string;
  url: string;
  checkedAt: string;
}

export interface PersonalWatchlistRow {
  id: string;
  gameId: string;
  title: string;
  itadId: string;
  targetPriceCents: number | null;
  targetDiscount: number | null;
  notifyEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  prices: PersonalWatchlistPrice[];
}

export async function listPersonalWatchlist(db: DB, telegramId: number): Promise<PersonalWatchlistRow[]> {
  const userId = await getUserIdByTelegramId(db, telegramId);
  if (!userId) return [];

  const [{ data: games, error: gamesError }, { data: prices, error: pricesError }] = await Promise.all([
    db.from("user_games")
      .select("id, game_id, target_price_cents, target_discount, notify_enabled, created_at, updated_at, games(id, title, itad_id)")
      .eq("telegram_user_id", userId)
      .order("created_at", { ascending: false }),
    db.from("price_cache")
      .select("game_id, price_cents, regular_cents, discount_percent, currency, url, checked_at, stores(slug, name)")
      .order("checked_at", { ascending: false }),
  ]);
  if (gamesError) fail("listar watchlist do proprietário", gamesError);
  if (pricesError) fail("carregar preços da watchlist", pricesError);

  type GameJoin = { id: string; title: string; itad_id: string };
  type GameRowRaw = {
    id: string;
    game_id: string;
    target_price_cents: number | null;
    target_discount: number | null;
    notify_enabled: boolean;
    created_at: string;
    updated_at: string;
    games: GameJoin | null;
  };
  type PriceRowRaw = {
    game_id: string;
    price_cents: number;
    regular_cents: number;
    discount_percent: number;
    currency: string;
    url: string;
    checked_at: string;
    stores: { slug: StoreKey; name: string } | null;
  };

  const byGame = new Map<string, PersonalWatchlistPrice[]>();
  for (const row of (prices ?? []) as PriceRowRaw[]) {
    if (!row.stores) continue;
    const list = byGame.get(row.game_id) ?? [];
    list.push({
      storeSlug: row.stores.slug,
      storeName: row.stores.name,
      priceCents: row.price_cents,
      regularCents: row.regular_cents,
      discountPercent: row.discount_percent,
      currency: row.currency,
      url: row.url,
      checkedAt: row.checked_at,
    });
    byGame.set(row.game_id, list);
  }

  return ((games ?? []) as GameRowRaw[])
    .filter((row) => row.games)
    .map((row) => ({
      id: row.id,
      gameId: row.game_id,
      title: row.games!.title,
      itadId: row.games!.itad_id,
      targetPriceCents: row.target_price_cents,
      targetDiscount: row.target_discount,
      notifyEnabled: row.notify_enabled,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      prices: (byGame.get(row.game_id) ?? []).sort((a, b) => a.priceCents - b.priceCents),
    }));
}

export async function removePersonalWatch(db: DB, telegramId: number, watchId: string): Promise<boolean> {
  const userId = await getUserIdByTelegramId(db, telegramId);
  if (!userId) return false;
  const { data, error } = await db.from("user_games").delete().eq("id", watchId).eq("telegram_user_id", userId).select("id");
  if (error) fail("remover monitoramento do proprietário", error);
  return (data ?? []).length > 0;
}

export async function setPersonalWatchActive(db: DB, telegramId: number, watchId: string, active: boolean): Promise<boolean> {
  const userId = await getUserIdByTelegramId(db, telegramId);
  if (!userId) return false;
  const { data, error } = await db.from("user_games")
    .update({ notify_enabled: active })
    .eq("id", watchId)
    .eq("telegram_user_id", userId)
    .select("id");
  if (error) fail("alterar status do monitoramento", error);
  return (data ?? []).length > 0;
}

export interface JobRunSummary {
  id: string;
  status: "running" | "success" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string | null;
  gamesChecked: number;
  gamesFailed: number;
  alertsSent: number;
  usersDeactivated: number;
  errorMessage: string | null;
}

export async function tryAcquireJobLock(db: DB, jobId: string, leaseSeconds = 120): Promise<string | null> {
  const { data, error } = await db.rpc("try_acquire_job_lock", { p_job_id: jobId, p_lease_seconds: leaseSeconds });
  if (error) fail("reservar lock do job", error);
  return typeof data === "string" && data.length > 0 ? data : null;
}

export async function releaseJobLock(db: DB, jobId: string, lockToken: string): Promise<void> {
  const { error } = await db.rpc("release_job_lock", { p_job_id: jobId, p_lock_token: lockToken });
  if (error) fail("liberar lock do job", error);
}

export async function startJobRun(db: DB, jobId: string): Promise<string> {
  const { data, error } = await db.from("job_runs").insert({ job_id: jobId }).select("id").single();
  if (error) fail("registrar início do job", error);
  return String(data.id);
}

export async function finishJobRun(db: DB, runId: string, summary: { status: "success" | "failed" | "skipped"; gamesChecked?: number; gamesFailed?: number; alertsSent?: number; usersDeactivated?: number; errorMessage?: string | null }): Promise<void> {
  const { error } = await db.from("job_runs").update({
    finished_at: new Date().toISOString(),
    status: summary.status,
    games_checked: summary.gamesChecked ?? 0,
    games_failed: summary.gamesFailed ?? 0,
    alerts_sent: summary.alertsSent ?? 0,
    users_deactivated: summary.usersDeactivated ?? 0,
    error_message: summary.errorMessage ?? null,
  }).eq("id", runId);
  if (error) fail("registrar fim do job", error);
}

export async function cleanupOperationalData(db: DB): Promise<void> {
  const jobsCutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const updatesCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [{ error: jobsError }, { error: updatesError }] = await Promise.all([
    db.from("job_runs").delete().lt("started_at", jobsCutoff),
    db.from("telegram_updates").delete().lt("processed_at", updatesCutoff),
  ]);
  if (jobsError) fail("limpar execuções antigas", jobsError);
  if (updatesError) fail("limpar updates antigos", updatesError);
}

export async function getLatestJobRun(db: DB, jobId: string): Promise<JobRunSummary | null> {
  const { data, error } = await db.from("job_runs")
    .select("id, status, started_at, finished_at, games_checked, games_failed, alerts_sent, users_deactivated, error_message")
    .eq("job_id", jobId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) fail("carregar última execução", error);
  if (!data) return null;
  return {
    id: data.id,
    status: data.status,
    startedAt: data.started_at,
    finishedAt: data.finished_at,
    gamesChecked: data.games_checked,
    gamesFailed: data.games_failed,
    alertsSent: data.alerts_sent,
    usersDeactivated: data.users_deactivated,
    errorMessage: data.error_message,
  };
}

export async function getPersonalDashboard(db: DB, telegramId: number): Promise<{
  monitoredGames: number;
  activeMonitors: number;
  alerts30d: number;
  lastJob: JobRunSummary | null;
}> {
  const userId = await getUserIdByTelegramId(db, telegramId);
  if (!userId) return { monitoredGames: 0, activeMonitors: 0, alerts30d: 0, lastJob: await getLatestJobRun(db, "check-prices") };
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [{ count: total }, { count: active }, { count: alerts }] = await Promise.all([
    db.from("user_games").select("id", { count: "exact", head: true }).eq("telegram_user_id", userId),
    db.from("user_games").select("id", { count: "exact", head: true }).eq("telegram_user_id", userId).eq("notify_enabled", true),
    db.from("alerts").select("id", { count: "exact", head: true }).eq("telegram_user_id", userId).gte("sent_at", cutoff),
  ]);
  return { monitoredGames: total ?? 0, activeMonitors: active ?? 0, alerts30d: alerts ?? 0, lastJob: await getLatestJobRun(db, "check-prices") };
}

export async function getUserByTelegramId(db: DB, telegramId: number): Promise<TelegramUserRow | null> {
  const { data, error } = await db.from("telegram_users").select("*").eq("telegram_id", telegramId).maybeSingle();
  if (error) fail("localizar usuário", error);
  return (data as TelegramUserRow | null) ?? null;
}

export async function getUserIdByTelegramId(db: DB, telegramId: number): Promise<string | null> {
  const { data, error } = await db.from("telegram_users").select("id").eq("telegram_id", telegramId).maybeSingle();
  if (error) fail("localizar usuário pelo Telegram", error);
  return (data as { id: string } | null)?.id ?? null;
}
