"use strict";

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://pgmzlnwowwjlgwwkcfhr.supabase.co";
const SUPABASE_KEY = "sb_publishable_M6jTob7-i3VlxJf6KQxoIQ_RF8KUVjO";
const PROJECT_REF = "pgmzlnwowwjlgwwkcfhr";
const EMAIL_DOMAIN = "mtm-data.app";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: `mtm_sb_auth_${PROJECT_REF}`
  }
});

async function invokeManageUser(payload) {
  const { data, error } = await supabase.functions.invoke("manage-user", { body: payload });
  if (error) {
    let msg = error.message || "Edge Function request failed";
    try {
      const body = await error.context?.json?.();
      if (body?.error) msg = body.error;
    } catch {}
    const err = new Error(msg);
    err.status = error.context?.status;
    throw err;
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
const YES = "جی ہاں", NO = "جی نہیں", PAGE_SIZE = 50, IDLE_MS = 15 * 60 * 1000;
const RECORD_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const nfc = v => String(v ?? "").normalize("NFC");
const K = {
  code: "عملہ کوڈ", name: "نام", father: "ولدیت", branch: "شاخ", duty: "ذمہ داری",
  district: "ڈسٹرکٹ", division: "سرکاری ڈویژن", province: "صوبائی/انتظامی اکائی",
  offMin: "آفیشل منٹ", grade: "گریڈ", ijaraMin: "اجارے کے منٹ",
  hifz: "کیا یہ مدرس حقیتا حفظ کا درجہ بڑھا رہے ہیں",
  nazra: "کیا یہ حقیقتا ناظرہ کا درجہ  پڑھا رہےہیں"
};
const COLS = Object.values(K);
const ADMIN_ONLY_COLS = [K.branch, K.offMin, K.grade, K.ijaraMin];
const EXTRA_COLS = ["آخری تبدیلی از", "آخری تبدیلی کا وقت"];
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));
const nowStr = () => new Date().toLocaleString("en-GB", { hour12: false });
const userEmail = username => `${username.trim().toLowerCase()}@${EMAIL_DOMAIN}`;
const pwProblem = (pw, username) => {
  if (pw.length < 8) return "پاس ورڈ کم از کم 8 حروف کا ہو";
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return "پاس ورڈ میں حروف اور ہندسے دونوں ہوں";
  if (username && pw.toLowerCase().includes(username.toLowerCase())) return "پاس ورڈ میں یوزر نیم شامل نہ ہو";
  if (/^(admin|password|12345678)/i.test(pw)) return "یہ پاس ورڈ بہت آسان ہے";
  return "";
};
const nameProblem = n => /^[A-Za-z0-9_.-]{3,30}$/.test(n) ? "" : "یوزر نیم 3 سے 30 حروف: انگریزی حروف، ہندسے، _ . -";
const recordId = r => encodeURIComponent(`${r[K.code]}|${r[K.province]}`);
const isDone = r => !!r?.[K.hifz] && !!r?.[K.nazra];
const clean = v => nfc(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);

let me = null, DATA = [], USERS = [], ENTRIES = [], LOG = [], usersLoaded = false, entriesLoaded = false;
let page = 1, editingId = null, unsubscribers = [], lastActive = Date.now(), loggingOut = false;
let provinces = [], RECORD_DOCS = new Map(), DRAFT_ENTRIES = new Map(), recordsLoading = false, pendingScopeSelection = null;
let loaderCount = 0;

function showLoader(text = "براہِ کرم انتظار کریں...") {
  loaderCount++;
  if ($("loaderText")) $("loaderText").textContent = text;
  $("globalLoader")?.classList.remove("hidden");
}

function hideLoader() {
  loaderCount = Math.max(0, loaderCount - 1);
  if (!loaderCount) $("globalLoader")?.classList.add("hidden");
}

async function withLoader(text, fn) {
  showLoader(text);
  try {
    return await fn();
  } finally {
    hideLoader();
  }
}

function setButtonBusy(btn, busy, busyText = "") {
  if (!btn) return;
  if (busy) {
    if (btn.dataset.origHtml === undefined) btn.dataset.origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner spinner-sm" aria-hidden="true"></span><span>${esc(busyText || btn.textContent)}</span>`;
  } else {
    btn.disabled = false;
    if (btn.dataset.origHtml !== undefined) {
      btn.innerHTML = btn.dataset.origHtml;
      delete btn.dataset.origHtml;
    }
  }
}


function showError(message) {
  $("loginErr").textContent = message;
}

function reportError(message, error) {
  console.error(message, error);
  alert(`${message}: ${error?.message || error}`);
}

function assignmentsForUser(user) {
  return Array.isArray(user.assignments) ? user.assignments : [];
}

function normalizeRole(role) {
  const normalized = typeof role === "string" ? role.trim().toLowerCase() : "";
  return normalized === "admin" || normalized === "user" ? normalized : "";
}

function hasRegion(user, row) {
  if (user.role === "admin") return true;
  const prov = nfc(row[K.province]);
  const div = nfc(row[K.division]);
  return assignmentsForUser(user).some(a => nfc(a.province) === prov &&
    (!Array.isArray(a.divisions) || !a.divisions.length || a.divisions.some(d => nfc(d) === div)));
}

function visibleRows() {
  if (!me) return [];
  if (me.role === "admin") {
    const selectedUid = $("entryUser")?.value || "";
    if (selectedUid && selectedUid !== me.id) {
      return DATA.filter(row => row.assignedTo?.includes(selectedUid));
    }
    return DATA;
  }
  return DATA.filter(row => row.assignedTo?.includes(me.id) && hasRegion(me, row));
}

function entryOwnerId() {
  return me?.role === "admin" ? ($("entryUser")?.value || "") : (me?.id || "");
}

function entryFor(record, ownerId = entryOwnerId()) {
  if (ownerId) {
    return ENTRIES.find(entry => entry.recordId === record.id && entry.userId === ownerId);
  }
  const matches = ENTRIES.filter(entry => entry.recordId === record.id);
  return matches.find(e => e.submitted || isDone(e)) || matches[0];
}

async function saveLog(action, detail = "") {
  if (!me?.id || !me?.username || !action) {
    throw new Error("لاگ اِن پروفائل میں یوزر آئی ڈی موجود نہیں؛ users پروفائل درست کریں۔");
  }
  const row = { uid: me.id, username: me.username, action, detail, time: nowStr() };
  const { error } = await supabase.from("logs").insert(row);
  if (error) throw error;
}

function stopListeners() {
  unsubscribers.forEach(unsubscribe => {
    try { unsubscribe(); } catch {}
  });
  unsubscribers = [];
}

function syncStorageKey(userId) {
  return `mtm_sb_rec_sync_${PROJECT_REF}_${userId}`;
}

function openCacheDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("No IndexedDB")); return; }
    const req = indexedDB.open("mtm_sb_cache_v1", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("records")) db.createObjectStore("records");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheGet(key) {
  try {
    const db = await openCacheDb();
    return await new Promise(resolve => {
      const tx = db.transaction("records", "readonly");
      const req = tx.objectStore("records").get(key);
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); resolve(null); };
    });
  } catch {
    return null;
  }
}

async function cachePut(key, docs) {
  try {
    const db = await openCacheDb();
    await new Promise(resolve => {
      const tx = db.transaction("records", "readwrite");
      tx.objectStore("records").put(docs, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    });
  } catch {}
}

async function fetchAll(buildQuery, batchSize = 1000) {
  const all = [];
  for (let from = 0; ; from += batchSize) {
    const { data, error } = await buildQuery(from, from + batchSize - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < batchSize) break;
  }
  return all;
}

function userFromDbRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username || row.username_key || "",
    usernameKey: row.username_key || (row.username || "").toLowerCase(),
    role: normalizeRole(row.role),
    active: !!row.active,
    assignments: Array.isArray(row.assignments) ? row.assignments : [],
    createdAt: row.created_at || ""
  };
}

function entryFromDb(row) {
  return {
    id: row.id,
    recordId: row.record_id,
    userId: row.user_id,
    [K.hifz]: nfc(row.hifz),
    [K.nazra]: nfc(row.nazra),
    submitted: !!row.submitted,
    submittedAt: row.submitted_at || "",
    updatedBy: row.updated_by || "",
    updatedAt: row.updated_at || ""
  };
}

function upsertLocalEntry(entry) {
  const idx = ENTRIES.findIndex(e => e.id === entry.id);
  if (idx >= 0) ENTRIES[idx] = entry;
  else ENTRIES.push(entry);
}

function removeLocalEntry(id) {
  ENTRIES = ENTRIES.filter(e => e.id !== id);
}

function rawFromDbRecord(rec, priv = null) {
  const data = {
    [K.code]: nfc(rec.code),
    [K.name]: nfc(rec.name),
    [K.father]: nfc(rec.father),
    [K.duty]: nfc(rec.duty),
    [K.district]: nfc(rec.district),
    [K.division]: nfc(rec.division),
    [K.province]: nfc(rec.province),
    [K.hifz]: "",
    [K.nazra]: ""
  };
  if (priv) {
    data[K.branch] = nfc(priv.branch);
    data[K.offMin] = nfc(priv.off_min);
    data[K.grade] = nfc(priv.grade);
    data[K.ijaraMin] = nfc(priv.ijara_min);
  }
  return {
    id: rec.id,
    data,
    province: nfc(rec.province),
    division: nfc(rec.division),
    district: nfc(rec.district),
    assignedTo: Array.isArray(rec.assigned_to) ? rec.assigned_to : [],
    sourceKey: nfc(rec.source_key),
    updatedAt: rec.updated_at || "",
    updatedAtMs: Number(rec.updated_at_ms || 0)
  };
}

function rowFromDocData(id, raw) {
  const rawData = raw?.data || {};
  const byNfcKey = {};
  for (const [key, val] of Object.entries(rawData)) {
    byNfcKey[nfc(key).trim()] = nfc(val);
  }
  const isAdmin = me?.role === "admin";
  const normalized = {};
  COLS.forEach(col => {
    if (!isAdmin && ADMIN_ONLY_COLS.includes(col)) return;
    if (byNfcKey[nfc(col)] !== undefined) normalized[col] = byNfcKey[nfc(col)];
  });
  return { id, ...normalized, assignedTo: raw?.assignedTo || [] };
}

