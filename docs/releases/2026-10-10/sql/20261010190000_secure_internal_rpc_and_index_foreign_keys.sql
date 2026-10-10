-- GameSignal production hardening, applied on 2026-10-10.
-- ARCHIVE COPY: stored under docs/releases, not an active Supabase migration.
-- Restricts privileged RPC calls to server-side service_role.
REVOKE EXECUTE ON FUNCTION public.add_user_game_with_plan_limit(uuid, uuid, integer, smallint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_user_game_with_plan_limit(uuid, uuid, integer, smallint) TO service_role;

REVOKE EXECUTE ON FUNCTION public.complete_admin_setup(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_admin_setup(text, text, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.consume_security_rate_limit(text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_security_rate_limit(text, text, integer, integer) TO service_role;

REVOKE EXECUTE ON FUNCTION public.expire_cakto_premium_users() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_cakto_premium_users() TO service_role;

REVOKE EXECUTE ON FUNCTION public.release_job_lock(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_job_lock(text, uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.try_acquire_job_lock(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_acquire_job_lock(text, integer) TO service_role;

-- FK indexes identified by the Supabase performance advisor.
CREATE INDEX IF NOT EXISTS idx_alerts_game_id ON public.alerts (game_id);
CREATE INDEX IF NOT EXISTS idx_cakto_checkout_sessions_telegram_user_id ON public.cakto_checkout_sessions (telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_price_cache_store_id ON public.price_cache (store_id);
CREATE INDEX IF NOT EXISTS idx_telegram_users_pending_watch_game ON public.telegram_users (pending_watch_game);

-- Harden the trigger helper against search_path manipulation.
ALTER FUNCTION public.set_updated_at() SET search_path = pg_catalog, public, pg_temp;
