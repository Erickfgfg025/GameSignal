// Leitura de variáveis de ambiente das Edge Functions, num lugar só.

export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`variável de ambiente ausente: ${name}`);
  return value;
}

/** "epic=16,gmg=36" -> { epic: 16, gmg: 36 }. Entrada inválida é ignorada. */

/** Secret operacional com tamanho mínimo para evitar configuração acidentalmente fraca. */
export function secret(name: string, minLength = 32): string {
  const value = env(name);
  if (value.length < minLength) throw new Error(`segredo ${name} deve ter pelo menos ${minLength} caracteres`);
  return value;
}

export function parseShopIds(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [key, value] = part.split("=");
    const id = Number(value);
    if (key && Number.isFinite(id)) out[key.trim()] = id;
  }
  return out;
}

/** A Supabase injeta a chave de serviço automaticamente. Hoje ela aparece como
 * SUPABASE_SERVICE_ROLE_KEY (chave "legacy") e também dentro do dicionário JSON
 * SUPABASE_SECRET_KEYS (chaves novas) — aceita as duas, pra não quebrar quando a
 * legacy sair de cena. Segredos próprios não podem começar com SUPABASE_, então
 * não dá para "criar" essa variável à mão se ela faltar. */
export function serviceKey(getEnv: (name: string) => string | undefined = (n) => Deno.env.get(n)): string {
  const legacy = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const raw = getEnv("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const keys = JSON.parse(raw) as Record<string, unknown>;
      const first = keys.default ?? Object.values(keys)[0];
      if (typeof first === "string" && first) return first;
    } catch { /* cai no erro abaixo */ }
  }
  throw new Error("nenhuma chave de serviço do Supabase disponível (SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEYS)");
}


