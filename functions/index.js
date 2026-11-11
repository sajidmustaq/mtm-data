"use strict";

const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const { HttpsError, onCall } = require("firebase-functions/v2/https");

initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10, timeoutSeconds: 300 });
const db = getFirestore();
const auth = getAuth();
const EMAIL_DOMAIN = "student-portal-5dd94.firebaseapp.com";
const usernamePattern = /^[A-Za-z0-9_.-]{3,30}$/;

function authEmail(username) {
  return `${username.trim().toLowerCase()}@${EMAIL_DOMAIN}`;
}

function validateUsername(username) {
  if (typeof username !== "string" || !usernamePattern.test(username)) {
    throw new HttpsError("invalid-argument", "یوزر آئی ڈی 3 سے 30 انگریزی حروف، ہندسوں، _ . - پر مشتمل ہو۔");
  }
}

function normalizeRole(role) {
  if (typeof role !== "string") {
    throw new HttpsError("invalid-argument", "کردار admin یا user ہونا چاہیے۔");
  }
  const normalized = role.trim().toLowerCase();
  if (!["admin", "user"].includes(normalized)) {
    throw new HttpsError("invalid-argument", "کردار admin یا user ہونا چاہیے۔");
  }
  return normalized;
}

function validatePassword(password, username) {
  if (typeof password !== "string" || password.length < 8 ||
      !/[A-Za-z]/.test(password) || !/\d/.test(password) ||
      password.toLowerCase().includes(username.toLowerCase()) ||
      /^(admin|password|12345678)/i.test(password)) {
    throw new HttpsError("invalid-argument", "پاس ورڈ کم از کم 8 حروف کا ہو، اس میں حروف اور ہندسے ہوں، اور وہ آسان نہ ہو۔");
  }
}

function validateAssignments(assignments, role) {
  if (role === "admin") return [];
  if (!Array.isArray(assignments) || !assignments.length || assignments.length > 50) {
    throw new HttpsError("invalid-argument", "یوزر کے لیے کم از کم ایک صوبہ اسائن کریں۔");
  }
  const seen = new Set();
  return assignments.map(item => {
    if (!item || typeof item.province !== "string" || !item.province.trim() ||
        !Array.isArray(item.divisions) || item.divisions.some(d => typeof d !== "string")) {
      throw new HttpsError("invalid-argument", "صوبہ/ڈویژن اسائنمنٹ درست نہیں۔");
    }
    const province = item.province.normalize("NFC").trim();
    if (seen.has(province)) throw new HttpsError("invalid-argument", "ایک صوبہ ایک سے زیادہ مرتبہ منتخب ہے۔");
    seen.add(province);
    return { province, divisions: [...new Set(item.divisions.map(d => d.normalize("NFC")))].slice(0, 100) };
  });
}

async function requireAdmin(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "لاگ اِن درکار ہے۔");
  const snapshot = await db.doc(`users/${request.auth.uid}`).get();
  if (!snapshot.exists || snapshot.data().active !== true || snapshot.data().role !== "admin") {
    throw new HttpsError("permission-denied", "صرف فعال ایڈمن یہ کام کر سکتا ہے۔");
  }
  return snapshot.data();
}

async function ensureUsernameAvailable(username, exceptUid = "") {
  const usernameKey = username.toLowerCase();
  const existing = await db.collection("users").where("usernameKey", "==", usernameKey).limit(1).get();
  if (!existing.empty && existing.docs[0].id !== exceptUid) {
    throw new HttpsError("already-exists", "یہ یوزر آئی ڈی پہلے سے موجود ہے۔");
  }
}

async function syncRecordAssignments(uid, assignments) {
  const previous = await db.collection("records").where("assignedTo", "array-contains", uid).get();
  const desired = new Map();
  for (const assignment of assignments) {
    const records = await db.collection("records")
      .where("province", "==", assignment.province).get();
    records.docs.forEach(snapshot => {
      if (!assignment.divisions.length || assignment.divisions.includes(snapshot.data().division || "")) {
        desired.set(snapshot.id, snapshot.ref);
      }
    });
  }
  const updates = new Map();
  previous.docs.forEach(snapshot => {
    if (!desired.has(snapshot.id)) updates.set(snapshot.id, { ref: snapshot.ref, add: false });
  });
  desired.forEach((ref, id) => updates.set(id, { ref, add: true }));
  const list = [...updates.values()];
  const nowMs = Date.now();
  for (let offset = 0; offset < list.length; offset += 400) {
    const batch = db.batch();
    list.slice(offset, offset + 400).forEach(item => {
      batch.update(item.ref, {
        assignedTo: item.add ? FieldValue.arrayUnion(uid) : FieldValue.arrayRemove(uid),
        updatedAtMs: nowMs
      });
    });
    await batch.commit();
  }
}

async function countOtherActiveAdmins(exceptUid) {
  const admins = await db.collection("users")
    .where("role", "==", "admin").where("active", "==", true).get();
  return admins.docs.filter(snapshot => snapshot.id !== exceptUid).length;
}

