/**
 * MTM Data — Supabase JSON Data Import (all 5,292 records -> records + records_private)
 * Usage:
 *   node supabase_import.mjs [data.json] [--secret-key=sb_secret_...]
 *   node supabase_import.mjs [data.json] [--username=adminJm] [--password=YourPassword]
 */

import { readFileSync } from "fs";
import readline from "readline";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://pgmzlnwowwjlgwwkcfhr.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_M6jTob7-i3VlxJf6KQxoIQ_RF8KUVjO";
const EMAIL_DOMAIN = "mtm-data.app";

const nfc = v => String(v ?? "").normalize("NFC");
const clean = v => nfc(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);

const K = {
  code: "عملہ کوڈ",
  name: "نام",
  father: "ولدیت",
  branch: "شاخ",
  duty: "ذمہ داری",
  district: "ڈسٹرکٹ",
  division: "سرکاری ڈویژن",
  province: "صوبائی/انتظامی اکائی",
  offMin: "آفیشل منٹ",
  grade: "گریڈ",
  ijaraMin: "اجارے کے منٹ"
};

function normalizeRow(input) {
  if (!input || typeof input !== "object") return null;
  const byNfc = {};
  for (const [key, val] of Object.entries(input)) {
    byNfc[nfc(key).trim()] = val;
  }
  const code = clean(byNfc[K.code]);
  const province = clean(byNfc[K.province]);
  if (!code || !province) return null;
  const sourceKey = `${code}|${province}`;
  const recordId = encodeURIComponent(sourceKey);
  const division = clean(byNfc[K.division]);
  const district = clean(byNfc[K.district]);
  return {
    recordId,
    sourceKey,
    code,
    name: clean(byNfc[K.name]),
    father: clean(byNfc[K.father]),
    duty: clean(byNfc[K.duty]),
    district,
    division,
    province,
    branch: clean(byNfc[K.branch]),
    offMin: clean(byNfc[K.offMin]),
    grade: clean(byNfc[K.grade]),
    ijaraMin: clean(byNfc[K.ijaraMin])
  };
}

function userCanSeeRegion(user, province, division) {
  if (!user?.active) return false;
  if (user.role === "admin") return true;
  if (!Array.isArray(user.assignments)) return false;
  return user.assignments.some(a =>
    nfc(a.province) === province &&
    (!Array.isArray(a.divisions) || !a.divisions.length || a.divisions.some(d => nfc(d) === division))
  );
}

const positional = process.argv.slice(2).filter(a => !a.startsWith("--"));
const DATA_PATH = positional[0] || "./data.json";
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
  const secretKey = (args["secret-key"] || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const supabase = createClient(SUPABASE_URL, secretKey || PUBLISHABLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  if (secretKey) {
    console.log("🔑 Secret Key موڈ کے ذریعے کنیکٹ ہو رہا ہے...");
  } else {
    let username = (args.username || "").trim();
    if (!username) {
      const input = (await ask("ایڈمن یوزر نیم (خالی چھوڑیں تو adminJm): ")).trim();
      username = input || "adminJm";
    }
    let password = (args.password || "").trim();
    if (!password) {
      password = (await ask(`${username} کا پاس ورڈ: `)).trim();
    }
    const email = `${username.toLowerCase()}@${EMAIL_DOMAIN}`;
    const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({ email, password });
    if (authErr || !authData?.user) throw new Error(`لاگ اِن ناکام: ${authErr?.message || "Invalid credentials"}`);
    const { data: meRow, error: meErr } = await supabase.from("users").select("role, active").eq("id", authData.user.id).single();
    if (meErr || !meRow?.active || meRow.role !== "admin") throw new Error("یہ یوزر فعال ایڈمن نہیں ہے۔");
    console.log(`🔐 ایڈمن لاگ اِن کامیاب: ${username}`);
  }

  const rawData = JSON.parse(readFileSync(DATA_PATH, "utf8"));
  if (!Array.isArray(rawData)) throw new Error("JSON فائل ریکارڈز کی فہرست (array) ہونی چاہیے۔");
  console.log(`📂 کل قطاریں (${DATA_PATH}): ${rawData.length}`);

  const { data: users, error: usersErr } = await supabase.from("users").select("id, role, active, assignments");
  if (usersErr) throw usersErr;
  console.log(`👤 موجودہ فعال یوزرز: ${(users || []).filter(u => u.active).length}`);

  const deduplicated = new Map();
  let skipped = 0;
  for (const row of rawData) {
    const norm = normalizeRow(row);
    if (!norm) { skipped++; continue; }
    deduplicated.set(norm.recordId, norm);
  }
  const records = [...deduplicated.values()];
  console.log(`✅ منفرد درست ریکارڈ: ${records.length} (چھوڑے: ${skipped})`);

  console.log("\n🚀 Supabase میں امپورٹ شروع ہو رہا ہے...\n");
  const BATCH_SIZE = 400;
  const updatedAt = new Date().toLocaleString("en-GB", { hour12: false });
  const updatedAtMs = Date.now();
  let success = 0;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const chunk = records.slice(i, i + BATCH_SIZE);
    const recRows = [];
    const privRows = [];
    for (const r of chunk) {
      const assigned_to = (users || [])
        .filter(u => userCanSeeRegion(u, r.province, r.division))
        .map(u => u.id);
      recRows.push({
        id: r.recordId,
        code: r.code,
        name: r.name,
        father: r.father,
        duty: r.duty,
        district: r.district,
        division: r.division,
        province: r.province,
        assigned_to,
        source_key: r.sourceKey,
        updated_at: updatedAt,
        updated_at_ms: updatedAtMs
      });
      privRows.push({
        record_id: r.recordId,
        branch: r.branch,
        off_min: r.offMin,
        grade: r.grade,
        ijara_min: r.ijaraMin
      });
      success++;
    }

    const { error: recErr } = await supabase.from("records").upsert(recRows, { onConflict: "id" });
    if (recErr) throw recErr;
    const { error: privErr } = await supabase.from("records_private").upsert(privRows, { onConflict: "record_id" });
    if (privErr) throw privErr;

    process.stdout.write(`\r   ${Math.min(i + BATCH_SIZE, records.length)}/${records.length} ریکارڈ...`);
  }

  console.log(`\n\n✅ امپورٹ مکمل! کامیاب: ${success} | چھوڑے: ${skipped}`);
} finally {
  rl.close();
}

process.exit(0);
