# MTM Data (Supabase)

مدرسین تصدیق نظام (MTM Data) — Static web application backed by Supabase Auth, PostgreSQL (with Row-Level Security), Realtime, and Edge Functions.

- Schema & RLS: `supabase_schema.sql`
- Edge Function: `supabase/functions/manage-user/index.ts`
- Admin bootstrap script: `supabase_setup_admin.mjs`
- Bulk data import script: `supabase_import.mjs`

The admin report defaults to all users' submissions; use its user filter to view one user's report.
