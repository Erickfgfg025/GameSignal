// Cliente do IsThereAnyDeal (ITAD). Porta de app/providers/itad.py — mesmo
// comportamento, mesmos endpoints (docs.isthereanydeal.com):
//   GET  /deals/v2          — varredura de promoções por loja, paginada
//   GET  /service/shops/v1  — resolve o ID numérico de cada loja
//   GET  /games/search/v1   — busca por título
//   POST /games/prices/v3   — preço de um jogo específico nas lojas escolhidas
//   GET  /games/info/v2     — título completo (fallback quando o botão corta o nome)
//
// Nuuvem e Green Man Gaming não têm API própria de preços; o ITAD cobre as 4 lojas.
// Termos do ITAD: não remova as tags de afiliado dos links devolvidos.

const BASE_URL = "https://api.isthereanydeal.com";

// IDs estáveis, vistos nos exemplos da documentação do ITAD.
const KNOWN_SHOP_IDS: Record<string, number> = { steam: 61, nuuvem: 50 };

// Epic e GMG variam por conta; resolvidos pelo nome via /service/shops/v1.
const NAME_MATCHERS: Record<string, (name: string) => boolean> = {
  steam: (n) => n === "steam",
  nuuvem: (n) => n === "nuuvem",
  epic: (n) => n.startsWith("epic"),
  gmg: (n) => n.includes("greenman"),
};

export const ITAD_STORE_KEYS = ["steam", "nuuvem", "epic", "gmg"] as const;
export type ItadStoreKey = (typeof ITAD_STORE_KEYS)[number];
export type StoreKey = ItadStoreKey | "hype";
export const STORE_KEYS: readonly StoreKey[] = [...ITAD_STORE_KEYS, "hype"];

export type ItadErrorKind = "auth" | "network" | "shops" | "rate" | "error";

export class ItadError extends Error {
  readonly kind: ItadErrorKind;
  constructor(message: string, kind: ItadErrorKind = "error") {
    super(message);
    this.name = "ItadError";
    this.kind = kind;
  }
}

export interface Offer {
  gameId: string;
  title: string;
  store: StoreKey;
  priceCents: number;
  regularCents: number;
  cut: number;
  currency: string;
  url: string;
  historyLowCents: number | null;
  expiry: string | null;
  imageUrl: string | null;
}

export interface StorePrice {
  store: StoreKey;
  priceCents: number;
  regularCents: number;
  cut: number;
  currency: string;
  url: string;
}

export interface GameLookup {
  gameId: string;
  prices: StorePrice[];
  historyLowCents: number | null;
}

export interface SearchResult {
  id: string;
  title: string;
  type: string | null;
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cents(price: { amountInt?: number } | null | undefined): number | null {
  const value = price?.amountInt;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

// deno-lint-ignore no-explicit-any
export function parseDealItem(item: any, storeById: Map<number, ItadStoreKey>, allowedTypes: Set<string>): Offer | null {
  const deal = item?.deal;
  if (!deal || !allowedTypes.has(item.type)) return null;
  const store = storeById.get(Number(deal.shop?.id));
  const price = cents(deal.price);
  const regular = cents(deal.regular);
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const currency = typeof deal.price?.currency === "string" ? deal.price.currency.trim().toUpperCase() : "";
  const url = deal.url;
  const cut = Number(deal.cut ?? 0);
  if (!store || price === null || regular === null || !title || !currency ||
      !isHttpsUrl(url) || !Number.isFinite(cut) || cut < 0 || cut > 100) return null;
  const assets = item.assets ?? {};
  return {
    gameId: item.id, title, store, priceCents: price, regularCents: regular, cut, currency, url,
    historyLowCents: cents(deal.historyLow), expiry: deal.expiry ?? null,
    imageUrl: assets.banner400 ?? assets.banner300 ?? assets.boxart ?? null,
  };
}

export interface ItadClientOptions {
  country?: string;
  perPage?: number;
  maxPages?: number;
  minCut?: number;
  includeDlc?: boolean;
  shopOverrides?: Partial<Record<ItadStoreKey, number>>;
  fetchImpl?: typeof fetch;
}

/** Só os métodos que as Edge Functions realmente usam — permite testar o
 * webhook e o check-prices com um ITAD falso, sem herdar de ItadClient. */
export interface ItadLike {
  resolveShops(): Promise<Record<ItadStoreKey, number>>;
  fetchOffers(): Promise<Offer[]>;
  searchTitles(query: string, limit?: number): Promise<SearchResult[]>;
  gamePrices(gameId: string): Promise<GameLookup | null>;
  monitorGamePrices?(gameId: string): Promise<GameLookup | null>;
  gameTitle(gameId: string): Promise<string | null>;
}

export class ItadClient implements ItadLike {
  private readonly key: string;
  private readonly country: string;
  private readonly perPage: number;
  private readonly maxPages: number;
  private readonly minCut: number;
  private readonly types: Set<string>;
  private readonly overrides: Partial<Record<ItadStoreKey, number>>;
  private readonly fetchImpl: typeof fetch;
  private shopIds: Record<ItadStoreKey, number> | null = null;

  constructor(apiKey: string, opts: ItadClientOptions = {}) {
    this.key = apiKey;
    this.country = opts.country ?? "BR";
    this.perPage = opts.perPage ?? 200;
    this.maxPages = opts.maxPages ?? 2;
    this.minCut = opts.minCut ?? 20;
    this.types = new Set(opts.includeDlc ? ["game", "dlc"] : ["game"]);
    this.overrides = opts.shopOverrides ?? {};
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request(path: string, params: Record<string, string | number>, init?: RequestInit) {
    const url = new URL(path, BASE_URL);
    url.searchParams.set("key", this.key);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(8000) });
    } catch (exc) {
      // não loga a exceção original: a URL leva a chave.
      const name = exc instanceof Error ? exc.constructor.name : "erro";
      throw new ItadError(`sem conexão com o ITAD (${name})`, "network");
    }
    return await this.handleResponse(response);
  }