function applyRecordDocs() {
  DATA = [...RECORD_DOCS.values()].map(raw => rowFromDocData(raw.id, raw));
  provinces = [...new Set(DATA.map(r => r[K.province]).filter(Boolean))].sort();
  fillProvinceSelects();
  fillUserProvinceFilter();
  fillScopeChecks();
  refreshAll();
}

async function fetchPrivateMapForIds(ids) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const { data, error } = await supabase
      .from("records_private")
      .select("record_id, branch, off_min, grade, ijara_min")
      .in("record_id", chunk);
    if (error) throw error;
    (data || []).forEach(p => map.set(p.record_id, p));
  }
  return map;
}

async function loadRecords(user, forceServer = false) {
  if (!user) return;
  recordsLoading = true;
  try {
    const isAdmin = user.role === "admin";
    const key = syncStorageKey(user.id);
    const lastSyncMs = Number(localStorage.getItem(key) || 0);

    if (!forceServer && lastSyncMs > 0) {
      try {
        const cachedDocs = await cacheGet(key);
        if (!me || me.id !== user.id) return;
        if (Array.isArray(cachedDocs) && cachedDocs.length) {
          RECORD_DOCS = new Map(cachedDocs.map(d => [d.id, d]));
          recordsLoading = false;
          applyRecordDocs();

          let countQuery = supabase.from("records").select("id", { count: "exact", head: true });
          if (!isAdmin) countQuery = countQuery.contains("assigned_to", [user.id]);
          const { count: serverCount, error: countErr } = await countQuery;
          if (!me || me.id !== user.id) return;
          if (!countErr && serverCount === cachedDocs.length) {
            if (isAdmin) {
              const deltaRecs = await fetchAll((from, to) =>
                supabase.from("records")
                  .select("id, code, name, father, duty, district, division, province, assigned_to, source_key, updated_at, updated_at_ms")
                  .gt("updated_at_ms", lastSyncMs)
                  .order("id", { ascending: true })
                  .range(from, to)
              );
              if (!me || me.id !== user.id) return;
              if (deltaRecs.length) {
                const privMap = await fetchPrivateMapForIds(deltaRecs.map(r => r.id));
                if (!me || me.id !== user.id) return;
                deltaRecs.forEach(r => RECORD_DOCS.set(r.id, rawFromDbRecord(r, privMap.get(r.id))));
                await cachePut(key, [...RECORD_DOCS.values()]);
                applyRecordDocs();
              }
              localStorage.setItem(key, String(Math.max(0, Date.now() - 10000)));
              return;
            }
            const { data: latestRow } = await supabase
              .from("records")
              .select("updated_at_ms")
              .contains("assigned_to", [user.id])
              .order("updated_at_ms", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (!me || me.id !== user.id) return;
            const maxServerMs = Number(latestRow?.updated_at_ms || 0);
            if (maxServerMs <= lastSyncMs && Date.now() - lastSyncMs < RECORD_CACHE_TTL_MS) {
              return;
            }
          }
        }
      } catch (cacheErr) {
        console.warn("Cache read skipped, falling back to server:", cacheErr);
      }
    }

    const [recRows, privRows] = await withLoader("ریکارڈز لوڈ ہو رہے ہیں...", async () => {
      const recPromise = fetchAll((from, to) => {
        let q = supabase.from("records")
          .select("id, code, name, father, duty, district, division, province, assigned_to, source_key, updated_at, updated_at_ms");
        if (!isAdmin) q = q.contains("assigned_to", [user.id]);
        return q.order("id", { ascending: true }).range(from, to);
      });
      const privPromise = isAdmin
        ? fetchAll((from, to) =>
            supabase.from("records_private")
              .select("record_id, branch, off_min, grade, ijara_min")
              .order("record_id", { ascending: true })
              .range(from, to)
          )
        : Promise.resolve([]);
      return Promise.all([recPromise, privPromise]);
    });
    if (!me || me.id !== user.id) return;
    const privMap = new Map(privRows.map(p => [p.record_id, p]));
    const docs = recRows.map(r => rawFromDbRecord(r, privMap.get(r.id)));
    RECORD_DOCS = new Map(docs.map(d => [d.id, d]));
    await cachePut(key, docs);
    localStorage.setItem(key, String(Math.max(0, Date.now() - 10000)));
    recordsLoading = false;
    applyRecordDocs();
  } finally {
    recordsLoading = false;
  }
}

function showApp(user) {
  stopListeners();
  me = user;
  lastActive = Date.now();
  loggingOut = false;
  setButtonBusy($("lBtn"), false);
  $("bootView")?.classList.add("hidden");
  $("loginView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  const assignments = assignmentsForUser(user);
  const scope = user.role === "admin" ? "ایڈمن" :
    assignments.map(a => `${a.province}${a.divisions?.length ? ` (${a.divisions.join("، ")})` : ""}`).join("، ");
  $("whoLabel").textContent = `${user.username} (${scope || "کوئی علاقہ اسائن نہیں"})`;
  $("fSearch").placeholder = user.role === "admin" ? "Search name, code, father, branch" : "Search name, code, father";
  document.querySelectorAll(".admin-only").forEach(el => el.classList.toggle("hidden", user.role !== "admin"));

  const isAdmin = user.role === "admin";
  if (isAdmin) {
    supabase.from("users")
      .select("id, username, username_key, role, active, assignments, created_at")
      .order("created_at", { ascending: true })
      .then(({ data, error }) => {
        if (!me || me.id !== user.id) return;
        if (error) { reportError("یوزرز لوڈ نہیں ہو سکے", error); return; }
        USERS = (data || []).map(userFromDbRow);
        usersLoaded = true;
        fillEntryUsers();
        fillReportUsers();
        fillUserProvinceFilter();
        refreshAll();
        if (!$("tab-users").classList.contains("hidden")) renderUsers();
        fillScopeChecks();
      }, err => reportError("یوزرز لوڈ نہیں ہو سکے", err));
    supabase.from("logs")
      .select("id, uid, username, action, detail, time, created_at")
      .order("created_at", { ascending: false })
      .limit(300)
      .then(({ data, error }) => {
        if (!me || me.id !== user.id) return;
        if (error) { reportError("سرگرمی لاگ لوڈ نہیں ہو سکا", error); return; }
        LOG = data || [];
        if (!$("tab-log").classList.contains("hidden")) renderLog();
      }, err => reportError("سرگرمی لاگ لوڈ نہیں ہو سکا", err));
  } else {
    USERS = [user];
    usersLoaded = true;
  }

  loadRecords(user).catch(err => reportError("ڈیٹا لوڈ نہیں ہو سکا", err));

  fetchAll((from, to) => {
    let q = supabase.from("entries")
      .select("id, record_id, user_id, hifz, nazra, submitted, submitted_at, updated_by, updated_at");
    if (!isAdmin) q = q.eq("user_id", user.id);
    return q.order("id", { ascending: true }).range(from, to);
  }).then(rows => {
    if (!me || me.id !== user.id) return;
    ENTRIES = rows.map(entryFromDb);
    entriesLoaded = true;
    refreshAll();
  }).catch(err => reportError("انٹریاں لوڈ نہیں ہو سکیں", err));

  const channel = supabase.channel(`mtm-live-${user.id}`);
  channel.on(
    "postgres_changes",
    isAdmin
      ? { event: "*", schema: "public", table: "entries" }
      : { event: "*", schema: "public", table: "entries", filter: `user_id=eq.${user.id}` },
    payload => {
      if (!me || me.id !== user.id) return;
      if (payload.eventType === "DELETE") {
        if (payload.old?.id) removeLocalEntry(payload.old.id);
      } else if (payload.new?.id) {
        upsertLocalEntry(entryFromDb(payload.new));
      }
      refreshAll();
    }
  );

  if (isAdmin) {
    channel.on("postgres_changes", { event: "*", schema: "public", table: "users" }, payload => {
      if (!me || me.id !== user.id) return;
      if (payload.eventType === "DELETE") {
        if (payload.old?.id) USERS = USERS.filter(u => u.id !== payload.old.id);
      } else if (payload.new?.id) {
        const mapped = userFromDbRow(payload.new);
        const idx = USERS.findIndex(u => u.id === mapped.id);
        if (idx >= 0) USERS[idx] = mapped;
        else USERS.push(mapped);
        if (mapped.id === me.id) me = { ...me, ...mapped };
      }
      fillEntryUsers();
      fillReportUsers();
      fillUserProvinceFilter();
      refreshAll();
      if (!$("tab-users").classList.contains("hidden")) renderUsers();
      fillScopeChecks();
    });
    channel.on("postgres_changes", { event: "INSERT", schema: "public", table: "logs" }, payload => {
      if (!me || me.id !== user.id || !payload.new) return;
      LOG = [payload.new, ...LOG].slice(0, 300);
      if (!$("tab-log").classList.contains("hidden")) renderLog();
    });
  } else {
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "users", filter: `id=eq.${user.id}` },
      async payload => {
        if (!me || me.id !== user.id) return;
        const updated = payload.new ? userFromDbRow(payload.new) : null;
        if (payload.eventType === "DELETE" || !updated || !updated.active) {
          await supabase.auth.signOut().catch(() => {});
          returnToLogin("یہ اکاؤنٹ غیر فعال یا حذف کر دیا گیا ہے۔");
          return;
        }
        me = { ...me, ...updated };
        USERS = [me];
        const scopeText = assignmentsForUser(me)
          .map(a => `${a.province}${a.divisions?.length ? ` (${a.divisions.join("، ")})` : ""}`).join("، ");
        $("whoLabel").textContent = `${me.username} (${scopeText || "کوئی علاقہ اسائن نہیں"})`;
        loadRecords(me, true).catch(err => reportError("ڈیٹا اپڈیٹ نہیں ہو سکا", err));
      }
    );
  }
  channel.subscribe();
  unsubscribers.push(() => { supabase.removeChannel(channel); });

  if (isAdmin) fillEntryUsers();
  fillProvinceSelects();
  refreshAll();
}

