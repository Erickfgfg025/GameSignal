// supabase/functions/telegram-webhook/handler.ts
// Toda a lógica do webhook mora aqui, como função pura de (deps) -> handler.
// index.ts só monta os clients reais e liga ao Deno.serve — assim dá pra
// testar o roteamento inteiro com dependências falsas/reais de teste, sem
// precisar abrir porta nem ter as variáveis de ambiente de produção.
import * as db from "../_shared/db.ts";
import { ItadError } from "../_shared/itad.ts";
import { bestMatch, isExact, MAX_CANDIDATES, rank } from "../_shared/gamesearch.ts";
import {
  candidatesKeyboard, gamePricesKeyboard, gamePricesText, money, STORE_KEYS, STORE_LABELS,
} from "../_shared/format.ts";
import type { InlineKeyboardMarkup, TgCallbackQuery, TgMessage, TgUpdate } from "../_shared/telegram.ts";
import type { TelegramLike } from "../_shared/telegram.ts";
import type { ItadLike } from "../_shared/itad.ts";

export interface HandlerDeps {
  supabase: db.DB;
  telegram: TelegramLike;
  itad: ItadLike;
  webhookSecret: string;
}

const DISCOUNTS = [25, 50, 75] as const;
const COMMANDS =
  "🔎 <b>CONSULTAR UM JOGO</b>\nDigite o nome, por exemplo <code>Elden Ring</code>.\n\n" +
  "🎯 <b>CRIAR ALERTA</b>\nAbra um jogo e toque em <u>MONITORAR ESTE JOGO</u>.\n\n" +
  "⚙️ <b>/config</b> · Ajuste lojas e desconto mínimo.\n" +
  "🔥 <b>/ofertas</b> · Veja promoções dos seus filtros.\n" +
  "🎮 <b>/meusjogos</b> · Capas, sinopses e alertas ativos.\n" +
  "⏸️ <b>/pausar</b> · Pause os avisos.\n" +
  "▶️ <b>/retomar</b> · Reative os avisos.\n" +
  "❔ <b>/ajuda</b> · Abra este guia.";
const FOOTER = "<i>Preços via IsThereAnyDeal. Capas e sinopses são exibidas quando disponíveis na Steam.</i>";
const WELCOME =
  "🎮 <b>GAMESIGNAL</b>\n<u>Seu radar pessoal de preços de jogos.</u>\n\n" +
  "Compare ofertas na <b>Steam, Nuuvem, Epic Games e Green Man Gaming</b> e receba alertas quando os preços atingirem suas condições.\n\n" +
  "╭ <b>COMO COMEÇAR</b>\n" +
  "1. Envie o nome de um jogo.\n" +
  "2. Compare as lojas e abra a oferta.\n" +
  "3. Toque em <u>MONITORAR ESTE JOGO</u> para configurar seu alerta.\n╰\n\n" +
  "<b>COMANDOS PRINCIPAIS</b>\n" + COMMANDS + "\n\n" + FOOTER;
const HELP = "❔ <b>GUIA RÁPIDO</b>\n<u>O que você pode fazer</u>\n\n" + COMMANDS + "\n\n" + FOOTER;



type SearchMessageType = "text" | "photo";

