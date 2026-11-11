/**
 * MTM Data — Supabase Admin Setup
 * Usage:
 *   node supabase_setup_admin.mjs [--username=adminJm] [--password=YourPassword123] [--secret-key=sb_secret_...]
 * Or set SUPABASE_SECRET_KEY env var (without hardcoding secrets).
 */

import readline from "readline";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://pgmzlnwowwjlgwwkcfhr.supabase.co";
const EMAIL_DOMAIN = "mtm-data.app";

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith("--") && a.includes("="))
    .map(a => {
      const idx = a.indexOf("=");
      return [a.slice(2, idx), a.slice(idx + 1)];
    })
);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(res => rl.question(q, res));

try {
  let secretKey = (args["secret-key"] || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!secretKey) {
    secretKey = (await ask("Supabase Secret Key (sb_secret_... or service_role): ")).trim();
  }
  if (!secretKey) throw new Error("Supabase secret key required.");

  const supabaseAdmin = createClient(SUPABASE_URL, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  let username = (args.username || "").trim();
  if (!username) {
    const input = (await ask("ایڈمن یوزر نیم (خالی چھوڑیں تو adminJm): ")).trim();
    username = input || "adminJm";
  }
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) {
    throw new Error("یوزر نیم 3 سے 30 انگریزی حروف، ہندسوں، _ . - پر مشتمل ہو۔");
  }

  let password = (args.password || "").trim();
  if (!password) {
    password = (await ask("پاس ورڈ (کم از کم 8 حروف، حروف+ہندسے): ")).trim();
  }
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error("پاس ورڈ کم از کم 8 حروف کا ہو اور اس میں حروف اور ہندسے دونوں ہوں۔");
  }

  const usernameKey = username.toLowerCase();
  const email = `${usernameKey}@${EMAIL_DOMAIN}`;

  let authUser = null;
  const { data: listData, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) throw listErr;
  authUser = (listData?.users || []).find(u => (u.email || "").toLowerCase() === email) || null;

  if (!authUser) {
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role: "admin" }
    });
    if (createErr) throw createErr;
    authUser = created.user;
    console.log(`✅ نیا Auth ایڈمن بن گیا: ${authUser.id} (${email})`);
  } else {
    const { data: updated, error: updErr } = await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
      password,
      email_confirm: true,
      app_metadata: { role: "admin" }
    });
    if (updErr) throw updErr;
    authUser = updated.user;
    console.log(`ℹ️ پہلے سے موجود Auth یوزر اپڈیٹ ہو گیا: ${authUser.id} (${email})`);
  }

  const { data: profile, error: profErr } = await supabaseAdmin
    .from("users")
    .upsert({
      id: authUser.id,
      username,
      username_key: usernameKey,
      role: "admin",
      active: true,
      assignments: []
    }, { onConflict: "id" })
    .select()
    .single();
  if (profErr) throw profErr;

  console.log("✅ public.users ایڈمن پروفائل محفوظ ہو گیا:");
  console.log(JSON.stringify(profile, null, 2));
} finally {
  rl.close();
}

process.exit(0);