function resetLoginPassword() {
  $("showPass").checked = false;
  $("lPass").type = "password";
}

function resetAllFilters() {
  ["fSearch", "fStatus", "uSearch", "uFilterRole", "uFilterProvince", "uFilterStatus"].forEach(id => {
    if ($(id)) $(id).value = "";
  });
  Object.values(multiFilters).forEach(mf => mf.clear(true));
  page = 1;
}

function returnToLogin(message = "") {
  stopListeners();
  activeUid = null;
  me = null; DATA = []; USERS = []; ENTRIES = []; LOG = [];
  usersLoaded = false; entriesLoaded = false; loggingOut = false; recordsLoading = false; pendingScopeSelection = null;
  RECORD_DOCS.clear();
  DRAFT_ENTRIES.clear();
  resetAllFilters();
  setButtonBusy($("lBtn"), false);
  $("bootView")?.classList.add("hidden");
  $("appView").classList.add("hidden");
  $("loginView").classList.remove("hidden");
  resetLoginPassword();
  showError(message);
}

async function fetchUserProfile(uid) {
  const { data, error } = await supabase
    .from("users")
    .select("id, username, username_key, role, active, assignments, created_at")
    .eq("id", uid)
    .maybeSingle();
  if (error) throw error;
  return data;
}

let activeUid = null;
let authChain = Promise.resolve();

async function handleAuthSession(session) {
  const account = session?.user || null;
  if (!account) {
    returnToLogin();
    return;
  }
  if (activeUid === account.id && me?.id === account.id) {
    return;
  }
  activeUid = account.id;
  const showOverlay = $("bootView")?.classList.contains("hidden");
  if (showOverlay) showLoader("لاگ اِن کی تصدیق ہو رہی ہے...");
  try {
    const profile = await fetchUserProfile(account.id);
    if (!profile || !profile.active) {
      await supabase.auth.signOut().catch(() => {});
      returnToLogin("یہ اکاؤنٹ غیر فعال ہے یا ایڈمن نے ابھی بنایا نہیں۔");
      return;
    }
    const role = normalizeRole(profile.role);
    if (!role) {
      throw new Error(`users پروفائل میں role کی ویلیو "${profile.role ?? "خالی"}" درست نہیں؛ "admin" یا "user" ہونی چاہیے۔`);
    }
    const username = typeof profile.username === "string" && profile.username.trim()
      ? profile.username.trim()
      : account.email?.endsWith(`@${EMAIL_DOMAIN}`)
        ? account.email.slice(0, account.email.indexOf("@"))
        : "";
    if (!username) throw new Error("یوزر پروفائل میں username موجود نہیں، اور Authentication اکاؤنٹ میں قابلِ شناخت یوزر آئی ڈی نہیں۔");
    const mapped = userFromDbRow({ ...profile, username, role });
    showApp(mapped);
    saveLog("لاگ اِن").catch(error => reportError("لاگ اِن لاگ محفوظ نہیں ہوا", error));
  } catch (error) {
    await supabase.auth.signOut().catch(() => {});
    const msg = error?.code === "42501"
      ? "یہ اکاؤنٹ غیر فعال یا حذف کر دیا گیا ہے۔"
      : `اکاؤنٹ کی معلومات نہیں مل سکیں: ${error.message}`;
    returnToLogin(msg);
  } finally {
    if (showOverlay) hideLoader();
  }
}

supabase.auth.onAuthStateChange((event, session) => {
  if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") return;
  setTimeout(() => {
    authChain = authChain.then(() => handleAuthSession(session)).catch(err => {
      console.error("Auth error:", err);
      setButtonBusy($("lBtn"), false);
      $("bootView")?.classList.add("hidden");
      $("loginView").classList.remove("hidden");
      showError(`Supabase لاگ اِن تیار نہیں: ${err.message}`);
    });
  }, 0);
});

$("showPass").addEventListener("change", () => {
  $("lPass").type = $("showPass").checked ? "text" : "password";
});

$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const username = $("lUser").value.trim();
  const password = $("lPass").value;
  const problem = nameProblem(username);
  if (problem) { showError(problem); return; }
  setButtonBusy($("lBtn"), true, "لاگ اِن ہو رہا ہے...");
  showError("");
  try {
    const { error } = await supabase.auth.signInWithPassword({
      email: userEmail(username),
      password
    });
    if (error) throw error;
    $("lPass").value = "";
    resetLoginPassword();
  } catch (error) {
    setButtonBusy($("lBtn"), false);
    const msg = String(error?.message || "");
    showError(error?.status === 429 || /rate limit|too many/i.test(msg)
      ? "بہت سی ناکام کوششیں؛ کچھ دیر بعد دوبارہ کوشش کریں۔"
      : "یوزر آئی ڈی یا پاس ورڈ درست نہیں۔");
  }
});

$("logoutBtn").addEventListener("click", async () => {
  try {
    await withLoader("لاگ آؤٹ ہو رہا ہے...", async () => {
      await saveLog("لاگ آؤٹ");
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    });
  } catch (error) {
    reportError("لاگ آؤٹ مکمل نہیں ہو سکا", error);
  }
});

["click", "keydown", "change", "scroll"].forEach(name =>
  document.addEventListener(name, () => { lastActive = Date.now(); }, { passive: true }));

setInterval(async () => {
  if (!me || loggingOut || Date.now() - lastActive <= IDLE_MS) return;
  loggingOut = true;
  try { await saveLog("خودکار لاگ آؤٹ (خاموشی)"); }
  catch (error) { console.error("Could not save automatic logout log", error); }
  try {
    await supabase.auth.signOut();
    alert("خاموشی کی وجہ سے آپ کو لاگ آؤٹ کر دیا گیا ہے۔");
  } catch (error) {
    loggingOut = false;
    reportError("خودکار لاگ آؤٹ مکمل نہیں ہو سکا", error);
  }
}, 15000);

function createMultiFilter(containerId, allLabel, pluralLabel, onChange) {
  const wrap = $(containerId);
  wrap.innerHTML = `<button type="button" class="ms-btn"><span class="ms-text">${esc(allLabel)}</span><span class="ms-caret">▾</span></button>
    <div class="ms-menu hidden">
      <div class="ms-top"><input type="text" class="ms-search" placeholder="تلاش..."><button type="button" class="ms-clear">صاف</button></div>
      <div class="ms-list"></div>
    </div>`;
  const btn = wrap.querySelector(".ms-btn");
  const textEl = wrap.querySelector(".ms-text");
  const menu = wrap.querySelector(".ms-menu");
  const searchEl = wrap.querySelector(".ms-search");
  const clearBtn = wrap.querySelector(".ms-clear");
  const listEl = wrap.querySelector(".ms-list");
  const selected = new Set();
  let options = [];

  function updateLabel() {
    if (!selected.size) {
      textEl.textContent = allLabel;
      btn.classList.remove("active");
    } else if (selected.size === 1) {
      textEl.textContent = [...selected][0];
      btn.classList.add("active");
    } else {
      textEl.textContent = `${selected.size} ${pluralLabel}`;
      btn.classList.add("active");
    }
    btn.title = selected.size ? [...selected].join("، ") : allLabel;
  }

  function applySearch() {
    const q = searchEl.value.trim().toLowerCase();
    listEl.querySelectorAll(".ms-opt").forEach(opt => {
      opt.classList.toggle("hidden", !!(q && !opt.dataset.val.toLowerCase().includes(q)));
    });
  }

  function renderList() {
    listEl.innerHTML = options.length
      ? options.map(val => `<label class="ms-opt" data-val="${esc(val)}"><input type="checkbox" value="${esc(val)}" ${selected.has(val) ? "checked" : ""}><span>${esc(val)}</span></label>`).join("")
      : '<div class="ms-empty">کوئی آپشن نہیں</div>';
    applySearch();
  }

  btn.addEventListener("click", event => {
    event.stopPropagation();
    const wasHidden = menu.classList.contains("hidden");
    document.querySelectorAll(".ms-menu").forEach(m => m.classList.add("hidden"));
    if (wasHidden) {
      menu.classList.remove("hidden");
      menu.style.right = "0";
      menu.style.left = "auto";
      if (menu.getBoundingClientRect().left < 8) {
        menu.style.right = "auto";
        menu.style.left = "0";
      }
      if (options.length > 8) searchEl.focus();
    }
  });

  menu.addEventListener("click", event => event.stopPropagation());
  searchEl.addEventListener("input", applySearch);
  listEl.addEventListener("change", event => {
    const cb = event.target;
    if (cb.type !== "checkbox") return;
    if (cb.checked) selected.add(cb.value);
    else selected.delete(cb.value);
    updateLabel();
    onChange();
  });
  clearBtn.addEventListener("click", () => {
    if (!selected.size && !searchEl.value) return;
    selected.clear();
    searchEl.value = "";
    renderList();
    updateLabel();
    onChange();
  });

  return {
    setOptions(values) {
      options = values;
      const valid = new Set(values);
      for (const item of [...selected]) {
        if (!valid.has(item)) selected.delete(item);
      }
      renderList();
      updateLabel();
    },
    getSelected() { return selected; },
    clear(silent = false) {
      selected.clear();
      searchEl.value = "";
      renderList();
      updateLabel();
      if (!silent) onChange();
    }
  };
}

document.addEventListener("click", () => document.querySelectorAll(".ms-menu").forEach(m => m.classList.add("hidden")));
document.addEventListener("keydown", event => {
  if (event.key === "Escape") document.querySelectorAll(".ms-menu").forEach(m => m.classList.add("hidden"));
});

const multiFilters = {
  province: createMultiFilter("fProvince", "تمام صوبے", "صوبے", () => { page = 1; fillFilters(); renderTable(); }),
  division: createMultiFilter("fDivision", "تمام ڈویژنز", "ڈویژنز", () => { page = 1; fillFilters(); renderTable(); }),
  district: createMultiFilter("fDistrict", "تمام اضلاع", "اضلاع", () => { page = 1; fillFilters(); renderTable(); }),
  branch:   createMultiFilter("fBranch",   "تمام شاخیں", "شاخیں", () => { page = 1; fillFilters(); renderTable(); }),
  duty:     createMultiFilter("fDuty",     "تمام ذمہ داریاں", "ذمہ داریاں", () => { page = 1; renderTable(); })
};

