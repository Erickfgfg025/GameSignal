const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const TOKEN_BYTES = 32;
const BOOTSTRAP_BUCKET_SECONDS = 10 * 60;
const BOOTSTRAP_CODE_BYTES = 6;

const encoder = new TextEncoder();

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomToken(bytes = TOKEN_BYTES): string {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) throw new Error("tamanho de token inválido");
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return bytesToB64(out).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function randomCode(): string {
  const out = new Uint32Array(1);
  crypto.getRandomValues(out);
  return String(100000 + (out[0] % 900000));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeBootstrapCode(code: string): string {
  return code.trim().toUpperCase();
}

function bootstrapBucket(nowSeconds = Math.floor(Date.now() / 1000)): number {
  return Math.floor(nowSeconds / BOOTSTRAP_BUCKET_SECONDS);
}

/**
 * Short-lived proof-of-possession for the server-only ADMIN_SECURITY_SECRET.
 * The code is deliberately generated outside the browser; Telegram provides
 * the sender identity, while this proof prevents an arbitrary first user from
 * claiming the only administrator slot.
 */
export async function adminBootstrapCode(secret: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const digest = await hmacSha256Hex(secret, `GameSignal:admin-bootstrap:v1:${bootstrapBucket(nowSeconds)}`);
  return digest.slice(0, BOOTSTRAP_CODE_BYTES * 2).toUpperCase();
}

export async function isValidAdminBootstrapCode(
  code: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const candidate = normalizeBootstrapCode(code);
  if (!/^[0-9A-F]{12}$/.test(candidate)) return false;
  const current = await adminBootstrapCode(secret, nowSeconds);
  const previous = await adminBootstrapCode(secret, nowSeconds - BOOTSTRAP_BUCKET_SECONDS);
  return timingSafeEqualText(candidate, current) || timingSafeEqualText(candidate, previous);
}

async function derivePassword(password: string, salt: Uint8Array, pepper: string, iterations: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(password + pepper), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, HASH_BYTES * 8);
  return new Uint8Array(bits);
}

export async function hashAdminPassword(password: string, pepper: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  if (password.length < 16) throw new Error("a senha administrativa deve ter pelo menos 16 caracteres");
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 2_000_000) throw new Error("iterações PBKDF2 inválidas");
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await derivePassword(password, salt, pepper, iterations);
  return `$gs$pbkdf2-sha256$${iterations}$${bytesToB64(salt)}$${bytesToB64(hash)}`;
}

export function timingSafeEqualText(a: string, b: string): boolean {
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyAdminPassword(password: string, encoded: string, pepper: string): Promise<boolean> {
  try {
    const parts = encoded.split("$");
    if (parts.length !== 6 || parts[1] !== "gs" || parts[2] !== "pbkdf2-sha256") return false;
    const iterations = Number(parts[3]);
    if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 2_000_000) return false;
    const salt = b64ToBytes(parts[4]);
    const expected = b64ToBytes(parts[5]);
    if (salt.length !== SALT_BYTES || expected.length !== HASH_BYTES) return false;
    const actual = await derivePassword(password, salt, pepper, iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `__Host-gamesignal_admin=${token}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return "__Host-gamesignal_admin=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict";
}

export function normalizeOrigin(origin: string | null): string | null {
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