async function replaceSearchMessage(deps: HandlerDeps, chatId: number, text: string, replyMarkup?: InlineKeyboardMarkup, photoUrl?: string | null): Promise<void> {
  const { data: previous } = await deps.supabase.from("telegram_search_messages")
    .select("message_id,message_type").eq("chat_id", chatId).maybeSingle();

  if (previous) {
    try {
      if (deps.telegram.deleteMessage) {
        await deps.telegram.deleteMessage(chatId, Number(previous.message_id));
      } else if (previous.message_type === "photo" && deps.telegram.editMessageCaption) {
        await deps.telegram.editMessageCaption(chatId, Number(previous.message_id), text, { replyMarkup });
        await deps.supabase.from("telegram_search_messages").update({ updated_at: new Date().toISOString() }).eq("chat_id", chatId);
        return;
      } else if (previous.message_type === "text" && deps.telegram.editMessageText) {
        await deps.telegram.editMessageText(chatId, Number(previous.message_id), text, { replyMarkup });
        await deps.supabase.from("telegram_search_messages").update({ updated_at: new Date().toISOString() }).eq("chat_id", chatId);
        return;
      }
    } catch {
      try {
        if (previous.message_type === "photo" && deps.telegram.editMessageCaption) {
          await deps.telegram.editMessageCaption(chatId, Number(previous.message_id), text, { replyMarkup });
          await deps.supabase.from("telegram_search_messages").update({ updated_at: new Date().toISOString() }).eq("chat_id", chatId);
          return;
        }
        if (previous.message_type === "text" && deps.telegram.editMessageText) {
          await deps.telegram.editMessageText(chatId, Number(previous.message_id), text, { replyMarkup });
          await deps.supabase.from("telegram_search_messages").update({ updated_at: new Date().toISOString() }).eq("chat_id", chatId);
          return;
        }
      } catch { /* mensagem antiga não pode ser alterada: envia outra e atualiza a referência */ }
    }
  }

  let sent: unknown;
  let type: SearchMessageType = "text";
  if (photoUrl && deps.telegram.sendPhoto && text.length <= 1024) {
    try {
      sent = await deps.telegram.sendPhoto(chatId, photoUrl, text, { replyMarkup });
      type = "photo";
    } catch {
      sent = await deps.telegram.sendMessage(chatId, text, { replyMarkup });
    }
  } else {
    sent = await deps.telegram.sendMessage(chatId, text, { replyMarkup });
  }
  const messageId = (sent as { message_id?: number } | undefined)?.message_id;
  if (messageId) {
    const { error } = await deps.supabase.from("telegram_search_messages").upsert({
      chat_id: chatId, message_id: messageId, message_type: type, updated_at: new Date().toISOString(),
    }, { onConflict: "chat_id" });
    if (error) console.error("não foi possível persistir a mensagem de busca", error.message);
  }
}


interface SteamGameMetadata { coverUrl: string | null; synopsis: string | null; }
function normalizeTitle(value: string): string {
  return value.toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}
function escapeGameHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function plainSteamText(value: string): string {
  return value.replace(/<br\s*\/?\s*>/gi, " ").replace(/<\/p\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\s+/g, " ").trim();
}
function isKnownLowResolutionCover(url: string | null | undefined): boolean {
  return !url || /tiny_image|capsule_(231x87|184x69|467x181)\.jpg/i.test(url);
}

function safeHttpsImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try { const url = new URL(value); return url.protocol === "https:" ? url.href : null; }
  catch { return null; }
}