function fillProvinceSelects() {
  if (!me) return;
  const provList = me.role === "admin"
    ? provinces
    : [...new Set(visibleRows().map(r => r[K.province]).filter(Boolean))].sort();
  multiFilters.province.setOptions(provList);
  $("fProvince").classList.toggle("hidden", me.role !== "admin" && provList.length <= 1);
}

function fillFilter(select, label, values) {
  const current = select.value;
  select.innerHTML = `<option value="">${label}</option>` +
    values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join("");
  if (values.includes(current)) select.value = current;
}

function fillFilters() {
  let rows = visibleRows();
  const selProvs = $("fProvince").classList.contains("hidden") ? new Set() : multiFilters.province.getSelected();
  if (selProvs.size) rows = rows.filter(r => selProvs.has(r[K.province]));
  const unique = field => [...new Set(rows.map(r => r[field]).filter(Boolean))].sort();

  multiFilters.division.setOptions(unique(K.division));
  const selDivs = multiFilters.division.getSelected();
  if (selDivs.size) rows = rows.filter(r => selDivs.has(r[K.division]));

  multiFilters.district.setOptions(unique(K.district));
  const selDists = multiFilters.district.getSelected();
  if (selDists.size) rows = rows.filter(r => selDists.has(r[K.district]));

  if (!$("fBranch").classList.contains("hidden")) {
    multiFilters.branch.setOptions(unique(K.branch));
    const selBranches = multiFilters.branch.getSelected();
    if (selBranches.size) rows = rows.filter(r => selBranches.has(r[K.branch]));
  } else {
    multiFilters.branch.clear(true);
  }

  multiFilters.duty.setOptions(unique(K.duty));
}

function parseEnGbMs(str) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}),?\s+(\d{2}):(\d{2}):(\d{2})/.exec(String(str || "").trim());
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]) : 0;
}

function filteredRows() {
  const search = $("fSearch").value.trim().toLowerCase();
  const isAdmin = me?.role === "admin";
  const ownerId = entryOwnerId();
  const selProvs = $("fProvince").classList.contains("hidden") ? new Set() : multiFilters.province.getSelected();
  const selDivs = multiFilters.division.getSelected();
  const selDists = multiFilters.district.getSelected();
  const selBranches = $("fBranch").classList.contains("hidden") ? new Set() : multiFilters.branch.getSelected();
  const selDuties = multiFilters.duty.getSelected();
  const status = $("fStatus").value;
  const rows = visibleRows().filter(row => {
    if (selProvs.size && !selProvs.has(row[K.province])) return false;
    if (selDivs.size && !selDivs.has(row[K.division])) return false;
    if (selDists.size && !selDists.has(row[K.district])) return false;
    if (selBranches.size && !selBranches.has(row[K.branch])) return false;
    if (selDuties.size && !selDuties.has(row[K.duty])) return false;
    const entry = entryFor(row, ownerId);
    if (status === "done" && !isDone(entry)) return false;
    if (status === "pending" && isDone(entry)) return false;
    const searchFields = isAdmin
      ? [row[K.name], row[K.code], row[K.father], row[K.branch], row[K.duty]]
      : [row[K.name], row[K.code], row[K.father], row[K.duty]];
    if (search && !searchFields.some(v => String(v || "").toLowerCase().includes(search))) return false;
    return true;
  });
  if (!isAdmin) {
    rows.sort((a, b) => {
      const ea = entryFor(a, ownerId);
      const eb = entryFor(b, ownerId);
      const la = isEntryLocked(ea) ? 1 : 0;
      const lb = isEntryLocked(eb) ? 1 : 0;
      if (la !== lb) return la - lb;
      if (la) return parseEnGbMs(ea.submittedAt || ea.updatedAt) - parseEnGbMs(eb.submittedAt || eb.updatedAt);
      return 0;
    });
  }
  return rows;
}

const opts = value => `<option value="">-- منتخب کریں --</option>` +
  `<option value="${YES}" ${value === YES ? "selected" : ""}>${YES}</option>` +
  `<option value="${NO}" ${value === NO ? "selected" : ""}>${NO}</option>`;

const selClass = value => value === YES ? "val-yes" : value === NO ? "val-no" : "empty";

function isEntryLocked(entry) {
  return !!(entry && (entry.submitted === true || (entry[K.hifz] && entry[K.nazra])));
}

function showConfirmModal({ icon = "⚠️", title = "تصدیقِ اندراج", message = "", detailsHtml = "", okText = "ہاں، جمع کریں", cancelText = "منسوخ کریں", showCancel = true }) {
  return new Promise(resolve => {
    const dlg = $("confirmDlg");
    $("confirmIcon").textContent = icon;
    $("confirmTitle").textContent = title;
    $("confirmMsg").textContent = message;
    if (detailsHtml) {
      $("confirmDetails").innerHTML = detailsHtml;
      $("confirmDetails").classList.remove("hidden");
    } else {
      $("confirmDetails").innerHTML = "";
      $("confirmDetails").classList.add("hidden");
    }
    $("confirmOkBtn").textContent = okText;
    $("confirmCancelBtn").textContent = cancelText;
    $("confirmCancelBtn").classList.toggle("hidden", !showCancel);

    const cleanup = result => {
      $("confirmOkBtn").onclick = null;
      $("confirmCancelBtn").onclick = null;
      dlg.oncancel = null;
      if (dlg.open) dlg.close();
      resolve(result);
    };
    $("confirmOkBtn").onclick = () => cleanup(true);
    $("confirmCancelBtn").onclick = () => cleanup(false);
    dlg.oncancel = event => { event.preventDefault(); cleanup(false); };
    dlg.showModal();
  });
}

