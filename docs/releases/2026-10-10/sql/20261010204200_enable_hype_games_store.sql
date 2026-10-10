-- GameSignal production change, applied on 2026-10-10.
-- ARCHIVE COPY: stored under docs/releases, not an active Supabase migration.
-- Adds Hype Games while preserving existing users' selected stores.
INSERT INTO public.stores (id, slug, name, active)
VALUES (101, 'hype', 'Hype Games', true)
ON CONFLICT (slug) DO UPDATE
  SET name = EXCLUDED.name,
      active = true;

-- Hype is available to new users by default. Existing users are not updated.
ALTER TABLE public.telegram_users
  ALTER COLUMN stores SET DEFAULT ARRAY['steam', 'nuuvem', 'epic', 'gmg', 'hype']::text[];
