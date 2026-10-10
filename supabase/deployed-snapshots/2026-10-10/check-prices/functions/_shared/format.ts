// Porta de app/formatting.py — mesmos textos, mesma lógica de exibição.
import type { GameLookup, StoreKey, StorePrice } from "./itad.ts";
import type { Candidate } from "./gamesearch.ts";
import type { InlineKeyboardMarkup } from "./telegram.ts";

export const STORE_KEYS: StoreKey[] = ["steam", "nuuvem", "epic", "gmg", "hype"];
export const STORE_LABELS: Record<StoreKey, string> = { steam: "Steam", nuuvem: "Nuuvem", epic: "Epic Games", gmg: "Green Man Gaming", hype: "Hype Games" };
export const STORE_EMOJI: Record<StoreKey, string> = { steam: "🎮", nuuvem: "☁️", epic: "🟣", gmg: "🟢", hype: "🟠" };

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function money(cents: number, currency: string): string {
  const value = (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "BRL" ? `R$ ${value}` : `${value} ${currency}`;
}

export function gamePricesText(title: string, lookup: GameLookup, correctedFrom: string | null = null): string {
  const lines: string[] = [];
  if (correctedFrom) {
    lines.push(`🔎 Mostrando resultados para <b>${escapeHtml(title)}</b> (você digitou “${escapeHtml(correctedFrom)}”)`);
  } else {
    lines.push(`🎮 <b>${escapeHtml(title)}</b>`);
  }
  const byStore = new Map(lookup.prices.map((p) => [p.store, p]));
  if (byStore.size === 0) {
    lines.push("Não encontrei preço para esse jogo em nenhuma das 4 lojas agora.");
    return lines.join("\n");
  }
  const cheapest = [...byStore.values()].reduce((a, b) => (b.priceCents < a.priceCents ? b : a));
  for (const key of STORE_KEYS) {
    const emoji = STORE_EMOJI[key];
    const label = STORE_LABELS[key];
    const p = byStore.get(key);
    if (!p) {
      lines.push(`${emoji} ${label}: <i>não vendido aqui</i>`);
      continue;
    }
    const priceTxt = p.priceCents === 0 ? "GRÁTIS" : money(p.priceCents, p.currency);
    const star = key === cheapest.store && byStore.size > 1 ? " 🏆" : "";
    if (p.cut > 0) {
      lines.push(`${emoji} ${label}: <b>${priceTxt}</b> <s>${money(p.regularCents, p.currency)}</s> (-${p.cut}%)${star}`);
    } else {
      lines.push(`${emoji} ${label}: ${priceTxt}${star}`);
    }
  }
  if (lookup.historyLowCents !== null) {
    lines.push(`📉 Menor preço já visto: ${money(lookup.historyLowCents, cheapest.currency)}`);
  }
  return lines.join("\n");
}

export function gamePricesKeyboard(lookup: GameLookup): InlineKeyboardMarkup | null {
  if (lookup.prices.length === 0) return null;
  const cheapest = lookup.prices.reduce((a, b) => (b.priceCents < a.priceCents ? b : a));
  return { inline_keyboard: [[{ text: `🛒 Ver na ${STORE_LABELS[cheapest.store]}`, url: cheapest.url }]] };
}

/** Telegram limita o texto de botão a 64 caracteres. */
export function candidatesKeyboard(candidates: Candidate[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: candidates.map((c) => {
      let label = c.isGame ? c.title : `${c.title} (DLC)`;
      if (label.length > 64) label = label.slice(0, 63) + "…";
      return [{ text: label, callback_data: `game:${c.gameId}` }];
    }),
  };
}

/** Alerta de um jogo da watchlist (seção 22 do prompt): mostra o preço-alvo
 * do usuário ao lado do preço encontrado. */
export function watchAlertText(title: string, price: StorePrice, targetPriceCents: number | null): string {
  const priceTxt = price.priceCents === 0 ? "GRÁTIS" : money(price.priceCents, price.currency);
  const lines = [
    "🔥 <b>OFERTA ENCONTRADA!</b>",
    "",
    `🎮 ${escapeHtml(title)}`,
    "",
    `💰 ${priceTxt}` + (price.cut > 0 ? ` <s>${money(price.regularCents, price.currency)}</s>` : ""),
  ];
  if (price.cut > 0) lines.push(`🏷️ ${price.cut}% OFF`);
  if (targetPriceCents !== null) lines.push(`🎯 Seu alvo: ${money(targetPriceCents, price.currency)}`);
  lines.push("", `🏪 ${STORE_LABELS[price.store]}`);
  return lines.join("\n");
}

export function watchAlertKeyboard(price: StorePrice): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: "🛒 Comprar", url: price.url }]] };
}