function renderTable() {
  if (!me) return;
  const rows = filteredRows();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (page > pages) page = pages;
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const ownerId = entryOwnerId();
  const isAdmin = me.role === "admin";
  $("dataTable").querySelector("tbody").innerHTML = slice.map((row, i) => {
    const saved = entryFor(row, ownerId) || {};
    const locked = isEntryLocked(saved);
    const editable = isAdmin || !locked;
    const entry = editable && DRAFT_ENTRIES.has(row.id) ? DRAFT_ENTRIES.get(row.id) : saved;
    const ownerUser = saved.userId ? USERS.find(u => u.id === saved.userId) : null;
    const ownerBadge = ownerUser ? ownerUser.username : (saved.updatedBy || "");
    let actionCell;
    if (locked && !isAdmin) {
      actionCell = '<span class="tag submitted-tag">✓ جمع شدہ</span>';
    } else if (locked && isAdmin) {
      const label = ownerBadge ? `✓ ${esc(ownerBadge)}` : "✓ جمع شدہ";
      actionCell = `<span class="tag submitted-tag">${label}</span> <button type="button" class="btn-light row-submit-btn" data-act="submit-row" data-id="${esc(row.id)}">اپڈیٹ</button>`;
    } else {
      actionCell = `<button type="button" class="btn row-submit-btn" data-act="submit-row" data-id="${esc(row.id)}">جمع کریں</button>`;
    }
    return `<tr class="${isDone(saved) ? "done" : "pending"}">
      <td>${(page - 1) * PAGE_SIZE + i + 1}</td>
      <td>${esc(row[K.code])}</td><td>${esc(row[K.name])}</td><td>${esc(row[K.father])}</td>
      ${isAdmin ? `<td>${esc(row[K.branch])}</td>` : ""}<td>${esc(row[K.duty])}</td><td>${esc(row[K.district])}</td>
      <td>${esc(row[K.division])}</td>${isAdmin ? `<td>${esc(row[K.province])}</td>` : ""}
      ${isAdmin ? `<td>${esc(row[K.offMin])}</td><td>${esc(row[K.grade])}</td><td>${esc(row[K.ijaraMin])}</td>` : ""}
      <td><select ${editable ? "" : "disabled"} class="${selClass(entry[K.hifz])}" data-id="${esc(row.id)}" data-f="hifz">${opts(entry[K.hifz])}</select></td>
      <td><select ${editable ? "" : "disabled"} class="${selClass(entry[K.nazra])}" data-id="${esc(row.id)}" data-f="nazra">${opts(entry[K.nazra])}</select></td>
      <td>${actionCell}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="${isAdmin ? 15 : 10}" class="center">کوئی ریکارڈ نہیں ملا</td></tr>`;
  $("pager").innerHTML = `<button id="pPrev" ${page <= 1 ? "disabled" : ""}>پچھلا</button>
    <span>صفحہ ${page} / ${pages} &nbsp;(کل ${rows.length})</span>
    <button id="pNext" ${page >= pages ? "disabled" : ""}>اگلا</button>`;
  $("pPrev").onclick = () => { page--; renderTable(); };
  $("pNext").onclick = () => { page++; renderTable(); };
}

function renderMini() {
  const rows = visibleRows();
  const done = rows.filter(row => isDone(entryFor(row))).length;
  $("miniSummary").innerHTML = `<div><b>${rows.length}</b>کل مدرسین</div>
    <div><b>${done}</b>انٹری مکمل</div><div class="rem"><b>${rows.length - done}</b>باقی</div>`;
}

function refreshAll() {
  if (!me) return;
  fillFilters();
  renderMini();
  renderTable();
  if (me.role === "admin" && !$("tab-report").classList.contains("hidden")) renderReport();
}

function fixPair(entry, changed) {
  if (changed === "hifz" && entry[K.hifz] === YES) entry[K.nazra] = NO;
  else if (changed === "nazra" && entry[K.nazra] === YES) entry[K.hifz] = NO;
  else if (!changed && entry[K.hifz] === YES) entry[K.nazra] = NO;
  else if (!changed && entry[K.nazra] === YES) entry[K.hifz] = NO;
}

$("dataTable").addEventListener("change", event => {
  const select = event.target;
  if (select.tagName !== "SELECT" || !select.dataset.id) return;
  const row = DATA.find(r => r.id === select.dataset.id);
  const saved = row ? (entryFor(row) || {}) : {};
  const isAdmin = me?.role === "admin";
  if (!row || (!isAdmin && (!row.assignedTo?.includes(me.id) || isEntryLocked(saved)))) {
    refreshAll();
    return;
  }
  if (!["hifz", "nazra"].includes(select.dataset.f) || ![YES, NO, ""].includes(select.value)) {
    refreshAll();
    return;
  }
  const current = DRAFT_ENTRIES.get(row.id) || {
    [K.hifz]: saved[K.hifz] || "", [K.nazra]: saved[K.nazra] || ""
  };
  const draft = { [K.hifz]: current[K.hifz] || "", [K.nazra]: current[K.nazra] || "" };
  draft[K[select.dataset.f]] = select.value;
  fixPair(draft, select.dataset.f);
  DRAFT_ENTRIES.set(row.id, draft);

  const tr = select.closest("tr");
  if (tr) {
    const hifzSel = tr.querySelector('select[data-f="hifz"]');
    const nazraSel = tr.querySelector('select[data-f="nazra"]');
    if (hifzSel) {
      hifzSel.value = draft[K.hifz];
      hifzSel.className = selClass(draft[K.hifz]);
    }
    if (nazraSel) {
      nazraSel.value = draft[K.nazra];
      nazraSel.className = selClass(draft[K.nazra]);
    }
  }
});

$("dataTable").addEventListener("click", async event => {
  const button = event.target.closest('button[data-act="submit-row"]');
  if (!button) return;
  const row = DATA.find(r => r.id === button.dataset.id);
  const saved = row ? (entryFor(row) || {}) : {};
  const isAdmin = me?.role === "admin";
  if (!row || (!isAdmin && (!row.assignedTo?.includes(me.id) || isEntryLocked(saved)))) {
    await showConfirmModal({
      icon: "⛔", title: "اجازت نہیں",
      message: "اس ریکارڈ میں تبدیلی کی اجازت نہیں ہے۔",
      okText: "ٹھیک ہے", showCancel: false
    });
    refreshAll();
    return;
  }

  const draft = DRAFT_ENTRIES.get(row.id) || {
    [K.hifz]: saved[K.hifz] || "", [K.nazra]: saved[K.nazra] || ""
  };
  if (!isAdmin && (![YES, NO].includes(draft[K.hifz]) || ![YES, NO].includes(draft[K.nazra]))) {
    await showConfirmModal({
      icon: "ℹ️", title: "نامکمل معلومات",
      message: "براہِ کرم جمع کرانے سے پہلے حفظ اور ناظرہ دونوں سوالات کے جواب منتخب کریں۔",
      okText: "ٹھیک ہے", showCancel: false
    });
    return;
  }

  const isClearing = isAdmin && !draft[K.hifz] && !draft[K.nazra];
  if (isClearing && !saved.id) {
    await showConfirmModal({
      icon: "ℹ️", title: "کوئی انٹری نہیں",
      message: "اس ریکارڈ میں ابھی کوئی انٹری محفوظ نہیں ہے۔",
      okText: "ٹھیک ہے", showCancel: false
    });
    return;
  }

  const isUpdate = isAdmin && isEntryLocked(saved);
  const detailsHtml = `
    <div><b>عملہ کوڈ:</b> ${esc(row[K.code])}</div>
    <div><b>نام:</b> ${esc(row[K.name])} (${esc(row[K.father])})</div>
    <div><b>حفظ کا درجہ:</b> ${esc(draft[K.hifz] || "خالی")}</div>
    <div><b>ناظرہ کا درجہ:</b> ${esc(draft[K.nazra] || "خالی")}</div>
  `;
  const confirmed = await showConfirmModal({
    icon: "⚠️",
    title: isClearing ? "انٹری ختم کرنے کی تصدیق" : (isUpdate ? "اندراج اپڈیٹ کرنے کی تصدیق" : "ڈیٹا جمع کرانے کی تصدیق"),
    message: isClearing
      ? "کیا آپ واقعی یہ محفوظ شدہ انٹری ختم (خالی) کرنا چاہتے ہیں؟ اس کے بعد یوزر دوبارہ انٹری کر سکے گا۔"
      : (isUpdate
        ? "کیا آپ واقعی اس اندراج میں کی گئی تبدیلی محفوظ کرنا چاہتے ہیں؟"
        : "کیا آپ واقعی یہ ڈیٹا جمع کرنا چاہتے ہیں؟ کیونکہ بعد میں اس میں تبدیلی نہیں ہوگی۔"),
    detailsHtml,
    okText: isClearing ? "ہاں، ختم کریں" : (isUpdate ? "ہاں، اپڈیٹ کریں" : "ہاں، جمع کریں"),
    cancelText: "منسوخ کریں",
    showCancel: true
  });
  if (!confirmed) return;

  setButtonBusy(button, true, isClearing ? "ختم ہو رہی ہے..." : "محفوظ ہو رہا ہے...");
  const targetUserId = saved.userId || entryOwnerId() || me.id;
  const entryDocId = saved.id || `${row.id}__${targetUserId}`;
  const now = nowStr();
  const entry = {
    recordId: row.id,
    userId: targetUserId,
    [K.hifz]: draft[K.hifz],
    [K.nazra]: draft[K.nazra],
    submitted: isDone(draft),
    submittedAt: isDone(draft) ? (saved.submittedAt || now) : "",
    updatedBy: me.username,
    updatedAt: now
  };
  try {
    await withLoader(isClearing ? "انٹری ختم کی جا رہی ہے..." : "ڈیٹا محفوظ ہو رہا ہے...", async () => {
      if (isClearing) {
        const { error } = await supabase.from("entries").delete().eq("id", entryDocId);
        if (error) throw error;
        removeLocalEntry(entryDocId);
      } else {
        const dbEntry = {
          id: entryDocId,
          record_id: row.id,
          user_id: targetUserId,
          hifz: draft[K.hifz],
          nazra: draft[K.nazra],
          submitted: isDone(draft),
          submitted_at: isDone(draft) ? (saved.submittedAt || now) : "",
          updated_by: me.username,
          updated_at: now
        };
        const { error } = await supabase.from("entries").upsert(dbEntry, { onConflict: "id" });
        if (error) throw error;
        upsertLocalEntry(entryFromDb(dbEntry));
      }
      DRAFT_ENTRIES.delete(row.id);
    });
    setButtonBusy(button, false);
    refreshAll();
    const logAction = isClearing ? "انٹری ختم" : (isUpdate ? "انٹری اپڈیٹ" : "انٹری جمع");
    const logDetail = isClearing
      ? `${row[K.code]} — انٹری خالی کر دی گئی`
      : `${row[K.code]} — حفظ: ${entry[K.hifz] || "-"}، ناظرہ: ${entry[K.nazra] || "-"}`;
    saveLog(logAction, logDetail)
      .catch(error => reportError("کارروائی مکمل ہو گئی، مگر سرگرمی لاگ محفوظ نہیں ہوا", error));
  } catch (error) {
    setButtonBusy(button, false);
    await showConfirmModal({
      icon: "❌", title: "خرابی",
      message: `انٹری محفوظ نہیں ہو سکی: ${error?.message || error}`,
      okText: "ٹھیک ہے", showCancel: false
    });
  }
});

$("fSearch").addEventListener("input", () => { page = 1; renderTable(); });
$("fStatus").addEventListener("change", () => { page = 1; renderTable(); });
$("clearFiltersBtn").addEventListener("click", () => {
  $("fSearch").value = "";
  $("fStatus").value = "";
  Object.values(multiFilters).forEach(mf => mf.clear(true));
  page = 1;
  fillFilters();
  renderTable();
});

function fillEntryUsers() {
  if (!me || me.role !== "admin") return;
  const select = $("entryUser");
  const current = select.value;
  select.innerHTML = '<option value="">تمام یوزرز</option>' + USERS.map(user =>
    `<option value="${esc(user.id)}">${esc(user.username)}${user.id === me.id ? " (ایڈمن)" : ""}</option>`
  ).join("");
  select.value = USERS.some(user => user.id === current) ? current : "";
}
function fillReportUsers() {
  if (!me || me.role !== "admin") return;
  const select = $("reportUser");
  const current = select.value;
  select.innerHTML = '<option value="">تمام یوزرز</option>' + USERS.map(user =>
    `<option value="${esc(user.id)}">${esc(user.username)}${user.active ? "" : " (غیر فعال)"}</option>`
  ).join("");
  select.value = USERS.some(user => user.id === current) ? current : "";
}
$("entryUser").addEventListener("change", () => {
  DRAFT_ENTRIES.clear();
  page = 1;
  fillProvinceSelects();
  refreshAll();
});
$("reportUser").addEventListener("change", renderReport);

$("refreshBtn").addEventListener("click", async () => {
  if (!me) return;
  const button = $("refreshBtn");
  setButtonBusy(button, true, "تازہ ہو رہا ہے...");
  try {
    await loadRecords(me, true);
  } catch (error) {
    reportError("تازہ ڈیٹا لوڈ نہیں ہو سکا", error);
  } finally {
    setButtonBusy(button, false);
  }
});

$("exportBtn").addEventListener("click", () => {
  const ownerId = entryOwnerId();
  const exportCols = me.role === "admin"
    ? COLS
    : COLS.filter(col => !ADMIN_ONLY_COLS.includes(col));
  const rows = filteredRows().map(row => {
    const entry = entryFor(row, ownerId) || {};
    const output = {};
    exportCols.forEach(col => output[col] = col === K.hifz || col === K.nazra ? entry[col] || "" : row[col] ?? "");
    output[EXTRA_COLS[0]] = entry.updatedBy || "";
    output[EXTRA_COLS[1]] = entry.updatedAt || "";
    return output;
  });
  const sheet = XLSX.utils.json_to_sheet(rows, { header: exportCols.concat(EXTRA_COLS) });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "مدرسین");
  XLSX.writeFile(book, `teachers_${me.username}.xlsx`);
  saveLog("ایکسل ایکسپورٹ", `${rows.length} ریکارڈ`).catch(error => reportError("لاگ محفوظ نہیں ہوا", error));
});

$("templateBtn").addEventListener("click", () => {
  if (me?.role !== "admin") return;
  const sheet = XLSX.utils.aoa_to_sheet([COLS]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "مدرسین");
  XLSX.writeFile(book, "blank_form.xlsx");
});

function normalizeRecord(input) {
  const byNfcKey = {};
  for (const [key, val] of Object.entries(input || {})) {
    byNfcKey[nfc(key).trim()] = val;
  }
  const row = {};
  COLS.forEach(col => row[col] = clean(byNfcKey[nfc(col)]));
  if (!row[K.code] || !row[K.province]) return null;
  row[K.hifz] = "";
  row[K.nazra] = "";
  return row;
}

function userCanSeeRegion(user, row) {
  return user.role === "admin" || hasRegion(user, row);
}

function buildRecordPayload(row, updatedAt, updatedAtMs) {
  const assignedTo = USERS.filter(user => user.active && userCanSeeRegion(user, row)).map(user => user.id);
  const id = recordId(row);
  return {
    recRow: {
      id,
      code: row[K.code],
      name: row[K.name] || "",
      father: row[K.father] || "",
      duty: row[K.duty] || "",
      district: row[K.district] || "",
      division: row[K.division] || "",
      province: row[K.province],
      assigned_to: assignedTo,
      source_key: `${row[K.code]}|${row[K.province]}`,
      updated_at: updatedAt,
      updated_at_ms: updatedAtMs
    },
    privRow: {
      record_id: id,
      branch: row[K.branch] || "",
      off_min: row[K.offMin] || "",
      grade: row[K.grade] || "",
      ijara_min: row[K.ijaraMin] || ""
    },
    docPayload: {
      id,
      data: row,
      province: row[K.province],
      division: row[K.division],
      district: row[K.district],
      assignedTo,
      sourceKey: `${row[K.code]}|${row[K.province]}`,
      updatedAt,
      updatedAtMs
    }
  };
}

async function uploadRecords(inputRows, sourceName) {
  if (!usersLoaded) throw new Error("یوزرز لوڈ ہونے تک انتظار کریں اور دوبارہ امپورٹ کریں۔");
  const normalized = new Map();
  let skipped = 0;
  inputRows.forEach(input => {
    if (!input || typeof input !== "object") { skipped++; return; }
    const row = normalizeRecord(input);
    if (!row) { skipped++; return; }
    normalized.set(recordId(row), row);
  });
  const entries = [...normalized.entries()];
  const updatedAt = nowStr(), updatedAtMs = Date.now();
  for (let offset = 0; offset < entries.length; offset += 400) {
    const chunk = entries.slice(offset, offset + 400);
    const recRows = [], privRows = [];
    chunk.forEach(([id, row]) => {
      const built = buildRecordPayload(row, updatedAt, updatedAtMs);
      recRows.push(built.recRow);
      privRows.push(built.privRow);
      const prev = RECORD_DOCS.get(id) || {};
      RECORD_DOCS.set(id, { ...prev, ...built.docPayload });
    });
    const { error: recErr } = await supabase.from("records").upsert(recRows, { onConflict: "id" });
    if (recErr) throw recErr;
    const { error: privErr } = await supabase.from("records_private").upsert(privRows, { onConflict: "record_id" });
    if (privErr) throw privErr;
  }
  await cachePut(syncStorageKey(me.id), [...RECORD_DOCS.values()]);
  localStorage.setItem(syncStorageKey(me.id), String(Math.max(0, Date.now() - 10000)));
  applyRecordDocs();
  await saveLog("امپورٹ", `${sourceName}: ${entries.length} ریکارڈ، رد ${skipped}`);
  alert(`امپورٹ مکمل\nریکارڈ: ${entries.length}\nرد (کوڈ یا صوبہ خالی): ${skipped}`);
}

$("importFile").addEventListener("change", event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || me?.role !== "admin") return;
  if (!/\.(xlsx|xls|csv|json)$/i.test(file.name) || file.size > 15 * 1024 * 1024) {
    alert("صرف xlsx/xls/csv/json اور 15MB تک کی فائل");
    return;
  }
  const reader = new FileReader();
  reader.onload = async loadEvent => {
    try {
      await withLoader("فائل امپورٹ ہو رہی ہے...", async () => {
        let rows;
        if (/\.json$/i.test(file.name)) {
          rows = JSON.parse(new TextDecoder("utf-8").decode(loadEvent.target.result));
          if (!Array.isArray(rows)) throw new Error("JSON فائل ریکارڈز کی فہرست ہونی چاہیے");
        } else {
          const workbook = XLSX.read(loadEvent.target.result, { type: "array" });
          rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "", raw: false });
        }
        await uploadRecords(rows, file.name);
      });
    } catch (error) {
      reportError("فائل امپورٹ نہیں ہو سکی", error);
    }
  };
  reader.readAsArrayBuffer(file);
});

