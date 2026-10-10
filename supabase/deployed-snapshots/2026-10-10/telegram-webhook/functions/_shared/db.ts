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
}

export interface GameRow {
  id: string;
  itad_id: string;
  title: string;
  cover_url?: string | null;
  synopsis?: string | null;
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

/** Rate limit atomically through the internal database RPC. */
export async function consumeRateLimit(
  db: DB,
  subjectKey: string,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const { data, error } = await db.rpc("consume_security_rate_limit", {
    p_subject_key: subjectKey,
    p_bucket: bucket,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) fail("consumir limite de requisições", error);
  return data === true;
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
      { telegram_id: tg.id, username: tg.username ?? null, first_name: tg.first_name ?? null, last_name: tg.last_name ?? null, language_code: tg.language_code ?? null },
      { onConflict: "telegram_id" },
    )
    .select()
    .single();
  if (error) fail("criar/atualizar usuário", error);
  return data as TelegramUserRow;
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
  const payload: Record<string, unknown> = { itad_id: game.itadId, title: game.title };
  if (game.coverUrl !== undefined) payload.cover_url = game.coverUrl;
  const { data, error } = await db
    .from("games")
    .upsert(payload, { onConflict: "itad_id" })
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

export async function addUserGameWithPlanLimit(db: DB, params: { userId: string; gameId: string; targetPriceCents?: number | null; targetDiscount?: number | null }): Promise<boolean> {
  const { data, error } = await db.rpc("add_user_game_with_plan_limit", { p_user_id: params.userId, p_game_id: params.gameId, p_target_price_cents: params.targetPriceCents ?? null, p_target_discount: params.targetDiscount ?? null });
  if (error) fail("adicionar jogo respeitando o limite do plano", error);
  return data === true;
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

export async function unmarkUpdateProcessed(db: DB, updateId: number): Promise<void> {
  const { error } = await db.from("telegram_updates").delete().eq("update_id", updateId);
  if (error) fail("liberar update para nova tentativa", error);
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
