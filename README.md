# MTM Data (Supabase)

مدرسین تصدیق نظام (MTM Data) — Static web application backed by Supabase Auth, PostgreSQL (with Row-Level Security), Realtime, and Edge Functions.

- Schema & RLS: `supabase_schema.sql`
- Edge Function: `supabase/functions/manage-user/index.ts`
- Admin bootstrap script: `supabase_setup_admin.mjs`
- Bulk data import script: `supabase_import.mjs`

The admin report defaults to all users' submissions; use its user filter to view one user's report.

Admins can deactivate an employee record from the data-entry list. Inactive records are hidden from regular users and reports, while remaining available to admins through the employee-status filter for review or reactivation. Apply the updated `supabase_schema.sql` to add the record status field and update assignment syncing.