function reportRow(label, group) {
  const remaining = group.total - group.done;
  const percent = group.total ? Math.round(group.done * 100 / group.total) : 0;
  return `<tr><td>${esc(label)}</td><td>${group.total}</td><td>${group.done}</td>
    <td class="rem-num">${remaining}</td><td>${percent}%<span class="bar"><i style="width:${percent}%"></i></span></td></tr>`;
}

function renderGroupedReport(field, table, label, reportRows, completedRecords) {
  const groups = new Map();
  reportRows.forEach(row => {
    const key = `${row[K.province]}||${row[field] || "نامعلوم"}`;
    const group = groups.get(key) || { total: 0, done: 0 };
    group.total++;
    if (completedRecords.has(row.id)) group.done++;
    groups.set(key, group);
  });
  const body = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, group]) => {
    const [province, name] = key.split("||");
    return `<tr><td>${esc(province)}</td><td>${esc(name)}</td><td>${group.total}</td>
      <td>${group.done}</td><td class="rem-num">${group.total - group.done}</td>
      <td>${group.total ? Math.round(group.done * 100 / group.total) : 0}%</td></tr>`;
  }).join("");
  $(table).innerHTML = `<thead><tr><th>صوبہ</th><th>${label}</th><th>کل انٹریاں</th><th>مکمل</th><th>باقی</th><th>پیش رفت</th></tr></thead>
    <tbody>${body || '<tr><td colspan="6" class="center">ڈیٹا موجود نہیں</td></tr>'}</tbody>`;
}

function renderReport() {
  const ownerId = $("reportUser").value;
  const reportRows = ownerId
    ? DATA.filter(row => row.assignedTo?.includes(ownerId))
    : DATA;
  const completedRecords = new Set(ENTRIES
    .filter(entry => (!ownerId || entry.userId === ownerId) && isDone(entry))
    .map(entry => entry.recordId));
  const groups = new Map();
  reportRows.forEach(row => {
    const group = groups.get(row[K.province]) || { total: 0, done: 0 };
    group.total++;
    if (completedRecords.has(row.id)) group.done++;
    groups.set(row[K.province], group);
  });
  let total = 0, done = 0;
  const body = provinces.map(province => {
    const group = groups.get(province) || { total: 0, done: 0 };
    total += group.total; done += group.done;
    return reportRow(province, group);
  }).join("");
  $("repProvince").innerHTML = `<thead><tr><th>صوبہ</th><th>کل انٹریاں</th><th>مکمل</th><th>باقی</th><th>پیش رفت</th></tr></thead>
    <tbody>${body}</tbody><tfoot>${reportRow("کل", { total, done })}</tfoot>`;
  renderGroupedReport(K.division, "repDivision", "ڈویژن", reportRows, completedRecords);
  renderGroupedReport(K.district, "repDistrict", "ڈسٹرکٹ", reportRows, completedRecords);
}

$("tabs").addEventListener("click", event => {
  const tab = event.target.dataset.tab;
  if (!tab || (tab !== "entry" && me.role !== "admin")) return;
  document.querySelectorAll("#tabs button").forEach(button => button.classList.toggle("active", button === event.target));
  ["entry", "report", "users", "log", "settings"].forEach(name => $("tab-" + name).classList.toggle("hidden", name !== tab));
  if (tab === "report") renderReport();
  if (tab === "users") renderUsers();
  if (tab === "log") renderLog();
  if (tab === "settings") $("aName").value = me.username;
});

const requireAdmin = () => {
  if (!me || me.role !== "admin") { alert("اجازت نہیں"); return false; }
  return true;
};

function provinceDivisions(province) {
  const normProv = nfc(province);
  return [...new Set(
    DATA.filter(row => nfc(row[K.province]) === normProv)
      .map(row => row[K.division])
      .filter(Boolean)
  )].sort();
}

function renderScopeChecks(selected = []) {
  if (!DATA.length && recordsLoading) {
    pendingScopeSelection = selected;
    $("uScopeSelections").innerHTML = '<span class="note">ڈیٹا ریکارڈز لوڈ ہو رہے ہیں، براہِ کرم انتظار کریں...</span>';
    return;
  }
  const assignments = new Map(selected.map(item => [nfc(item.province), (item.divisions || []).map(nfc)]));
  const scopeProvinces = [...new Set([...provinces, ...assignments.keys()])].filter(Boolean).sort();
  $("uScopeSelections").innerHTML = scopeProvinces.map(province => {
    const selectedDivisions = assignments.get(province);
    const provinceChecked = assignments.has(province);
    const divisions = [...new Set([...provinceDivisions(province), ...(selectedDivisions || [])])].filter(Boolean).sort();
    return `<div class="scope-province">
      <label class="inline"><input type="checkbox" class="province-check" value="${esc(province)}" ${provinceChecked ? "checked" : ""}> ${esc(province)}
        <small>(کوئی ڈویژن منتخب نہ ہو تو پورا صوبہ)</small></label>
      <div class="checks">${divisions.map(division =>
        `<label><input type="checkbox" class="division-check" data-province="${esc(province)}" value="${esc(division)}"
        ${selectedDivisions?.includes(division) ? "checked" : ""}> ${esc(division)}</label>`
      ).join("") || '<span class="note">اس صوبے کے ڈویژن ڈیٹا امپورٹ کے بعد دکھیں گے</span>'}</div>
    </div>`;
  }).join("") || '<span class="note">پہلے ڈیٹا امپورٹ کریں</span>';
}

