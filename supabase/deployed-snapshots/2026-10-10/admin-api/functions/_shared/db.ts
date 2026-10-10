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

export interface TelegramUserRow {
  id: string;
  telegram_id: number;
  username: string | null;
  active: boolean;
  plan: "free" | "premium";
  min_discount: 25 | 50 | 75;
  stores: StoreKey[];
  only_historical_low: boolean;
  pending_watch_game: string | null;
  pending_premium_email: string | null;
  onboarding_completed?: boolean;
}

export interface GameRow {
  id: string;
  itad_id: string;
  title: string;
  history_low_cents: number | null;
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


export async function completeOnboarding(db: DB, userId: string): Promise<void> {
  const { error } = await db.from("telegram_users").update({ onboarding_completed: true }).eq("id", userId);
  if (error) fail("concluir onboarding", error);
}

export async function completeOnboardingByTelegramId(db: DB, telegramId: number): Promise<void> {
  const { error } = await db.from("telegram_users").update({ onboarding_completed: true }).eq("telegram_id", telegramId);
  if (error) fail("concluir onboarding do admin", error);
}

export async function setPendingPremiumEmail(db: DB, userId: string, pending: string | null): Promise<void> {
  const { error } = await db.from("telegram_users").update({ pending_premium_email: pending }).eq("id", userId);
  if (error) fail("atualizar e-mail pendente do Premium", error);
}

export interface CaktoPremiumSubscriptionRow {
  id?: string;
  telegram_user_id: string;
  cakto_subscription_id: string | null;
  cakto_order_id: string | null;
  product_id: string | null;
  offer_id: string | null;
  checkout_url: string | null;
  checkout_ref: string;
  customer_email: string;
  status: string;
  current_period_end: string | null;
  last_event: string | null;
  last_event_at: string | null;
}

export async function getCaktoSubscription(db: DB, userId: string): Promise<CaktoPremiumSubscriptionRow | null> {
  const { data, error } = await db.from("cakto_premium_subscriptions").select("*").eq("telegram_user_id", userId).maybeSingle();
  if (error) fail("carregar assinatura Cakto", error);
  return data as CaktoPremiumSubscriptionRow | null;
}

export async function getCaktoSubscriptionById(db: DB, subscriptionId: string): Promise<CaktoPremiumSubscriptionRow | null> {
  const { data, error } = await db.from("cakto_premium_subscriptions").select("*").eq("cakto_subscription_id", subscriptionId).maybeSingle();
  if (error) fail("carregar assinatura Cakto pelo ID", error);
  return data as CaktoPremiumSubscriptionRow | null;
}

export async function getCaktoSubscriptionByCheckoutRef(db: DB, checkoutRef: string): Promise<CaktoPremiumSubscriptionRow | null> {
  const { data, error } = await db.from("cakto_premium_subscriptions").select("*").eq("checkout_ref", checkoutRef).maybeSingle();
  if (error) fail("carregar assinatura Cakto pelo identificador do checkout", error);
  return data as CaktoPremiumSubscriptionRow | null;
}

export async function getCaktoSubscriptionByEmail(db: DB, email: string): Promise<CaktoPremiumSubscriptionRow | null> {
  const { data, error } = await db.from("cakto_premium_subscriptions").select("*").eq("customer_email", email.toLowerCase()).limit(2);
  if (error) fail("carregar assinatura Cakto pelo e-mail", error);
  const rows = (data ?? []) as CaktoPremiumSubscriptionRow[];
  // E-mail não é uma identidade forte: se houver mais de uma assinatura com
  // o mesmo e-mail, nunca adivinhe qual usuário deve receber o plano.
  return rows.length === 1 ? rows[0] : null;
}

export async function getUserByPendingPremiumEmail(db: DB, email: string): Promise<{ id: string; telegram_id: number } | null> {
  const { data, error } = await db.from("telegram_users").select("id, telegram_id").eq("pending_premium_email", email.toLowerCase()).limit(2);
  if (error) fail("localizar usuário pelo e-mail do Premium", error);
  const rows = (data ?? []) as { id: string; telegram_id: number }[];
  // O fallback por e-mail só é seguro quando há um único candidato pendente.
  return rows.length === 1 ? rows[0] : null;
}

export async function createOrUpdateCaktoPendingSubscription(db: DB, params: {
  userId: string;
  customerEmail: string;
  checkoutUrl: string;
  checkoutRef: string;
}): Promise<void> {
  const { error } = await db.from("cakto_premium_subscriptions").upsert({
    telegram_user_id: params.userId,
    customer_email: params.customerEmail.toLowerCase(),
    checkout_url: params.checkoutUrl,
    checkout_ref: params.checkoutRef,
    status: "pending",
    last_event: "checkout_created",
    last_event_at: new Date().toISOString(),
  }, { onConflict: "telegram_user_id" });
  if (error) fail("salvar checkout Premium da Cakto", error);
}

export async function upsertCaktoSubscription(db: DB, params: {
  userId: string;
  subscriptionId?: string | null;
  orderId?: string | null;
  productId?: string | null;
  offerId?: string | null;
  customerEmail: string;
  checkoutUrl?: string | null;
  checkoutRef?: string | null;
  status: string;
  currentPeriodEnd?: string | null;
  lastEvent: string;
}): Promise<void> {
  const { error } = await db.from("cakto_premium_subscriptions").upsert({
    telegram_user_id: params.userId,
    cakto_subscription_id: params.subscriptionId ?? null,
    cakto_order_id: params.orderId ?? null,
    product_id: params.productId ?? null,
    offer_id: params.offerId ?? null,
    customer_email: params.customerEmail.toLowerCase(),
    checkout_url: params.checkoutUrl ?? null,
    checkout_ref: params.checkoutRef ?? undefined,
    status: params.status,
    current_period_end: params.currentPeriodEnd ?? null,
    last_event: params.lastEvent,
    last_event_at: new Date().toISOString(),
  }, { onConflict: "telegram_user_id" });
  if (error) fail("salvar assinatura Cakto", error);
}

export async function claimCaktoWebhookEvent(db: DB, eventKey: string, eventType: string, orderId: string | null, subscriptionId: string | null): Promise<boolean> {
  const { data, error } = await db.from("cakto_webhook_events").insert({
    event_key: eventKey,
    event_type: eventType,
    order_id: orderId,
    subscription_id: subscriptionId,
  }).select("event_key");
  if (error && !String(error.message).toLowerCase().includes("duplicate") && !String(error.code ?? "").includes("23505")) fail("reservar webhook Cakto", error);
  return (data ?? []).length > 0;
}

export async function markCaktoWebhookEventProcessed(db: DB, eventKey: string): Promise<void> {
  const { error } = await db.from("cakto_webhook_events").update({ processed_at: new Date().toISOString() }).eq("event_key", eventKey);
  if (error) fail("marcar webhook Cakto", error);
}

export async function releaseCaktoWebhookEvent(db: DB, eventKey: string): Promise<void> {
  const { error } = await db.from("cakto_webhook_events").delete().eq("event_key", eventKey);
  if (error) fail("liberar webhook Cakto", error);
}

export async function expirePremiumSubscriptions(db: DB): Promise<number> {
  const { data, error } = await db.rpc("expire_premium_subscriptions");
  if (error) {
    const cakto = await db.rpc("expire_cakto_premium_subscriptions");
    if (cakto.error) fail("expirar assinaturas Premium", cakto.error);
    return Number(cakto.data ?? 0);
  }
  const cakto = await db.rpc("expire_cakto_premium_subscriptions");
  if (cakto.error) fail("expirar assinaturas Premium Cakto", cakto.error);
  return Number(data ?? 0) + Number(cakto.data ?? 0);
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

export async function upsertUserGameWithLimit(db: DB, params: { userId: string; gameId: string; targetPriceCents?: number | null; targetDiscount?: number | null }): Promise<boolean> {
  const { data, error } = await db.rpc("upsert_user_game_with_limit", {
    p_user_id: params.userId,
    p_game_id: params.gameId,
    p_target_price_cents: params.targetPriceCents ?? null,
    p_target_discount: params.targetDiscount ?? null,
  });
  if (error) fail("adicionar jogo à watchlist com limite", error);
  return Boolean(data);
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

export interface AdminConfigRow {
  telegram_id: number;
  username: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export async function getAdminConfig(db: DB): Promise<AdminConfigRow | null> {
  const { data, error } = await db.from("admin_config")
    .select("telegram_id, username, password_hash, created_at, updated_at")
    .eq("id", true)
    .maybeSingle();
  if (error) fail("carregar configuração admin", error);
  return (data as AdminConfigRow | null) ?? null;
}

export async function createAdminConfig(db: DB, params: { telegramId: number; username: string; passwordHash: string }): Promise<boolean> {
  const { data, error } = await db.rpc("initialize_admin_config", {
    p_telegram_id: params.telegramId,
    p_username: params.username,
    p_password_hash: params.passwordHash,
  });
  if (error) fail("criar configuração admin", error);
  return Boolean(data);
}

export async function completeAdminSetup(db: DB, params: { tokenHash: string; username: string; passwordHash: string }): Promise<number | null> {
  const { data, error } = await db.rpc("complete_admin_setup", {
    p_token_hash: params.tokenHash,
    p_username: params.username,
    p_password_hash: params.passwordHash,
  });
  if (error) fail("concluir configuração admin", error);
  if (data === null || data === undefined) return null;
  const parsed = Number(data);
  if (parsed === 0) return 0;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function createAdminSetupChallenge(db: DB, telegramId: number, tokenHash: string, expiresAt: string): Promise<void> {
  const { error: invalidateError } = await db.from("admin_setup_challenges")
    .update({ used_at: new Date().toISOString() })
    .eq("telegram_id", telegramId)
    .is("used_at", null);
  if (invalidateError) fail("invalidar setup admin anterior", invalidateError);
  const { error } = await db.from("admin_setup_challenges").insert({
    telegram_id: telegramId,
    token_hash: tokenHash,
    expires_at: expiresAt,
  });
  if (error) fail("criar setup admin", error);
}

export async function consumeAdminSetupChallenge(db: DB, tokenHash: string): Promise<number | null> {
  const { data, error } = await db.rpc("consume_admin_setup_challenge", {
    p_token_hash: tokenHash,
    p_max_attempts: 5,
  });
  if (error) fail("validar setup admin", error);
  if (data === null || data === undefined) return null;
  const parsed = Number(data);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function createAdminChallenge(db: DB, telegramId: number, codeHash: string, expiresAt: string): Promise<void> {
  const { error: invalidateError } = await db.from("admin_login_challenges")
    .update({ used_at: new Date().toISOString() })
    .eq("telegram_id", telegramId)
    .is("used_at", null);
  if (invalidateError) fail("invalidar challenge admin anterior", invalidateError);
  const { error } = await db.from("admin_login_challenges").insert({
    telegram_id: telegramId,
    code_hash: codeHash,
    expires_at: expiresAt,
  });
  if (error) fail("criar challenge admin", error);
}

export async function consumeAdminChallenge(db: DB, telegramId: number, codeHash: string): Promise<boolean> {
  const { data, error } = await db.rpc("consume_admin_login_challenge", {
    p_telegram_id: telegramId,
    p_code_hash: codeHash,
    p_max_attempts: 5,
  });
  if (error) fail("validar challenge admin", error);
  return Boolean(data);
}

export async function createAdminSession(db: DB, params: { telegramId: number; sessionHash: string; csrfHash: string; authVersion: string; expiresAt: string }): Promise<void> {
  const { error: revokeError } = await db.from("admin_sessions").update({ revoked_at: new Date().toISOString() }).eq("telegram_id", params.telegramId).is("revoked_at", null);
  if (revokeError) fail("revogar sessões admin anteriores", revokeError);
  const { error } = await db.from("admin_sessions").insert({
    telegram_id: params.telegramId,
    session_hash: params.sessionHash,
    csrf_hash: params.csrfHash,
    auth_version: params.authVersion,
    expires_at: params.expiresAt,
  });
  if (error) fail("criar sessão admin", error);
}

export async function getAdminSession(db: DB, sessionHash: string): Promise<{ id: string; telegram_id: number; csrf_hash: string; auth_version: string; expires_at: string } | null> {
  const { data, error } = await db.from("admin_sessions")
    .select("id, telegram_id, csrf_hash, auth_version, expires_at")
    .eq("session_hash", sessionHash)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) fail("carregar sessão admin", error);
  if (!data) return null;
  await db.from("admin_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", data.id);
  return data as { id: string; telegram_id: number; csrf_hash: string; auth_version: string; expires_at: string };
}

export async function revokeAdminSession(db: DB, sessionHash: string): Promise<void> {
  const { error } = await db.from("admin_sessions").update({ revoked_at: new Date().toISOString() }).eq("session_hash", sessionHash);
  if (error) fail("revogar sessão admin", error);
}

export async function adminAudit(db: DB, actorTelegramId: number, action: string, targetUserId: string | null = null, metadata: Record<string, unknown> = {}): Promise<void> {
  const { error } = await db.from("admin_audit_log").insert({
    actor_telegram_id: actorTelegramId,
    action,
    target_user_id: targetUserId,
    metadata,
  });
  if (error) fail("registrar auditoria admin", error);
}

export async function listUsers(db: DB, search: string, limit: number, offset: number): Promise<{ rows: TelegramUserRow[]; total: number }> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const safeOffset = Math.max(offset, 0);
  let query = db.from("telegram_users").select("*", { count: "exact" }).order("created_at", { ascending: false }).range(safeOffset, safeOffset + safeLimit - 1);
  const term = search.trim().slice(0, 100);
  if (term) {
    // `.or()` receives a PostgREST filter expression, então a entrada precisa
    // ser reduzida a um conjunto de caracteres simples para não permitir
    // injeção de operadores/filtros.
    const safeTerm = term.replace(/[^\p{L}\p{N} @._-]/gu, " ").trim();
    if (safeTerm) {
      const escaped = safeTerm.replace(/%/g, "\\%").replace(/_/g, "\\_");
      query = query.or(`username.ilike.%${escaped}%,first_name.ilike.%${escaped}%,last_name.ilike.%${escaped}%`);
    }
  }
  const { data, error, count } = await query;
  if (error) fail("listar usuários", error);
  return { rows: (data ?? []) as TelegramUserRow[], total: count ?? 0 };
}

export async function getUserById(db: DB, userId: string): Promise<TelegramUserRow | null> {
  const { data, error } = await db.from("telegram_users").select("*").eq("id", userId).maybeSingle();
  if (error) fail("carregar usuário", error);
  return (data as TelegramUserRow | null) ?? null;
}

export async function getUserIdByTelegramId(db: DB, telegramId: number): Promise<string | null> {
  const { data, error } = await db.from("telegram_users").select("id").eq("telegram_id", telegramId).maybeSingle();
  if (error) fail("localizar usuário administrador", error);
  return (data as { id: string } | null)?.id ?? null;
}

export async function setUserPlan(db: DB, userId: string, plan: "free" | "premium"): Promise<void> {
  const { error } = await db.from("telegram_users").update({ plan }).eq("id", userId);
  if (error) fail("alterar plano do usuário", error);
}

export async function getStats(db: DB): Promise<{ totalUsers: number; activeUsers: number; premiumUsers: number; monitoredGames: number }> {
  const [total, active, premium, monitored] = await Promise.all([
    db.from("telegram_users").select("id", { count: "exact", head: true }),
    db.from("telegram_users").select("id", { count: "exact", head: true }).eq("active", true),
    db.from("telegram_users").select("id", { count: "exact", head: true }).eq("plan", "premium"),
    db.from("user_games").select("id", { count: "exact", head: true }).eq("notify_enabled", true),
  ]);
  for (const item of [total, active, premium, monitored]) if (item.error) fail("carregar estatísticas", item.error);
  return {
    totalUsers: total.count ?? 0,
    activeUsers: active.count ?? 0,
    premiumUsers: premium.count ?? 0,
    monitoredGames: monitored.count ?? 0,
  };
}
