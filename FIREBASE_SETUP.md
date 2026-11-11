# Firebase setup

The app is static-hosted, but login, user management, assigned records, and entries are stored in Firebase. Usernames are mapped internally to Firebase Auth email aliases; users still sign in with the username and password the admin gives them.

## One-time Firebase setup

1. In Firebase Console for `student-portal-5dd94`, enable **Authentication → Email/Password** and create a **Cloud Firestore** database.
2. Create the first admin under **Authentication → Users**:
   - Email: `admin@student-portal-5dd94.firebaseapp.com`
   - Password: choose a strong initial password.
   - Copy the new user's UID.
3. In Firestore, create `users/{UID}` with these fields:
   - `username` (string): `admin`
   - `usernameKey` (string): `admin`
   - `role` (string): `admin`
   - `active` (boolean): `true`
   - `assignments` (array): empty
   - `createdAt` (string): current ISO date/time
   - Use the Authentication user's exact UID as the Firestore document ID. `role` must be a string with the exact value `admin` (lowercase); an Authentication custom claim or a different document's role does not grant admin access.
4. Add the GitHub Pages hostname (for example, `yourname.github.io`) to **Authentication → Settings → Authorized domains**.
5. Enable the Firebase **Blaze** plan for Cloud Functions. Set a budget alert in Google Cloud Billing.
6. Cloud Functions are configured for Node.js 22. Install Firebase CLI, sign in, install the Functions dependencies, and deploy the rules and functions from this folder:

   ```powershell
   npm install -g firebase-tools
   firebase login
   Set-Location functions
   npm install
   Set-Location ..
   firebase deploy --only firestore:rules,functions
   ```

7. Publish the static app files to GitHub Pages over HTTPS. The Firebase web config in `app.js` is client-side configuration, not an admin credential. Firestore rules and Cloud Functions enforce access.
8. Sign in as `admin`, upload the source JSON using **امپورٹ**, then create users and select their provinces and divisions.

## Data privacy

Do not publish `data.json` to GitHub Pages: Pages files are publicly downloadable. It is ignored by `.gitignore`; keep the source file on the admin's computer and upload it from the signed-in admin interface. The app writes it to Firestore and assigns matching records to the relevant users.

Each user's answers are saved in a separate Firestore entry keyed to that user's UID. Other users cannot read those entries; the admin can review them. Firestore rules also prevent users from reading records not assigned to them. Do not deploy with permissive/test-mode Firestore rules.
