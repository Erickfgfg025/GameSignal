export const PREMIUM_MONTHLY_CENTS = 990;
export const FREE_WATCH_LIMIT = 3;
export const PREMIUM_WATCH_LIMIT = 30;

export function watchLimit(plan: "free" | "premium", premiumUntil: string | null): number {
  const active = plan === "premium" && !!premiumUntil && new Date(premiumUntil).getTime() > Date.now();
  return active ? PREMIUM_WATCH_LIMIT : FREE_WATCH_LIMIT;
}

export function isPremium(plan: "free" | "premium", premiumUntil: string | null): boolean {
  return plan === "premium" && !!premiumUntil && new Date(premiumUntil).getTime() > Date.now();
}

export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function nextPeriodEnd(now = new Date(), recurrenceDays = 30): string {
  const end = new Date(now.getTime() + Math.max(28, Math.min(recurrenceDays, 370)) * 86_400_000);
  return end.toISOString();
}

export function amountToCents(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000) return null;
    return Math.round(value * 100);
  }
  let raw = String(value ?? "").trim();
  if (!raw) return null;
  // Aceita tanto 9.90 quanto 9,90 e, de forma defensiva, 1.234,56.
  if (raw.includes(",")) raw = raw.replace(/\./g, "").replace(",", ".");
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0 || num > 1_000_000) return null;
  return Math.round(num * 100);
}