function collectAssignments() {
  return [...$("uScopeSelections").querySelectorAll(".province-check:checked")].map(check => {
    const province = check.value;
    const divisions = [...$("uScopeSelections").querySelectorAll(".division-check:checked")]
      .filter(item => item.dataset.province === province).map(item => item.value);
    return { province, divisions };
  });
}

function fillScopeChecks() {
  if (!$("userDlg").open) return;
  const selected = pendingScopeSelection ?? collectAssignments();
  pendingScopeSelection = null;
  renderScopeChecks(selected);
}

function fillUserProvinceFilter() {
  if (!me || me.role !== "admin" || !$("uFilterProvince")) return;
  const userProvs = USERS.flatMap(u => assignmentsForUser(u).map(a => nfc(a.province)).filter(Boolean));
  const list = [...new Set([...provinces, ...userProvs])].sort();
  fillFilter($("uFilterProvince"), "تمام صوبے", list);
}

function renderUsers() {
  if (!requireAdmin()) return;
  fillUserProvinceFilter();
  const search = ($("uSearch")?.value || "").trim().toLowerCase();
  const roleFilter = $("uFilterRole")?.value || "";
  const provFilter = $("uFilterProvince")?.value || "";
  const statusFilter = $("uFilterStatus")?.value || "";

  const filtered = USERS.filter(user => {
    if (roleFilter && user.role !== roleFilter) return false;
    if (statusFilter === "active" && !user.active) return false;
    if (statusFilter === "inactive" && user.active) return false;
    const userAssigns = assignmentsForUser(user);
    if (provFilter && !userAssigns.some(a => nfc(a.province) === provFilter)) return false;
    if (search) {
      const scopeText = userAssigns.map(a => `${a.province} ${(a.divisions || []).join(" ")}`).join(" ").toLowerCase();
      if (!user.username.toLowerCase().includes(search) && !scopeText.includes(search)) return false;
    }
    return true;
  });

  $("userTable").innerHTML = `<thead><tr><th>یوزر آئی ڈی</th><th>کردار</th><th>اسائن شدہ صوبے/ڈویژن</th><th>حالت</th><th></th></tr></thead><tbody>` +
    (filtered.map(user => {
      const scope = user.role === "admin" ? "تمام ڈیٹا" : assignmentsForUser(user)
        .map(item => `${item.province}${item.divisions?.length ? ` — ${item.divisions.join("، ")}` : " — پورا صوبہ"}`).join("<br>");
      return `<tr><td>${esc(user.username)}</td><td>${user.role === "admin" ? "ایڈمن" : "یوزر"}</td>
        <td>${scope || "کوئی علاقہ اسائن نہیں"}</td>
        <td><span class="tag ${user.active ? "" : "off"}">${user.active ? "فعال" : "بند"}</span></td>
        <td><button class="link" data-act="edit" data-id="${esc(user.id)}">ترمیم</button>
        ${user.id === me.id ? "" : `<button class="link del" data-act="del" data-id="${esc(user.id)}">حذف</button>`}</td></tr>`;
    }).join("") || `<tr><td colspan="5" class="center">کوئی یوزر نہیں ملا</td></tr>`) + "</tbody>";
  fillEntryUsers();
}

["uSearch", "uFilterRole", "uFilterProvince", "uFilterStatus"].forEach(id => {
  $(id)?.addEventListener(id === "uSearch" ? "input" : "change", () => renderUsers());
});

function setUserPassVisible(visible) {
  const input = $("uPass");
  const toggle = $("uPassToggle");
  if (!input || !toggle) return;
  input.type = visible ? "text" : "password";
  toggle.setAttribute("aria-pressed", visible ? "true" : "false");
  toggle.setAttribute("aria-label", visible ? "Hide password" : "Show password");
  toggle.querySelector(".eye-open")?.classList.toggle("hidden", visible);
  toggle.querySelector(".eye-off")?.classList.toggle("hidden", !visible);
}

function openUserDlg(user = null) {
  if (!requireAdmin()) return;
  editingId = user?.id || null;
  $("userDlgTitle").textContent = user ? "یوزر میں ترمیم" : "نیا یوزر";
  $("uName").value = user?.username || "";
  $("uName").disabled = !!user;
  $("uPass").value = "";
  setUserPassVisible(false);
  $("uPass").required = !user;
  $("uPass").disabled = false;
  $("uPass").placeholder = user ? "Leave blank to keep existing" : "Min 8 chars (letters + digits)";
  $("uPassLabel").classList.remove("hidden");
  $("uRole").value = user?.role || "user";
  $("uActive").checked = user ? !!user.active : true;
  $("userErr").textContent = "";
  renderScopeChecks(user ? assignmentsForUser(user) : []);
  toggleScope();
  $("userDlg").showModal();
}

function toggleScope() {
  $("scopeBox").classList.toggle("hidden", $("uRole").value === "admin");
}

function otherActiveAdmins(exceptUid) {
  return USERS.filter(u => u.id !== exceptUid && u.role === "admin" && u.active).length;
}

async function syncRecordAssignmentsClient(uid, targetUser, runRpc = true) {
  if (runRpc) {
    const { error } = await supabase.rpc("sync_user_assignments", { target_uid: uid });
    if (error) throw error;
  }
  if (!RECORD_DOCS.size) return;
  const nowMs = Date.now();
  let changed = false;
  for (const [id, raw] of RECORD_DOCS.entries()) {
    const row = rowFromDocData(id, raw);
    const prev = Array.isArray(raw.assignedTo) ? raw.assignedTo : [];
    const hasUid = prev.includes(uid);
    const shouldHave = !!(targetUser && targetUser.active && userCanSeeRegion(targetUser, row));
    if (hasUid !== shouldHave) {
      raw.assignedTo = shouldHave ? [...new Set([...prev, uid])] : prev.filter(x => x !== uid);
      raw.updatedAtMs = nowMs;
      changed = true;
    }
  }
  if (changed) {
    await cachePut(syncStorageKey(me.id), [...RECORD_DOCS.values()]);
    localStorage.setItem(syncStorageKey(me.id), String(Math.max(0, Date.now() - 10000)));
    applyRecordDocs();
  }
}

$("addUserBtn").addEventListener("click", () => openUserDlg());
$("uPassToggle").addEventListener("click", () => setUserPassVisible($("uPass").type === "password"));
$("userCancel").addEventListener("click", () => { pendingScopeSelection = null; $("userDlg").close(); });
$("userDlg").addEventListener("close", () => { pendingScopeSelection = null; $("uPass").value = ""; setUserPassVisible(false); });
$("uRole").addEventListener("change", toggleScope);
$("uScopeSelections").addEventListener("change", event => {
  const input = event.target;
  if (input.classList.contains("division-check") && input.checked) {
    const province = [...$("uScopeSelections").querySelectorAll(".province-check")]
      .find(check => check.value === input.dataset.province);
    if (province) province.checked = true;
  } else if (input.classList.contains("province-check") && !input.checked) {
    [...$("uScopeSelections").querySelectorAll(".division-check")]
      .filter(check => check.dataset.province === input.value)
      .forEach(check => { check.checked = false; });
  }
});

$("userForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!requireAdmin()) return;
  const oldUser = editingId ? USERS.find(u => u.id === editingId) : null;
  const username = oldUser ? oldUser.username : $("uName").value.trim();
  const password = $("uPass").value;
  const role = normalizeRole($("uRole").value);
  const active = $("uActive").checked;
  const assignments = role === "admin" ? [] : collectAssignments();
  const error = message => { $("userErr").textContent = message; };

  if (!editingId) {
    let problem = nameProblem(username);
    if (problem) { error(problem); return; }
    problem = pwProblem(password, username);
    if (problem) { error(problem); return; }
    if (USERS.some(user => user.username.toLowerCase() === username.toLowerCase())) {
      error("یہ یوزر نیم پہلے سے موجود ہے");
      return;
    }
  } else {
    if (!oldUser) { error("یوزر نہیں ملا"); return; }
    if (password) {
      const problem = pwProblem(password, oldUser.username);
      if (problem) { error(problem); return; }
    }
    if (editingId === me.id && (role !== "admin" || !active)) {
      error("اپنا ایڈمن اکاؤنٹ بند یا کم درجہ نہیں کر سکتے۔");
      return;
    }
    if (oldUser.role === "admin" && oldUser.active && (role !== "admin" || !active) && otherActiveAdmins(editingId) < 1) {
      error("کم از کم ایک فعال ایڈمن لازمی ہے۔");
      return;
    }
  }
  if (!role) { error("کردار درست نہیں"); return; }
  if (role === "user" && !assignments.length) {
    error("یوزر کو کم از کم ایک صوبہ اسائن کریں");
    return;
  }

  const submit = $("userForm").querySelector('button[type="submit"]');
  setButtonBusy(submit, true, "محفوظ ہو رہا ہے...");
  try {
    if (!editingId) {
      const res = await invokeManageUser({
        action: "create",
        username,
        password,
        role,
        active,
        assignments
      });
      const createdUser = userFromDbRow(res.user);
      if (createdUser) {
        const idx = USERS.findIndex(u => u.id === createdUser.id);
        if (idx >= 0) USERS[idx] = createdUser;
        else USERS.push(createdUser);
        await syncRecordAssignmentsClient(createdUser.id, createdUser, false);
      }
    } else {
      if (password) {
        await invokeManageUser({ action: "reset_password", targetUid: editingId, password });
      }
      const { data: updatedRow, error: updErr } = await supabase
        .from("users")
        .update({ role, active, assignments })
        .eq("id", editingId)
        .select("id, username, username_key, role, active, assignments, created_at")
        .single();
      if (updErr) throw updErr;
      const updatedUser = userFromDbRow(updatedRow);
      const idx = USERS.findIndex(u => u.id === editingId);
      if (idx >= 0) USERS[idx] = updatedUser;
      await syncRecordAssignmentsClient(editingId, updatedUser, true);
      if (editingId === me.id) me = { ...me, ...updatedUser };
    }
    await saveLog(editingId ? "یوزر ترمیم" : "نیا یوزر", `${username} — ${role}`);
    $("userDlg").close();
    renderUsers();
    refreshAll();
  } catch (err) {
    const msg = String(err?.message || "");
    if (err?.status === 409 || /already exists|already registered/i.test(msg)) {
      error("یہ یوزر آئی ڈی پہلے سے Auth میں موجود ہے؛ دوسرا نام رکھیں۔");
    } else {
      error(msg || "یوزر محفوظ نہیں ہو سکا");
    }
  } finally {
    setButtonBusy(submit, false);
  }
});

