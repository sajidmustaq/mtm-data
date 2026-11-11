import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const EMAIL_DOMAIN = "mtm-data.app";
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,30}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getSecretKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.default) return String(parsed.default);
    } catch {
      // Fallback below
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

function validPassword(pw: string): boolean {
  return pw.length >= 8 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
}

function sanitizeAssignments(input: unknown) {
  if (!Array.isArray(input)) return [];
  const out: { province: string; divisions: string[] }[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { province?: unknown; divisions?: unknown };
    const province = String(rec.province ?? "").normalize("NFC").trim();
    if (!province) continue;
    const divisions = Array.isArray(rec.divisions)
      ? [...new Set(rec.divisions.map((d) => String(d ?? "").normalize("NFC").trim()).filter(Boolean))]
      : [];
    out.push({ province, divisions });
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const secretKey = getSecretKey();
  if (!supabaseUrl || !secretKey) {
    return json({ error: "Server configuration missing" }, 500);
  }

  const supabaseAdmin = createClient(supabaseUrl, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!jwt) return json({ error: "Missing authorization token" }, 401);

    const { data: authData, error: authErr } = await supabaseAdmin.auth.getUser(jwt);
    if (authErr || !authData?.user) return json({ error: "Unauthorized" }, 401);

    const { data: caller, error: callerErr } = await supabaseAdmin
      .from("users")
      .select("id, username, role, active")
      .eq("id", authData.user.id)
      .maybeSingle();

    if (callerErr || !caller || !caller.active || caller.role !== "admin") {
      return json({ error: "Forbidden: active admin required" }, 403);
    }

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.action !== "string") {
      return json({ error: "Invalid request body" }, 400);
    }

    if (body.action === "create") {
      const username = String(body.username ?? "").trim();
      const password = String(body.password ?? "").trim();
      const role = body.role === "admin" ? "admin" : "user";
      const active = body.active !== false;
      const assignments = role === "admin" ? [] : sanitizeAssignments(body.assignments);

      if (!USERNAME_RE.test(username)) {
        return json({ error: "Username must be 3-30 characters (letters, numbers, _ . -)" }, 400);
      }
      if (!validPassword(password)) {
        return json({ error: "Password must be at least 8 characters and include letters and numbers" }, 400);
      }

      const usernameKey = username.toLowerCase();
      const { data: existing } = await supabaseAdmin
        .from("users")
        .select("id")
        .eq("username_key", usernameKey)
        .maybeSingle();
      if (existing) {
        return json({ error: "User ID already exists" }, 409);
      }

      const email = `${usernameKey}@${EMAIL_DOMAIN}`;
      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: { role },
      });
      if (createErr || !created?.user) {
        return json({ error: createErr?.message || "Failed to create auth user" }, 400);
      }

      const newUid = created.user.id;
      const { data: profile, error: insertErr } = await supabaseAdmin
        .from("users")
        .insert({
          id: newUid,
          username,
          username_key: usernameKey,
          role,
          active,
          assignments,
        })
        .select()
        .single();

      if (insertErr) {
        await supabaseAdmin.auth.admin.deleteUser(newUid).catch(() => {});
        return json({ error: insertErr.message }, 400);
      }

      const { error: syncErr } = await supabaseAdmin.rpc("sync_user_assignments", { target_uid: newUid });
      if (syncErr) {
        return json({ user: profile, warning: syncErr.message }, 200);
      }
      return json({ user: profile }, 200);
    }

    if (body.action === "reset_password") {
      const targetUid = String(body.targetUid ?? "").trim();
      const password = String(body.password ?? "").trim();
      if (!UUID_RE.test(targetUid)) return json({ error: "Invalid target user ID" }, 400);
      if (!validPassword(password)) {
        return json({ error: "Password must be at least 8 characters and include letters and numbers" }, 400);
      }

      const { data: targetUser } = await supabaseAdmin
        .from("users")
        .select("id, username")
        .eq("id", targetUid)
        .maybeSingle();
      if (!targetUser) return json({ error: "User not found" }, 404);

      const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(targetUid, { password });
      if (updErr) return json({ error: updErr.message }, 400);

      return json({ ok: true, username: targetUser.username }, 200);
    }

    if (body.action === "delete") {
      const targetUid = String(body.targetUid ?? "").trim();
      if (!UUID_RE.test(targetUid)) return json({ error: "Invalid target user ID" }, 400);
      if (targetUid === caller.id) {
        return json({ error: "Cannot delete your own admin account" }, 400);
      }

      const { data: targetUser } = await supabaseAdmin
        .from("users")
        .select("id, username")
        .eq("id", targetUid)
        .maybeSingle();
      if (!targetUser) return json({ error: "User not found" }, 404);

      await supabaseAdmin
        .from("users")
        .update({ active: false, assignments: [] })
        .eq("id", targetUid);
      await supabaseAdmin.rpc("sync_user_assignments", { target_uid: targetUid });

      const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(targetUid);
      if (delErr) return json({ error: delErr.message }, 400);

      return json({ ok: true, username: targetUser.username }, 200);
    }

    return json({ error: "Unsupported action" }, 400);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});