exports.manageUser = onCall({ cors: true }, async request => {
  await requireAdmin(request);
  const { action, uid } = request.data || {};

  if (action === "create") {
    const username = String(request.data.username || "").trim();
    const usernameKey = username.toLowerCase();
    const role = normalizeRole(request.data.role);
    validateUsername(username);
    validatePassword(request.data.password, username);
    const assignments = validateAssignments(request.data.assignments, role);
    await ensureUsernameAvailable(username);

    let account;
    try {
      account = await auth.createUser({
        email: authEmail(username),
        password: request.data.password,
        disabled: request.data.active === false
      });
      const profile = {
        username, usernameKey, role, active: request.data.active !== false,
        assignments, createdAt: new Date().toISOString()
      };
      await db.doc(`users/${account.uid}`).set(profile);
      await syncRecordAssignments(account.uid, profile.active ? assignments : []);
      return { id: account.uid, ...profile };
    } catch (error) {
      if (account) {
        try { await syncRecordAssignments(account.uid, []); }
        catch (cleanupError) { console.error("Could not remove partial record assignments", cleanupError); }
        try { await db.doc(`users/${account.uid}`).delete(); }
        catch (cleanupError) { console.error("Could not remove partial user profile", cleanupError); }
        try { await auth.deleteUser(account.uid); }
        catch (cleanupError) { console.error("Could not remove partial Auth account", cleanupError); }
      }
      if (error.code === "auth/email-already-exists") {
        throw new HttpsError("already-exists", "یہ یوزر آئی ڈی پہلے سے موجود ہے۔");
      }
      throw error;
    }
  }

  if (!["update", "delete"].includes(action) || typeof uid !== "string" || !uid) {
    throw new HttpsError("invalid-argument", "یوزر کی درخواست درست نہیں۔");
  }
  if (action === "delete") {
    if (uid === request.auth.uid) throw new HttpsError("failed-precondition", "اپنا ایڈمن اکاؤنٹ حذف نہیں کر سکتے۔");
    const snapshot = await db.doc(`users/${uid}`).get();
    if (!snapshot.exists) throw new HttpsError("not-found", "یوزر نہیں ملا۔");
    if (snapshot.data().role === "admin" && snapshot.data().active &&
        await countOtherActiveAdmins(uid) < 1) {
      throw new HttpsError("failed-precondition", "کم از کم ایک فعال ایڈمن لازمی ہے۔");
    }
    await snapshot.ref.update({ active: false });
    await syncRecordAssignments(uid, []);
    await auth.deleteUser(uid);
    await snapshot.ref.delete();
    return { id: uid };
  }

  const snapshot = await db.doc(`users/${uid}`).get();
  if (!snapshot.exists) throw new HttpsError("not-found", "یوزر نہیں ملا۔");
  const old = snapshot.data();
  const username = String(request.data.username || "").trim();
  const role = normalizeRole(request.data.role);
  const active = request.data.active !== false;
  validateUsername(username);
  const assignments = validateAssignments(request.data.assignments, role);
  await ensureUsernameAvailable(username, uid);
  if (uid === request.auth.uid && (role !== "admin" || !active)) {
    throw new HttpsError("failed-precondition", "اپنا ایڈمن اکاؤنٹ بند یا کم درجہ نہیں کر سکتے۔");
  }
  if (old.role === "admin" && old.active && (role !== "admin" || !active) &&
      await countOtherActiveAdmins(uid) < 1) {
    throw new HttpsError("failed-precondition", "کم از کم ایک فعال ایڈمن لازمی ہے۔");
  }
  if (request.data.password) validatePassword(request.data.password, username);

  const next = {
    ...old, username, usernameKey: username.toLowerCase(), role, active, assignments
  };
  const revokeImmediately = !active || (old.role === "admin" && role !== "admin");
  if (revokeImmediately) {
    await snapshot.ref.set({
      ...old, active, role, assignments: []
    });
  }
  await syncRecordAssignments(uid, active ? assignments : []);
  const authUpdate = { email: authEmail(username), disabled: !active };
  if (request.data.password) authUpdate.password = request.data.password;
  await auth.updateUser(uid, authUpdate);
  await snapshot.ref.set(next);
  return { id: uid, ...next };
});

exports.manageSelf = onCall({ cors: true }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "لاگ اِن درکار ہے۔");
  const snapshot = await db.doc(`users/${request.auth.uid}`).get();
  if (!snapshot.exists || snapshot.data().active !== true || snapshot.data().role !== "admin") {
    throw new HttpsError("permission-denied", "اجازت نہیں۔");
  }
  const username = String(request.data?.username || "").trim();
  validateUsername(username);
  await ensureUsernameAvailable(username, request.auth.uid);
  await auth.updateUser(request.auth.uid, { email: authEmail(username) });
  const next = {
    ...snapshot.data(), username, usernameKey: username.toLowerCase()
  };
  await snapshot.ref.set(next);
  return { id: request.auth.uid, ...next };
});
