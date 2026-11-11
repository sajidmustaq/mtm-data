/**
 * MTM Data — سابقہ Firebase (mtm-data) سے نئے Firebase (student-portal-5dd94) میں ڈیٹا مائیگریشن
 * استعمال: node migrate_firebase.mjs [--temp-password=TempPass123!]
 */

import {
  EMAIL_DOMAIN,
  OLD_PROJECT_ID,
  TARGET_PROJECT_ID,
  initFirebaseProject,
  nfc,
  normalizeRow,
  userCanSeeRegion
} from "./firebase_admin_helper.mjs";

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith("--") && a.includes("="))
    .map(a => {
      const idx = a.indexOf("=");
      return [a.slice(2, idx), a.slice(idx + 1)];
    })
);
const tempPassword = args["temp-password"] || "TempPass@1234";

const source = initFirebaseProject(OLD_PROJECT_ID, "source");
const target = initFirebaseProject(TARGET_PROJECT_ID, "target");

console.log(`📤 Source: ${source.projectId} (${source.keyPath})`);
console.log(`📥 Target: ${target.projectId} (${target.keyPath})`);

async function copyCollectionBatched(colName, docs, transform) {
  let count = 0;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = target.db.batch();
    for (const d of docs.slice(i, i + 400)) {
      const payload = transform(d);
      if (!payload) continue;
      batch.set(target.db.collection(colName).doc(d.id), payload, { merge: true });
      count++;
    }
    await batch.commit();
  }
  return count;
}

try {
  const [srcUsersSnap, srcRecordsSnap, srcEntriesSnap, srcLogsSnap] = await Promise.all([
    source.db.collection("users").get(),
    source.db.collection("records").get(),
    source.db.collection("entries").get(),
    source.db.collection("logs").get()
  ]);

  console.log(`\n📊 سابقہ Firebase میں ملا:`);
  console.log(`  users:   ${srcUsersSnap.size}`);
  console.log(`  records: ${srcRecordsSnap.size}`);
  console.log(`  entries: ${srcEntriesSnap.size}`);
  console.log(`  logs:    ${srcLogsSnap.size}\n`);

  const migratedUsers = [];
  const createdAuthUsers = [];

  for (const docSnap of srcUsersSnap.docs) {
    const u = docSnap.data();
    const username = String(u.username || u.usernameKey || "").trim();
    const assignments = Array.isArray(u.assignments)
      ? u.assignments.map(a => ({
          province: nfc(a.province).trim(),
          divisions: Array.isArray(a.divisions) ? a.divisions.map(d => nfc(d).trim()) : []
        }))
      : [];
    const profile = { ...u, assignments };
    migratedUsers.push({ id: docSnap.id, ...profile });

    if (username) {
      const email = `${username.toLowerCase()}@${EMAIL_DOMAIN}`;
      try {
        await target.auth.getUser(docSnap.id);
      } catch (err) {
        if (err.code !== "auth/user-not-found") throw err;
        try {
          await target.auth.createUser({
            uid: docSnap.id,
            email,
            password: tempPassword,
            disabled: u.active === false
          });
          createdAuthUsers.push({ uid: docSnap.id, username, email });
        } catch (createErr) {
          console.warn(`⚠️ Auth user (${username}) نہیں بن سکا: ${createErr.message}`);
        }
      }
    }

    await target.db.collection("users").doc(docSnap.id).set(profile, { merge: true });
  }
  console.log(`✅ users منتقل: ${migratedUsers.length}`);
  if (createdAuthUsers.length) {
    console.log(`🔐 نئے Auth اکاؤنٹس (عارضی پاس ورڈ: ${tempPassword} — بعد میں تبدیل کر لیں):`);
    createdAuthUsers.forEach(u => console.log(`   - ${u.username} (${u.email}) [UID: ${u.uid}]`));
  }

  const nowStr = new Date().toLocaleString("en-GB", { hour12: false });
  const nowMs = Date.now();
  const recCount = await copyCollectionBatched("records", srcRecordsSnap.docs, docSnap => {
    const raw = docSnap.data();
    const norm = normalizeRow(raw.data || raw);
    if (!norm) return null;
    const assignedTo = migratedUsers
      .filter(u => userCanSeeRegion(u, norm.province, norm.division))
      .map(u => u.id);
    return {
      data: norm.data,
      province: norm.province,
      division: norm.division,
      district: norm.district,
      sourceKey: norm.sourceKey,
      assignedTo,
      updatedAt: raw.updatedAt || nowStr,
      updatedAtMs: nowMs
    };
  });
  console.log(`✅ records منتقل: ${recCount}`);

  const entryCount = await copyCollectionBatched("entries", srcEntriesSnap.docs, d => d.data());
  console.log(`✅ entries منتقل: ${entryCount}`);

  const logCount = await copyCollectionBatched("logs", srcLogsSnap.docs, d => d.data());
  console.log(`✅ logs منتقل: ${logCount}`);

  console.log("\n🎉 سابقہ Firebase کا تمام ڈیٹا کامیابی سے شفٹ ہو گیا!");
} catch (err) {
  if (String(err.message || "").includes("RESOURCE_EXHAUSTED")) {
    console.error("\n❌ سابقہ Firebase (mtm-data) کی Firestore لمٹ ابھی تک ختم (Quota exceeded) ہے۔");
    console.error("   1) روزانہ کوٹہ ری سیٹ ہونے کے بعد (عموماً پاکستانی وقت کے مطابق دوپہر 1 بجے کے بعد) دوبارہ چلائیں، یا");
    console.error("   2) اگر سابقہ Firebase میں انٹریاں نہیں تھیں تو مقامی data.json سے براہِ راست امپورٹ کریں: node import_data.mjs");
    process.exit(1);
  }
  throw err;
}

process.exit(0);
