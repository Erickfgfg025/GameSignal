import { createClient } from "npm:@supabase/supabase-js@2";
import { env, secret, serviceKey } from "../_shared/env.ts";
import * as db from "../_shared/db.ts";
import {
  clearSessionCookie,
  cookieValue,
  normalizeOrigin,
  randomToken,
  sessionCookie,
  sha256Hex,
  timingSafeEqualText,
  verifyAdminPassword,
  hashAdminPassword,
} from "../_shared/adminSecurity.ts";

const supabase = createClient(env("SUPABASE_URL"), serviceKey(), { auth: { persistSession: false } });
const adminSetupSecret = secret("ADMIN_SECURITY_SECRET", 32);
const adminWebUrl = env("ADMIN_WEB_URL");
const adminWebOrigin = normalizeOrigin(adminWebUrl);
if (!adminWebOrigin || !adminWebOrigin.startsWith("https://")) {
  throw new Error("ADMIN_WEB_URL deve ser uma URL HTTPS válida");
}

const SESSION_MAX_AGE = 8 * 60 * 60;
const SESSION_COOKIE = "__Host-gamesignal_admin";
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, max-age=0",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "permissions-policy": "geolocation=(), microphone=(), camera=()",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function clientIp(req: Request): string {
  // Cloudflare/Supabase controls cf-connecting-ip at the edge; prefer it over
  // client-controlled forwarding chains so rate-limit identity cannot be spoofed
  // through an arbitrary X-Forwarded-For header.
  const cloudflareIp = req.headers.get("cf-connecting-ip")?.trim();
  if (cloudflareIp) return cloudflareIp.slice(0, 128);
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded?.slice(0, 128) || "unknown";
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = normalizeOrigin(req.headers.get("origin"));
  if (!origin || origin !== adminWebOrigin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "content-type, x-csrf-token",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "vary": "Origin",
  };
}