$("userTable").addEventListener("click", async event => {
  const button = event.target.closest("button");
  if (!button || !requireAdmin()) return;
  const user = USERS.find(item => item.id === button.dataset.id);
  if (!user) return;
  if (button.dataset.act === "edit") openUserDlg(user);
  if (button.dataset.act === "del" && user.id !== me.id) {
    if (user.role === "admin" && user.active && otherActiveAdmins(user.id) < 1) {
      alert("کم از کم ایک فعال ایڈمن لازمی ہے۔");
      return;
    }
    if (!confirm(`یوزر "${user.username}" کا اکاؤنٹ اور اس کی تمام انٹریاں مستقل طور پر حذف کریں؟`)) return;
    try {
      await withLoader("یوزر حذف ہو رہا ہے...", async () => {
        await invokeManageUser({ action: "delete", targetUid: user.id });
        USERS = USERS.filter(u => u.id !== user.id);
        ENTRIES = ENTRIES.filter(e => e.userId !== user.id);
        await syncRecordAssignmentsClient(user.id, null, false);
        await saveLog("یوزر حذف", user.username);
        renderUsers();
        refreshAll();
      });
    } catch (error) {
      reportError("یوزر حذف نہیں ہو سکا", error);
    }
  }
});

function renderLog() {
  const rows = LOG.slice(0, 300);
  $("logTable").innerHTML = `<thead><tr><th>وقت</th><th>یوزر</th><th>عمل</th><th>تفصیل</th></tr></thead><tbody>` +
    (rows.map(log => `<tr><td>${esc(log.time)}</td><td>${esc(log.username)}</td>
      <td>${esc(log.action)}</td><td class="wrap">${esc(log.detail)}</td></tr>`).join("") ||
      '<tr><td colspan="4" class="center">کوئی سرگرمی نہیں</td></tr>') + "</tbody>";
}

$("adminForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!requireAdmin()) return;
  const message = (text, success) => {
    $("adminMsg").textContent = text;
    $("adminMsg").className = success ? "err ok" : "err";
  };
  const currentPassword = $("aCur").value;
  const newPassword = $("aNew").value;
  const repeatPassword = $("aNew2").value;
  const newUsername = $("aName").value.trim();
  let problem = nameProblem(newUsername);
  if (problem) { message(problem, false); return; }
  if (newUsername.toLowerCase() !== me.username.toLowerCase() &&
      USERS.some(user => user.id !== me.id && user.username.toLowerCase() === newUsername.toLowerCase())) {
    message("یہ یوزر نیم پہلے سے موجود ہے", false);
    return;
  }
  if (newUsername !== me.username) {
    message("یوزر آئی ڈی بدلنے کے لیے Supabase Dashboard یا supabase_admin_cli.mjs استعمال کریں؛ پاس ورڈ یہیں سے تبدیل ہو سکتا ہے۔", false);
    return;
  }
  if (!newPassword && !repeatPassword) {
    message("نیا پاس ورڈ درج کریں", false);
    return;
  }
  if (newPassword !== repeatPassword) { message("نئے پاس ورڈ ایک جیسے نہیں", false); return; }
  problem = pwProblem(newPassword, me.username);
  if (problem) { message(problem, false); return; }
  const submit = $("adminForm").querySelector('button[type="submit"]');
  setButtonBusy(submit, true, "محفوظ ہو رہا ہے...");
  try {
    await withLoader("پاس ورڈ تبدیل ہو رہا ہے...", async () => {
      const verifier = createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
      });
      const { error: verifyErr } = await verifier.auth.signInWithPassword({
        email: userEmail(me.username),
        password: currentPassword
      });
      if (verifyErr) throw new Error("موجودہ پاس ورڈ غلط ہے");
      const { error: updErr } = await supabase.auth.updateUser({ password: newPassword });
      if (updErr) throw updErr;
      $("aCur").value = $("aNew").value = $("aNew2").value = "";
      message("پاس ورڈ تبدیل ہو گیا", true);
      await saveLog("ایڈمن پاس ورڈ تبدیل");
    });
  } catch (error) {
    message(error.message || "پاس ورڈ تبدیل نہیں ہو سکا", false);
  } finally {
    setButtonBusy(submit, false);
  }
});

$("backupBtn").addEventListener("click", async () => {
  if (!requireAdmin()) return;
  const button = $("backupBtn");
  setButtonBusy(button, true, "بیک اپ بن رہا ہے...");
  try {
    await withLoader("بیک اپ تیار ہو رہا ہے...", async () => {
      await loadRecords(me, false);
      const records = [...RECORD_DOCS.values()];
      const entries = entriesLoaded
        ? ENTRIES.map(entry => ({ ...entry }))
        : (await fetchAll((from, to) =>
            supabase.from("entries")
              .select("id, record_id, user_id, hifz, nazra, submitted, submitted_at, updated_by, updated_at")
              .order("id", { ascending: true })
              .range(from, to)
          )).map(entryFromDb);
      const backup = { version: 2, records, entries };
      const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `backup_${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      await saveLog("بیک اپ ڈاؤن لوڈ");
    });
  } catch (error) {
    reportError("بیک اپ نہیں بن سکا", error);
  } finally {
    setButtonBusy(button, false);
  }
});

$("restoreFile").addEventListener("change", event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || !requireAdmin()) return;
  if (file.size > 30 * 1024 * 1024) { alert("فائل بہت بڑی ہے"); return; }
  const reader = new FileReader();
  reader.onload = async loadEvent => {
    try {
      const parsed = JSON.parse(loadEvent.target.result);
      if (Array.isArray(parsed)) {
        if (!confirm(`JSON فائل میں ${parsed.length} ریکارڈ ملے ہیں۔ امپورٹ کریں؟`)) return;
        await withLoader("ڈیٹا امپورٹ ہو رہا ہے...", () => uploadRecords(parsed, file.name));
        return;
      }
      const backup = parsed;
      if (!Array.isArray(backup?.records) || !Array.isArray(backup?.entries)) {
        throw new Error("بیک اپ فائل درست نہیں");
      }
      if (!confirm(`ریکارڈ: ${backup.records.length}، انٹریاں: ${backup.entries.length}\nموجودہ ریکارڈز میں شامل کریں؟`)) return;
      let skippedEntries = 0;
      await withLoader("بیک اپ بحال ہو رہا ہے...", async () => {
        const updatedAt = nowStr(), updatedAtMs = Date.now();
        for (let offset = 0; offset < backup.records.length; offset += 400) {
          const recRows = [], privRows = [];
          backup.records.slice(offset, offset + 400).forEach(item => {
            const rawInput = item?.data || item;
            const row = normalizeRecord(rawInput);
            if (!row) throw new Error("بیک اپ میں ریکارڈ کا صوبہ یا کوڈ موجود نہیں");
            const built = buildRecordPayload(row, updatedAt, updatedAtMs);
            if (item?.id && item.id === built.recRow.id) {
              recRows.push(built.recRow);
              privRows.push(built.privRow);
              RECORD_DOCS.set(built.recRow.id, built.docPayload);
            } else {
              recRows.push(built.recRow);
              privRows.push(built.privRow);
              RECORD_DOCS.set(built.recRow.id, built.docPayload);
            }
          });
          const { error: recErr } = await supabase.from("records").upsert(recRows, { onConflict: "id" });
          if (recErr) throw recErr;
          const { error: privErr } = await supabase.from("records_private").upsert(privRows, { onConflict: "record_id" });
          if (privErr) throw privErr;
        }
        await cachePut(syncStorageKey(me.id), [...RECORD_DOCS.values()]);
        localStorage.setItem(syncStorageKey(me.id), String(Math.max(0, Date.now() - 10000)));
        applyRecordDocs();

        for (let offset = 0; offset < backup.entries.length; offset += 400) {
          const entryBatch = [];
          backup.entries.slice(offset, offset + 400).forEach(item => {
            if (!item.id || !item.recordId || !item.userId) throw new Error("بیک اپ میں انٹری کا فارمیٹ درست نہیں");
            if (!UUID_RE.test(String(item.userId))) { skippedEntries++; return; }
            const dbEntry = {
              id: `${item.recordId}__${item.userId}`,
              record_id: item.recordId,
              user_id: item.userId,
              hifz: item[K.hifz] || "",
              nazra: item[K.nazra] || "",
              submitted: !!item.submitted,
              submitted_at: item.submittedAt || "",
              updated_by: item.updatedBy || "",
              updated_at: item.updatedAt || ""
            };
            entryBatch.push(dbEntry);
            upsertLocalEntry(entryFromDb(dbEntry));
          });
          if (entryBatch.length) {
            const { error: entErr } = await supabase.from("entries").upsert(entryBatch, { onConflict: "id" });
            if (entErr) throw entErr;
          }
        }
        refreshAll();
        await saveLog("بیک اپ بحال", skippedEntries ? `Skipped non-UUID entries: ${skippedEntries}` : "");
      });
      alert(skippedEntries
        ? `بحالی مکمل ہو گئی (غیر-UUID یوزر آئی ڈی والی ${skippedEntries} انٹریاں چھوڑ دی گئیں)`
        : "بحالی مکمل ہو گئی");
    } catch (error) {
      reportError("بیک اپ بحال نہیں ہوا", error);
    }
  };
  reader.readAsText(file);
});