  private async handleResponse(response: Response) {
    if (response.status === 401 || response.status === 403) {
      const detail = (await response.text()).trim().slice(0, 200) || "sem detalhes na resposta";
      throw new ItadError(
        `o ITAD recusou a chave (HTTP ${response.status}: ${detail}). ` +
          "Confira se copiou a API key (não o Client ID/secret do OAuth) em " +
          "isthereanydeal.com/apps/my/, sem espaços, e se o e-mail da conta está confirmado.",
        "auth",
      );
    }
    if (response.status === 429) {
      throw new ItadError("limite de requisições do ITAD atingido; tente mais tarde", "rate");
    }
    if (response.status >= 400) {
      throw new ItadError(`o ITAD respondeu ${response.status}: ${(await response.text()).slice(0, 150)}`, "error");
    }
    return response.json();
  }

  async resolveShops(): Promise<Record<ItadStoreKey, number>> {
    if (this.shopIds) return this.shopIds;
    const ids: Partial<Record<ItadStoreKey, number>> = { ...KNOWN_SHOP_IDS, ...this.overrides };
    const missingKnown = ITAD_STORE_KEYS.some((k) => ids[k] === undefined);
    if (missingKnown) {
      const shops = await this.request("/service/shops/v1", { country: this.country });
      if (Array.isArray(shops)) {
        for (const shop of shops) {
          const name = normalize(String(shop.title ?? shop.name ?? ""));
          for (const key of ITAD_STORE_KEYS) {
            if (ids[key] === undefined && NAME_MATCHERS[key](name)) ids[key] = Number(shop.id);
          }
        }
      }
    }
    const missing = ITAD_STORE_KEYS.filter((k) => ids[k] === undefined);
    if (missing.length > 0) {
      throw new ItadError(
        `não achei o ID no ITAD para ${missing.join(", ")}. Defina ITAD_SHOP_IDS (secret) com os IDs certos.`,
        "shops",
      );
    }
    this.shopIds = ids as Record<ItadStoreKey, number>;
    return this.shopIds;
  }

  /** Uma consulta por loja: o ITAD devolve só o melhor preço por jogo, então
   * consultar em conjunto esconderia ofertas de quem filtra por loja. */
  async fetchOffers(): Promise<Offer[]> {
    const shops = await this.resolveShops();
    const storeById = new Map<number, ItadStoreKey>(ITAD_STORE_KEYS.map((k) => [shops[k], k]));
    const offers: Offer[] = [];
    const errors: ItadError[] = [];
    for (const store of ITAD_STORE_KEYS) {
      try {
        offers.push(...(await this.fetchShop(shops[store], storeById)));
      } catch (exc) {
        if (exc instanceof ItadError && exc.kind === "auth") throw exc;
        errors.push(exc as ItadError);
      }
    }
    if (errors.length > 0 && offers.length === 0) throw errors[0];
    return offers;
  }

  private async fetchShop(shopId: number, storeById: Map<number, ItadStoreKey>): Promise<Offer[]> {
    const offers: Offer[] = [];
    let offset = 0;
    for (let page = 0; page < this.maxPages; page++) {
      const data = await this.request("/deals/v2", {
        country: this.country,
        shops: shopId,
        sort: "-cut",
        limit: this.perPage,
        offset,
      });
      for (const item of data?.list ?? []) {
        const offer = parseDealItem(item, storeById, this.types);
        if (offer && offer.cut >= this.minCut) offers.push(offer);
      }
      if (!data?.hasMore) break;
      offset = data.nextOffset;
    }
    return offers;
  }

  async searchTitles(query: string, limit = 8): Promise<SearchResult[]> {
    const data = await this.request("/games/search/v1", { title: query.slice(0, 100), results: Math.max(1, Math.min(limit, 100)) });
    return Array.isArray(data) ? data : [];
  }

  async gameTitle(gameId: string): Promise<string | null> {
    const data = await this.request("/games/info/v2", { id: gameId });
    return data && typeof data === "object" ? data.title ?? null : null;
  }

  async gamePrices(gameId: string): Promise<GameLookup | null> {
    const shops = await this.resolveShops();
    const storeById = new Map<number, ItadStoreKey>(ITAD_STORE_KEYS.map((k) => [shops[k], k]));
    const data = await this.request(
      "/games/prices/v3",
      { country: this.country, shops: ITAD_STORE_KEYS.map((k) => shops[k]).join(",") },
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([gameId]) },
    );
    if (!Array.isArray(data) || data.length === 0) return null;
    const entry = data[0];
    const prices: StorePrice[] = [];
    for (const deal of entry.deals ?? []) {
      const store = storeById.get(Number(deal.shop?.id));
      const price = cents(deal.price);
      const regular = cents(deal.regular);
      if (!store || price === null || regular === null) continue;
      prices.push({ store, priceCents: price, regularCents: regular, cut: Number(deal.cut ?? 0), currency: deal.price.currency, url: deal.url });
    }
    const historyLowCents = cents(entry.historyLow?.all);
    return { gameId: entry.id ?? gameId, prices, historyLowCents };
  }
}