function originAllowed(req: Request): boolean {
  const originHeader = req.headers.get("origin");
  if (!originHeader) return true;
  const origin = normalizeOrigin(originHeader);
  return origin === adminWebOrigin;
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const contentType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return null;
  if ((Number(req.headers.get("content-length")) || 0) > 32_768) return null;
  const body = await req.text();
  if (body.length === 0 || body.length > 32_768) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function login(req: Request): Promise<Response> {
  if (!originAllowed(req)) return json({ error: "Origem inválida." }, 403, corsHeaders(req));
  const config = await db.getAdminConfig(supabase);
  if (!config) return json({ error: "Admin ainda não configurado. Use /setupadmin no Telegram." }, 503, corsHeaders(req));
  const body = await readJson(req);
  const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const code = typeof body?.code === "string" ? body.code.trim() : "";

  const ipKey = await sha256Hex(`${adminSetupSecret}|login-ip|${username}|${clientIp(req)}`);
  const identityKey = await sha256Hex(`${adminSetupSecret}|login-identity|${username}`);
  const allowedIpAttempt = await db.consumeRateLimit(supabase, ipKey, "admin_login_ip", 5, 300);
  const allowedIdentityAttempt = await db.consumeRateLimit(supabase, identityKey, "admin_login_identity", 12, 600);
  if (!allowedIpAttempt || !allowedIdentityAttempt) return json({ error: "Credenciais inválidas." }, 429, corsHeaders(req));

  const usernameMatches = username === config.username;
  const passwordMatches = await verifyAdminPassword(usernameMatches ? password : "invalid-password", config.password_hash, adminSetupSecret);
  const codeHash = /^[0-9]{6}$/.test(code) ? await sha256Hex(`${code}:${adminSetupSecret}`) : "invalid-code";

  if (!usernameMatches || !passwordMatches) return json({ error: "Credenciais inválidas." }, 401, corsHeaders(req));
  const challengeOk = await db.consumeAdminChallenge(supabase, config.telegram_id, codeHash);
  if (!challengeOk) return json({ error: "Código do Telegram inválido ou expirado." }, 401, corsHeaders(req));

  const sessionToken = randomToken();
  const csrfToken = randomToken(24);
  const sessionHash = await sha256Hex(`${sessionToken}:${adminSetupSecret}`);
  const csrfHash = await sha256Hex(`${csrfToken}:${adminSetupSecret}`);
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();
  const authVersion = await sha256Hex(config.password_hash);
  await db.createAdminSession(supabase, { telegramId: config.telegram_id, sessionHash, csrfHash, authVersion, expiresAt });
  await db.adminAudit(supabase, config.telegram_id, "login", null, { source: "web" });

  return json(
    { ok: true, csrfToken, expiresAt },
    200,
    { "set-cookie": sessionCookie(sessionToken, SESSION_MAX_AGE), ...corsHeaders(req) },
  );
}

async function setupComplete(req: Request): Promise<Response> {
  if (!originAllowed(req)) return json({ error: "Origem inválida." }, 403, corsHeaders(req));
  const body = await readJson(req);
  if (!body) return json({ error: "JSON inválido." }, 400, corsHeaders(req));
  const challengeToken = typeof body.challengeToken === "string" ? body.challengeToken : "";
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";

  if (!/^[A-Za-z0-9_-]{32,128}$/.test(challengeToken)) return json({ error: "Link de configuração inválido." }, 400, corsHeaders(req));
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) return json({ error: "Usuário: 3 a 32 caracteres, apenas letras, números, ponto, hífen e sublinhado." }, 400, corsHeaders(req));
  if (password.length < 16 || password.length > 128) return json({ error: "A senha deve ter entre 16 e 128 caracteres." }, 400, corsHeaders(req));
  if (password !== confirmPassword) return json({ error: "As senhas não conferem." }, 400, corsHeaders(req));

  const ipKey = await sha256Hex(`${adminSetupSecret}|setup-ip|${clientIp(req)}`);
  if (!(await db.consumeRateLimit(supabase, ipKey, "admin_setup_complete", 5, 900))) {
    return json({ error: "Muitas tentativas. Aguarde alguns minutos." }, 429, corsHeaders(req));
  }

  const challengeHash = await sha256Hex(`${challengeToken}:${adminSetupSecret}`);
  const passwordHash = await hashAdminPassword(password, adminSetupSecret);
  const telegramId = await db.completeAdminSetup(supabase, { tokenHash: challengeHash, username, passwordHash });
  if (telegramId === null) return json({ error: "Link expirado, já utilizado ou inválido." }, 401, corsHeaders(req));
  if (telegramId === 0) return json({ error: "A configuração inicial já foi concluída." }, 409, corsHeaders(req));

  // Admin é um papel separado de Free/Premium. Marca o onboarding como concluído
  // para que o próprio administrador nunca seja enviado à tela comercial.
  await db.completeOnboardingByTelegramId(supabase, telegramId);
  await db.adminAudit(supabase, telegramId, "bootstrap_admin", null, { source: "setup" });
  return json({ ok: true, message: "Administrador configurado. Agora envie /admincode no Telegram e entre no painel." }, 201, corsHeaders(req));
}

async function authContext(req: Request) {
  const token = cookieValue(req.headers.get("cookie"), SESSION_COOKIE);
  if (!token || token.length > 256) return null;
  const sessionHash = await sha256Hex(`${token}:${adminSetupSecret}`);
  const session = await db.getAdminSession(supabase, sessionHash);
  const config = await db.getAdminConfig(supabase);
  if (!config) return null;
  const currentAuthVersion = await sha256Hex(config.password_hash);
  if (!session || session.auth_version !== currentAuthVersion || session.telegram_id !== config.telegram_id) return null;
  return { ...session, sessionHash };
}

async function requireCsrf(req: Request, ctx: NonNullable<Awaited<ReturnType<typeof authContext>>>): Promise<boolean> {
  const value = req.headers.get("x-csrf-token");
  if (!value || value.length > 256) return false;
  return timingSafeEqualText(await sha256Hex(`${value}:${adminSetupSecret}`), ctx.csrf_hash);
}

async function logout(req: Request): Promise<Response> {
  const ctx = await authContext(req);
  if (ctx && !(await requireCsrf(req, ctx))) return json({ error: "CSRF inválido." }, 403, corsHeaders(req));
  if (ctx) {
    await db.revokeAdminSession(supabase, ctx.sessionHash);
    await db.adminAudit(supabase, ctx.telegram_id, "logout");
  }
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(), ...corsHeaders(req) });
}

async function requireAdmin(req: Request): Promise<{ ctx: NonNullable<Awaited<ReturnType<typeof authContext>>> } | Response> {
  const ctx = await authContext(req);
  if (!ctx) return json({ error: "Não autenticado." }, 401, corsHeaders(req));
  return { ctx };
}

