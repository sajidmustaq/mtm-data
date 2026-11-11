import { TARGET_PROJECT_ID, initFirebaseProject } from "./firebase_admin_helper.mjs";

const { db, auth, keyPath, projectId } = initFirebaseProject(TARGET_PROJECT_ID, "target");
console.log(`🔑 Firebase Project: ${projectId} (${keyPath})`);

const [recordsCount, usersCount, entriesCount, logsCount, authList, sampleSnap] = await Promise.all([
  db.collection("records").count().get(),
  db.collection("users").count().get(),
  db.collection("entries").count().get(),
  db.collection("logs").count().get(),
  auth.listUsers(100),
  db.collection("records").limit(3).get()
]);

console.log("📊 Firestore Counts:");
console.log("  users:  ", usersCount.data().count);
console.log("  records:", recordsCount.data().count);
console.log("  entries:", entriesCount.data().count);
console.log("  logs:   ", logsCount.data().count);
console.log("🔐 Auth Users:", authList.users.length);
authList.users.forEach(u => console.log(`  - ${u.uid} | ${u.email} | disabled=${u.disabled}`));

if (sampleSnap.empty) {
  console.log("⚠️ records کلیکشن خالی ہے");
} else {
  console.log("📄 Sample record IDs:");
  sampleSnap.docs.forEach(d => console.log("  -", d.id));
}

process.exit(0);