async function steamGameMetadata(title: string): Promise<SteamGameMetadata | null> {
  try {
    const searchUrl = new URL("https://store.steampowered.com/api/storesearch/");
    searchUrl.searchParams.set("term", title.slice(0, 100));
    searchUrl.searchParams.set("l", "brazilian");
    searchUrl.searchParams.set("cc", "br");
    const sr = await fetch(searchUrl, { signal: AbortSignal.timeout(4000) });
    if (!sr.ok) return null;
    const items = (await sr.json())?.items;
    if (!Array.isArray(items)) return null;
    const wanted = normalizeTitle(title), wantedTokens = wanted.split(" ").filter(t => t.length > 1);
    const ranked = items.map((item: {id?: number; name?: string; tiny_image?: string}) => {
      const candidate = normalizeTitle(String(item.name ?? ""));
      const tokens = candidate.split(" ").filter(t => t.length > 1);
      const overlap = wantedTokens.filter(t => tokens.includes(t)).length;
      const score = candidate === wanted ? 1
        : (candidate.includes(wanted) || wanted.includes(candidate)) ? 0.88
        : overlap / Math.max(1, Math.max(wantedTokens.length, tokens.length));
      return { item, score };
    }).sort((a: {score:number}, b: {score:number}) => b.score-a.score);
    const best = ranked[0];
    const runnerUp = ranked[1];
    if (!best || best.score < 0.72 || (best.score < 0.99 && runnerUp && best.score - runnerUp.score < 0.12)) return null;
    const appId = Number(best.item.id);
    if (!Number.isInteger(appId) || appId <= 0) return null;
    const detailUrl = new URL("https://store.steampowered.com/api/appdetails");
    detailUrl.searchParams.set("appids", String(appId));
    detailUrl.searchParams.set("l", "brazilian");
    detailUrl.searchParams.set("cc", "br");
    const dr = await fetch(detailUrl, { signal: AbortSignal.timeout(4000) });
    if (!dr.ok) return null;
    const details = await dr.json(), data = details?.[String(appId)]?.data;
    if (!data || details?.[String(appId)]?.success !== true) return null;
    // Prefere a arte vertical da biblioteca Steam (600x900), muito mais nítida
    // como capa do jogo do que as miniaturas/cápsulas pequenas da busca.
    let coverUrl: string | null = null;
    const libraryCover = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`;
    try {
      const coverCheck = await fetch(libraryCover, { method: "HEAD", signal: AbortSignal.timeout(2500) });
      const contentType = coverCheck.headers.get("content-type") ?? "";
      if (coverCheck.ok && contentType.toLowerCase().startsWith("image/")) coverUrl = coverCheck.url || libraryCover;
    } catch { /* usa a arte oficial retornada pela API abaixo */ }
    if (!coverUrl) {
      const rawCover = data.capsule_imagev5 ?? data.header_image ?? data.capsule_image;
      coverUrl = typeof rawCover === "string" && rawCover.startsWith("https://") ? rawCover : null;
    }
    const rawSynopsis = typeof data.short_description === "string" ? data.short_description.trim() : "";
    return { coverUrl, synopsis: rawSynopsis ? plainSteamText(rawSynopsis).slice(0, 1200) || null : null };
  } catch { return null; }
}
function gameMonitorCaption(title: string, synopsis: string | null, targetPriceCents: number | null, targetDiscount: number | null): string {
  const shortSynopsis = synopsis
    ? (synopsis.length > 320 ? synopsis.slice(0, 317).trimEnd() + "…" : synopsis)
    : "Sinopse indisponível no momento. O alerta de preço continua funcionando normalmente.";
  let alert: string;
  if (targetPriceCents !== null) alert = "💰 <b>PREÇO-ALVO</b>\n" + escapeGameHtml(money(targetPriceCents, "BRL"));
  else if (targetDiscount !== null) alert = "🏷️ <b>DESCONTO MÍNIMO</b>\n" + targetDiscount + "% ou mais";
  else alert = "🔥 <b>ALERTA</b>\nQualquer promoção encontrada";
  return [
    "🎮 <b>JOGO MONITORADO</b>", "<u>" + escapeGameHtml(title) + "</u>", "",
    "📖 <b>SINOPSE</b>", "<i>" + escapeGameHtml(shortSynopsis) + "</i>", "", alert, "",
    "👇 <i>Use o botão abaixo para gerenciar este alerta.</i>",
  ].join("\n");
}

export function createHandler(deps: HandlerDeps) {
  const { supabase, telegram, itad, webhookSecret } = deps;

  return async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (req.headers.get("x-telegram-bot-api-secret-token") !== webhookSecret) {
    return new Response("unauthorized", { status: 401 });
  }

  let update: TgUpdate;
  try {
    update = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
    return new Response("bad update", { status: 400 });
  }

  try {
    const isNew = await db.markUpdateProcessed(supabase, update.update_id);
    if (!isNew) return new Response("ok (duplicado)", { status: 200 });

    if (update.message?.text) await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) {
    console.error("erro ao processar update", update.update_id, err instanceof Error ? err.message : "erro");
    try {
      await db.unmarkUpdateProcessed(supabase, update.update_id);
    } catch (cleanupError) {
      console.error("não foi possível liberar update para nova tentativa", update.update_id,
        cleanupError instanceof Error ? cleanupError.message : "erro");
    }
    return new Response("processing failed", { status: 500 });
  }
  return new Response("ok", { status: 200 });
  };

  // -------------------------------------------------------------------------
  // Mensagens de texto: comandos e busca livre.
  // -------------------------------------------------------------------------
async function handleMessage(message: TgMessage): Promise<void> {
  const chatId = message.chat.id;
  const text = message.text!.trim();
  if (message.chat.type !== "private") {
    // em grupo, chat.id (pra onde a resposta vai) é diferente de from.id (o
    // usuário de verdade) — a identidade do bot é 1 usuário = 1 chat privado,
    // então nem tenta: evita alerta indo pro lugar errado e spam no grupo.
    if (text.startsWith("/")) await telegram.sendMessage(chatId, "🔒 <b>USO EM CONVERSA PRIVADA</b>\nAbra o perfil do bot e envie uma mensagem por lá para consultar jogos e gerenciar alertas.");
    return;
  }
  const user = await db.getOrCreateUser(supabase, message.from ?? { id: chatId });

  if (text.startsWith("/start")) return void (await sendWelcome(chatId, user));
  if (text.startsWith("/ajuda") || text.startsWith("/help")) return void (await telegram.sendMessage(chatId, HELP));
  if (text.startsWith("/config")) return void (await sendConfig(chatId, user));
  if (text.startsWith("/ofertas")) {
    if (!await allowExpensiveAction(chatId, user, "offers", 2)) return;
    return void (await sendOffers(chatId, user));
  }
  if (text.startsWith("/meusjogos")) return void (await sendMyGames(chatId, user));
  if (text.startsWith("/pausar")) {
    await db.setUserActive(supabase, user.id, false);
    return void (await telegram.sendMessage(chatId, "⏸️ <b>ALERTAS PAUSADOS</b>\n\nNenhum novo aviso será enviado enquanto estiverem pausados. Use /retomar para reativá-los."));
  }
  if (text.startsWith("/retomar")) {
    await db.setUserActive(supabase, user.id, true);
    return void (await telegram.sendMessage(chatId, "▶️ <b>ALERTAS REATIVADOS</b>\n\nSeu monitoramento voltou a funcionar."));
  }
  if (text.startsWith("/jogo")) {
    const query = text.split(/\s+/).slice(1).join(" ");
    if (query.length >= 2 && !await allowExpensiveAction(chatId, user, "search", 8)) return;
    return void (await searchAndReply(chatId, query));
  }

  // sem comando: ou é um preço-alvo pendente, ou é uma busca de jogo por texto livre.
  if (user.pending_watch_game) return void (await handlePendingTarget(chatId, user, text));
  if (!await allowExpensiveAction(chatId, user, "search", 8)) return;
  await searchAndReply(chatId, text);
}

async function sendWelcome(chatId: number, user: db.TelegramUserRow): Promise<void> {
  await telegram.sendMessage(chatId, WELCOME);
  await sendConfig(chatId, user);
}

function configText(user: db.TelegramUserRow): string {
  return [
    "⚙️ <b>CONFIGURAÇÃO DOS ALERTAS</b>",
    "<u>Promoções gerais</u> · jogos que correspondem aos filtros escolhidos.",
    "",
    `🏷️ <b>DESCONTO MÍNIMO</b> · ${user.min_discount}% ou mais`,
    `📡 <b>STATUS</b> · ${user.active ? "✅ ATIVO" : "⏸️ PAUSADO"}`,
    "",
    "<i>Toque nos botões para alterar suas preferências. As mudanças são salvas automaticamente.</i>",
  ].join("\n");
}

function configKeyboard(user: db.TelegramUserRow): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  rows.push(STORE_KEYS.map((key) => ({
    text: `${user.stores.includes(key) ? "✅" : "⬜"} ${STORE_LABELS[key]}`,
    callback_data: `cfg:st:${key}`,
  })));
  rows.push(DISCOUNTS.map((pct) => ({ text: `${user.min_discount === pct ? "🔘" : "⚪"} ${pct}%+`, callback_data: `cfg:md:${pct}` })));
  rows.push([{ text: `${user.only_historical_low ? "✅" : "⬜"} Só menor preço histórico`, callback_data: "cfg:hl" }]);
  return { inline_keyboard: rows };
}

async function sendConfig(chatId: number, user: db.TelegramUserRow): Promise<void> {
  await telegram.sendMessage(chatId, configText(user), { replyMarkup: configKeyboard(user) });
}

async function sendOffers(chatId: number, user: db.TelegramUserRow): Promise<void> {
  await telegram.sendChatAction(chatId);
  let offers;
  try {
    offers = await itad.fetchOffers();
  } catch (err) {
    return void (await replaceSearchMessage(deps, chatId,
      "⚠️ <b>NÃO CONSEGUI CONSULTAR AGORA</b>\n" + escapeHtml(errorMessage(err)) + "\n\nTente novamente em instantes."));
  }

  const matching = offers
    .filter((o) => user.stores.includes(o.store) && o.cut >= user.min_discount)
    .filter((o) => !user.only_historical_low || (o.historyLowCents !== null && o.priceCents <= o.historyLowCents))
    .filter((o) => safeHttpsImageUrl(o.url) !== null)
    .sort((a, b) => b.cut - a.cut)
    .slice(0, 8);

  if (matching.length === 0) {
    return void (await replaceSearchMessage(deps, chatId,
      "🔥 <b>NENHUMA OFERTA COM ESSES FILTROS</b>\n\nReduza o desconto mínimo ou ative mais lojas em <b>/config</b>."));
  }

  await replaceSearchMessage(deps, chatId,
    "🔥 <b>MELHORES OFERTAS AGORA</b>\n<i>Ordenadas pelo maior desconto que combina com seus filtros.</i>");

  const gameIds = [...new Set(matching.map((offer) => offer.gameId))];
  const { data: cacheRows, error: cacheError } = await supabase
    .from("games").select("id, itad_id, title, cover_url, synopsis").in("itad_id", gameIds);
  if (cacheError) console.warn("não foi possível ler o cache de capas", cacheError.message);

  const cachedByGameId = new Map<string, { id: string; itad_id: string; title: string; cover_url: string | null; synopsis: string | null }>();
  for (const row of (cacheRows ?? []) as Array<{ id: string; itad_id: string; title: string; cover_url: string | null; synopsis: string | null }>) {
    cachedByGameId.set(String(row.itad_id), row);
  }

  const coverByGameId = new Map<string, string | null>();
  await Promise.all(gameIds.map(async (gameId) => {
    const offer = matching.find((candidate) => candidate.gameId === gameId)!;
    const cached = cachedByGameId.get(gameId);
    const existingCover = safeHttpsImageUrl(cached?.cover_url);
    const metadata = isKnownLowResolutionCover(existingCover) ? await steamGameMetadata(offer.title) : null;

    const steamCover = safeHttpsImageUrl(metadata?.coverUrl);
    const imageAsset = safeHttpsImageUrl(offer.imageUrl);
    const selectedCover = steamCover ??
      (existingCover && !isKnownLowResolutionCover(existingCover) ? existingCover : null) ??
      imageAsset ??
      existingCover ??
      null;
    coverByGameId.set(gameId, selectedCover);

    const patch: Record<string, string> = {};
    if (selectedCover && selectedCover !== existingCover) patch.cover_url = selectedCover;
    if (metadata?.synopsis && !cached?.synopsis) patch.synopsis = metadata.synopsis;
    if (Object.keys(patch).length > 0) {
      if (cached?.id) {
        const { error } = await supabase.from("games").update(patch).eq("id", cached.id);
        if (error) console.warn("não foi possível atualizar a capa do jogo", error.message);
      } else {
        const { error } = await supabase.from("games")
          .upsert({ itad_id: gameId, title: offer.title, ...patch }, { onConflict: "itad_id" });
        if (error) console.warn("não foi possível armazenar a capa do jogo", error.message);
      }
    }
  }));

  for (let index = 0; index < matching.length; index++) {
    const offer = matching[index];
    const coverUrl = coverByGameId.get(offer.gameId) ?? null;
    const caption = [
      "🔥 <b>OFERTA " + (index + 1) + "</b>",
      "",
      "🎮 <b>" + escapeHtml(offer.title) + "</b>",
      "🏪 " + STORE_LABELS[offer.store],
      "💰 <b>" + money(offer.priceCents, offer.currency) + "</b> · <s>" + money(offer.regularCents, offer.currency) + "</s>",
      "🏷️ <b>-" + offer.cut + "% de desconto</b>",
    ].join("\n");
    const keyboard = { inline_keyboard: [[{ text: "🛒 ABRIR OFERTA", url: offer.url }]] };

    if (coverUrl && telegram.sendPhoto) {
      try {
        await telegram.sendPhoto(chatId, coverUrl, caption, { replyMarkup: keyboard });
        continue;
      } catch (err) {
        console.warn("não foi possível enviar capa da oferta", err instanceof Error ? err.message : "erro");
      }
    }
    await telegram.sendMessage(chatId, caption + "\n\n<a href=\"" + offer.url + "\">🛒 ABRIR OFERTA</a>", { replyMarkup: keyboard });
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendMyGames(chatId: number, user: db.TelegramUserRow): Promise<void> {
  await telegram.sendChatAction(chatId);
  const mine = await db.listUserGames(supabase, user.id);
  if (mine.length === 0) {
    return void (await telegram.sendMessage(chatId,
      "📚 <b>SUA BIBLIOTECA ESTÁ VAZIA</b>\n\nVocê ainda não monitora nenhum jogo.\n\n" +
      "🔎 <b>PARA COMEÇAR</b>\nEnvie o nome de um jogo, abra o resultado e toque em <u>MONITORAR ESTE JOGO</u>."));
  }
  await telegram.sendMessage(chatId,
    `📚 <b>SEUS JOGOS MONITORADOS</b>\n<u>${mine.length} ${mine.length === 1 ? "jogo" : "jogos"} na biblioteca</u>\n\n` +
    "Cada cartão mostra a capa, a sinopse e a condição do alerta. Use o botão do cartão para gerenciar o monitoramento.");

  // Resolve metadata concurrently so a library with several games does not wait
  // through a separate Steam timeout for every game.
  const hydrated = await Promise.all(mine.map(async (row) => {
    let coverUrl = row.games.cover_url ?? null;
    let synopsis = row.games.synopsis ?? null;
    const needsSharperCover = isKnownLowResolutionCover(coverUrl);
    if (needsSharperCover || !synopsis) {
      const metadata = await steamGameMetadata(row.games.title);
      if (metadata) {
        coverUrl = needsSharperCover ? (safeHttpsImageUrl(metadata.coverUrl) ?? (isKnownLowResolutionCover(coverUrl) ? null : coverUrl)) : (coverUrl ?? safeHttpsImageUrl(metadata.coverUrl));
        synopsis = synopsis ?? metadata.synopsis;
        const patch: Record<string, string> = {};
        if (metadata.coverUrl && (needsSharperCover || !row.games.cover_url)) patch.cover_url = metadata.coverUrl;
        if (!row.games.synopsis && metadata.synopsis) patch.synopsis = metadata.synopsis;
        if (Object.keys(patch).length > 0) {
          const { error } = await supabase.from("games").update(patch).eq("id", row.games.id);
          if (error) console.error("falha ao guardar metadados do jogo", error.message);
        }
      }
    }
    return { row, coverUrl, synopsis };
  }));

  for (const { row, coverUrl, synopsis } of hydrated) {
    const caption = gameMonitorCaption(row.games.title, synopsis, row.target_price_cents, row.target_discount);
    const keyboard = { inline_keyboard: [[{
      text: "🗑️ PARAR DE MONITORAR", callback_data: `unwatch:${row.games.id}`,
    }]] };
    if (coverUrl && telegram.sendPhoto) {
      try {
        await telegram.sendPhoto(chatId, coverUrl, caption, { replyMarkup: keyboard });
        continue;
      } catch (err) {
        console.warn("não foi possível enviar capa, usando cartão em texto", err instanceof Error ? err.message : "erro");
      }
    }
    await telegram.sendMessage(chatId, caption, { replyMarkup: keyboard });
  }
}
async function handlePendingTarget(chatId: number, user: db.TelegramUserRow, text: string): Promise<void> {
  const trimmed = text.trim();
  const normalized = trimmed.replace(/^R\$\s*/i, "").trim();
  const validFormat = /^\d{1,7}(?:[.,]\d{1,2})?$/.test(normalized);
  const value = validFormat ? Number(normalized.replace(",", ".")) : Number.NaN;
  if (!validFormat || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    return void (await telegram.sendMessage(chatId,
      "⚠️ <b>VALOR NÃO RECONHECIDO</b>\nDigite um valor válido, por exemplo <code>50</code> ou <code>49,90</code>. O máximo permitido é R$ 1.000.000,00. Envie <code>0</code> para qualquer promoção."));
  }

  const gameId = user.pending_watch_game!;
  const targetPriceCents = value === 0 ? null : Math.round(value * 100);
  const added = await db.addUserGameWithPlanLimit(supabase, { userId: user.id, gameId, targetPriceCents });
  await db.setPendingWatch(supabase, user.id, null);

  if (!added) {
    return void (await telegram.sendMessage(chatId,
      "📚 <b>LIMITE DE MONITORAMENTOS ATINGIDO</b>\nSeu plano chegou ao limite de jogos monitorados. Use /meusjogos para remover um jogo e liberar espaço antes de adicionar outro."));
  }

  const label = targetPriceCents !== null ? money(targetPriceCents, "BRL") : "qualquer promoção";
  await telegram.sendMessage(chatId,
    "✅ <b>ALERTA CONFIGURADO!</b>\n\n🎮 Jogo adicionado à sua biblioteca.\n🎯 <b>Condição:</b> " +
    escapeHtml(label) + "\n\nUse /meusjogos para ver a capa, a sinopse e gerenciar seus jogos.");
}

function errorMessage(err: unknown): string {
  return err instanceof ItadError ? err.message : "não consegui buscar agora. Tente de novo em instantes.";
}

async function allowExpensiveAction(chatId: number, user: db.TelegramUserRow, bucket: "search" | "offers", limit: number): Promise<boolean> {
  let allowed: boolean;
  try {
    allowed = await db.consumeRateLimit(supabase, "telegram:" + user.telegram_id, bucket, limit, 60);
  } catch (err) {
    console.error("rate limiter indisponível", bucket, err instanceof Error ? err.message : "erro");
    await telegram.sendMessage(chatId,
      "⚠️ <b>CONSULTA TEMPORARIAMENTE INDISPONÍVEL</b>\nNão consegui validar o limite de consultas agora. Tente novamente em instantes.");
    return false;
  }
  if (!allowed) {
    await telegram.sendMessage(chatId, "⏳ <b>MUITAS CONSULTAS EM POUCO TEMPO</b>\nAguarde cerca de 1 minuto antes de tentar novamente.");
    return false;
  }
  return true;
}

async function searchAndReply(chatId: number, rawQuery: string): Promise<void> {
  const query = rawQuery.trim();
  if (query.length < 2) {
    return void (await telegram.sendMessage(chatId, "🔎 <b>QUAL JOGO VOCÊ PROCURA?</b>\nEnvie pelo menos 2 caracteres, por exemplo <code>Elden Ring</code>."));
  }
  await telegram.sendChatAction(chatId);
  let results;
  try {
    results = await itad.searchTitles(query);
  } catch (err) {
    return void (await telegram.sendMessage(chatId, `⚠️ ${errorMessage(err)}`));
  }
  const ranked = rank(query, results);
  if (ranked.length === 0) {
    return void (await replaceSearchMessage(deps, chatId, `Não encontrei nenhum jogo parecido com “${escapeHtml(query)}”. Tente outro nome.`));
  }
  const match = bestMatch(ranked);
  if (match) {
    const correctedFrom = isExact(query, match.title) ? null : query;
    return void (await replyWithPrices(chatId, match.gameId, match.title, correctedFrom));
  }
  await replaceSearchMessage(deps, chatId, `Encontrei estes resultados para “${escapeHtml(query)}”. Qual deles?`, candidatesKeyboard(ranked.slice(0, MAX_CANDIDATES)));
}

async function replyWithPrices(chatId: number, itadGameId: string, title: string, correctedFrom: string | null): Promise<void> {
  let lookup;
  try {
    lookup = await itad.gamePrices(itadGameId);
  } catch (err) {
    return void (await telegram.sendMessage(chatId, `⚠️ ${errorMessage(err)}`));
  }
  if (lookup === null) {
    return void (await replaceSearchMessage(deps, chatId, `🔎 <b>PREÇOS INDISPONÍVEIS</b>\n\nNão encontrei preço para <u>${escapeHtml(title)}</u> nessas lojas neste momento.\n\nTente novamente mais tarde.`));
  }
  const game = await db.upsertGame(supabase, { itadId: itadGameId, title });
  await db.updateGameHistoryLow(supabase, game.id, lookup.historyLowCents, lookup.prices[0]?.currency ?? null);

  let cover = safeHttpsImageUrl(game.cover_url);
  let synopsis = game.synopsis ?? null;
  const needsSharperCover = isKnownLowResolutionCover(cover);
  if (needsSharperCover || !synopsis) {
    const metadata = await steamGameMetadata(title);
    if (metadata) {
      cover = needsSharperCover
        ? (safeHttpsImageUrl(metadata.coverUrl) ?? (isKnownLowResolutionCover(cover) ? null : cover))
        : (cover ?? safeHttpsImageUrl(metadata.coverUrl));
      synopsis = synopsis ?? metadata.synopsis;
      const patch: Record<string, string> = {};
      if (metadata.coverUrl && (needsSharperCover || !game.cover_url)) patch.cover_url = metadata.coverUrl;
      if (!game.synopsis && metadata.synopsis) patch.synopsis = metadata.synopsis;
      if (Object.keys(patch).length > 0) {
        const { error } = await supabase.from("games").update(patch).eq("id", game.id);
        if (error) console.error("falha ao guardar metadados do jogo", error.message);
      }
    } else if (needsSharperCover) {
      // Evita ampliar uma miniatura reconhecidamente ruim quando a Steam falha.
      cover = null;
    }
  }

  const comparisonText = gamePricesText(title, lookup, correctedFrom);
  const shortSynopsis = synopsis
    ? (synopsis.length > 180 ? synopsis.slice(0, 177).trimEnd() + "…" : synopsis)
    : null;
  const synopsisBlock = shortSynopsis
    ? "\n\n📖 <b>SINOPSE</b>\n<i>" + escapeGameHtml(shortSynopsis) + "</i>"
    : "";
  const text = comparisonText + synopsisBlock;
  const priceKeyboard = gamePricesKeyboard(lookup);
  const rows = priceKeyboard ? [...priceKeyboard.inline_keyboard] : [];
  rows.push([{ text: "🎯 MONITORAR ESTE JOGO", callback_data: `watch:${game.id}` }]);
  await replaceSearchMessage(deps, chatId, text, { inline_keyboard: rows }, cover);
}

// ---------------------------------------------------------------------------
// Botões inline: cfg: (preferências gerais), game: (escolha ambígua),
// watch: (começar a monitorar), unwatch: (parar de monitorar).
// ---------------------------------------------------------------------------
async function handleCallback(callback: TgCallbackQuery): Promise<void> {
  const data = callback.data ?? "";
  await telegram.answerCallbackQuery(callback.id).catch(() => {});
  const chat = callback.message?.chat;
  if (!chat || chat.type !== "private") return; // ver o comentário em handleMessage
  const user = await db.getOrCreateUser(supabase, callback.from);

  if (data.startsWith("cfg:")) return void (await handleConfigCallback(chat.id, user, data, callback.message?.message_id));
  if (data.startsWith("game:")) {
    const itadGameId = data.slice("game:".length);
    let title = itadGameId;
    const button = findButton(callback, data);
    if (button) title = button.replace(/ \(DLC\)$/, "");
    if (title.endsWith("…")) title = (await itad.gameTitle(itadGameId).catch(() => null)) ?? title;
    if (!await allowExpensiveAction(chat.id, user, "search", 8)) return;
    return void (await replyWithPrices(chat.id, itadGameId, title, null));
  }
  if (data.startsWith("watch:")) {
    const gameId = data.slice("watch:".length);
    await db.setPendingWatch(supabase, user.id, gameId);
    return void (await telegram.sendMessage(chat.id, "💰 <b>QUAL É O SEU PREÇO MÁXIMO?</b>\n\nDigite um valor em reais, por exemplo <code>50</code>.\nEnvie <code>0</code> para receber aviso em qualquer promoção.\n\n<i>Você pode alterar esse objetivo depois.</i>"));
  }
  if (data.startsWith("unwatch:")) {
    const gameId = data.slice("unwatch:".length);
    await db.removeUserGame(supabase, user.id, gameId);
    return void (await telegram.sendMessage(chat.id, "🗑️ <b>MONITORAMENTO REMOVIDO</b>\n\nO jogo foi retirado da sua lista. Você poderá adicioná-lo novamente a qualquer momento."));
  }
}

function findButton(callback: TgCallbackQuery, data: string): string | null {
  for (const row of callback.message?.reply_markup?.inline_keyboard ?? []) {
    for (const button of row) if (button.callback_data === data) return button.text;
  }
  return null;
}

async function handleConfigCallback(chatId: number, user: db.TelegramUserRow, data: string, messageId?: number): Promise<void> {
  const [, kind, value] = data.split(":");
  let updated = user;
  if (kind === "st" && (STORE_KEYS as readonly string[]).includes(value)) {
    const set = new Set(user.stores);
    const storeKey = value as db.TelegramUserRow["stores"][number];
    if (set.has(storeKey)) set.delete(storeKey); else set.add(storeKey);
    if (set.size === 0) {
      await telegram.sendMessage(chatId, "⚠️ <b>MANTENHA PELO MENOS UMA LOJA</b>\nAtive uma loja para continuar recebendo alertas.");
      return;
    }
    updated = await db.updateUserPrefs(supabase, user.id, { stores: STORE_KEYS.filter((k) => set.has(k)) });
  } else if (kind === "md" && DISCOUNTS.includes(Number(value) as (typeof DISCOUNTS)[number])) {
    updated = await db.updateUserPrefs(supabase, user.id, { min_discount: Number(value) as 25 | 50 | 75 });
  } else if (kind === "hl") {
    updated = await db.updateUserPrefs(supabase, user.id, { only_historical_low: !user.only_historical_low });
  }
  if (messageId && telegram.editMessageText) {
    try {
      await telegram.editMessageText(chatId, messageId, configText(updated), { replyMarkup: configKeyboard(updated) });
      return;
    } catch { /* mensagem não editável: envia a configuração atualizada abaixo */ }
  }
  await telegram.sendMessage(chatId, configText(updated), { replyMarkup: configKeyboard(updated) });
}
}