async function routeApi(req: Request, path: string): Promise<Response> {
  if (req.method === "POST" && path === "/api/setup/complete") return setupComplete(req);
  if (req.method === "POST" && path === "/api/auth/login") return login(req);
  if (req.method === "POST" && path === "/api/auth/logout") return logout(req);

  const secured = await requireAdmin(req);
  if (secured instanceof Response) return secured;
  const { ctx } = secured;

  if (req.method === "GET" && path === "/api/me") return json({ role: "admin", expiresAt: ctx.expires_at }, 200, corsHeaders(req));
  if (req.method === "GET" && path === "/api/stats") return json(await db.getStats(supabase), 200, corsHeaders(req));

  if (req.method === "GET" && path === "/api/users") {
    const url = new URL(req.url);
    const search = url.searchParams.get("search") ?? "";
    const limit = Number(url.searchParams.get("limit") ?? "25");
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const result = await db.listUsers(supabase, search, Number.isFinite(limit) ? limit : 25, Number.isFinite(offset) ? offset : 0);
    const adminConfig = await db.getAdminConfig(supabase);
    const adminUserId = adminConfig ? await db.getUserIdByTelegramId(supabase, adminConfig.telegram_id) : null;
    const rows = result.rows.map((u) => ({
      id: u.id,
      username: u.username,
      first_name: u.first_name,
      last_name: u.last_name,
      active: u.active,
      plan: u.plan,
      role: adminUserId === u.id ? "admin" : "user",
      created_at: u.created_at,
    }));
    return json({ rows, total: result.total }, 200, corsHeaders(req));
  }

  if (req.method === "POST" && path.startsWith("/api/users/") && path.endsWith("/plan")) {
    if (!(await requireCsrf(req, ctx))) return json({ error: "CSRF inválido." }, 403, corsHeaders(req));
    const userId = path.slice("/api/users/".length, -"/plan".length);
    if (!validUuid(userId)) return json({ error: "Usuário inválido." }, 400, corsHeaders(req));
    const body = await readJson(req);
    if (body?.plan !== "free" && body?.plan !== "premium") return json({ error: "Plano inválido." }, 400, corsHeaders(req));
    const targetUser = await db.getUserById(supabase, userId);
    const adminConfig = await db.getAdminConfig(supabase);
    const adminUserId = adminConfig ? await db.getUserIdByTelegramId(supabase, adminConfig.telegram_id) : null;
    if (!targetUser) return json({ error: "Usuário não encontrado." }, 404, corsHeaders(req));
    if (adminUserId === targetUser.id) {
      return json({ error: "O Admin é um papel separado de Free/Premium e possui acesso ilimitado." }, 409, corsHeaders(req));
    }
    await db.setUserPlan(supabase, userId, body.plan);
    await db.adminAudit(supabase, ctx.telegram_id, "set_plan", userId, { plan: body.plan });
    return json({ ok: true }, 200, corsHeaders(req));
  }

  if (req.method === "POST" && path.startsWith("/api/users/") && path.endsWith("/active")) {
    if (!(await requireCsrf(req, ctx))) return json({ error: "CSRF inválido." }, 403, corsHeaders(req));
    const userId = path.slice("/api/users/".length, -"/active".length);
    if (!validUuid(userId)) return json({ error: "Usuário inválido." }, 400, corsHeaders(req));
    const body = await readJson(req);
    if (typeof body?.active !== "boolean") return json({ error: "Status inválido." }, 400, corsHeaders(req));
    await db.setUserActive(supabase, userId, body.active);
    await db.adminAudit(supabase, ctx.telegram_id, body.active ? "activate_user" : "deactivate_user", userId);
    return json({ ok: true }, 200, corsHeaders(req));
  }

  return json({ error: "Não encontrado." }, 404, corsHeaders(req));
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") {
      if (!originAllowed(req)) return new Response(null, { status: 403, headers: JSON_HEADERS });
      return new Response(null, { status: 204, headers: { ...JSON_HEADERS, ...corsHeaders(req) } });
    }

    if (path.endsWith("/health")) return json({ ok: true, service: "admin-api" });
    if (!path.includes("/api/")) return json({ error: "Endpoint de API. O painel web está em ADMIN_WEB_URL." }, 404);
    return await routeApi(req, path.slice(path.indexOf("/api")));
  } catch (err) {
    console.error("admin-api: erro interno", err instanceof Error ? err.name : "unknown");
    return json({ error: "Erro interno." }, 500);
  }
});
