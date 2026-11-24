// Case storage. Every case is saved on this computer first (IndexedDB), then synced to a shared
// Supabase project when one is configured in config.js and the technician is signed in.

const DB_NAME = "headset-diag";
const STORE = "cases";
const SESSION_KEY = "headset-diag-session";

const cfg = () => (typeof window !== "undefined" && window.APP_CONFIG) || {};
export const sharedConfigured = () => !!(cfg().supabaseUrl && cfg().supabaseKey);

/* ---------- local (IndexedDB, with an in-memory fallback) ---------- */

const memory = new Map();
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") return reject(new Error("no indexedDB"));
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }).catch(() => null);
  }
  return dbPromise;
}

const wrap = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

export async function localPut(c) {
  const db = await openDb();
  if (!db) { memory.set(c.id, c); return; }
  await wrap(db.transaction(STORE, "readwrite").objectStore(STORE).put(c));
}

export async function localAll() {
  const db = await openDb();
  if (!db) return [...memory.values()];
  return wrap(db.transaction(STORE).objectStore(STORE).getAll());
}

export async function localGet(id) {
  const db = await openDb();
  if (!db) return memory.get(id) || null;
  return (await wrap(db.transaction(STORE).objectStore(STORE).get(id))) || null;
}

/* ---------- shared (Supabase over plain fetch) ---------- */

let session = null;
try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { session = null; }

function saveSession(s) {
  session = s;
  try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ }
}

export const currentUser = () => session?.user?.email || "";
export const signedIn = () => !!session?.access_token;

async function authCall(grant, body) {
  const r = await fetch(`${cfg().supabaseUrl}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { apikey: cfg().supabaseKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.msg || j.message || `sign-in failed (${r.status})`);
  saveSession({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, user: { email: j.user?.email || body.email || "" } });
}

export async function signIn(email, password) { await authCall("password", { email, password }); }
export function signOut() { saveSession(null); }

async function token() {
  if (!session) throw new Error("not signed in");
  if (Date.now() > session.expires_at - 60000) {
    try { await authCall("refresh_token", { refresh_token: session.refresh_token }); }
    catch (e) { saveSession(null); throw e; }
  }
  return session.access_token;
}

async function rest(path, opts = {}) {
  const r = await fetch(`${cfg().supabaseUrl}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: cfg().supabaseKey, Authorization: `Bearer ${await token()}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

const LIST_COLUMNS = "id,created_at,updated_at,serial,model,firmware,profile,verdict,fails,warns,tech,outcome,symptoms,notes,resolution,summary";

export async function remoteUpsert(c) {
  const { synced, uploaded, ...row } = c;
  await rest("cases?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
  c.uploaded = true;
}

export async function remoteNotes(c) {
  const body = { outcome: c.outcome, symptoms: c.symptoms, notes: c.notes, resolution: c.resolution, tech: c.tech, updated_at: c.updated_at };
  await rest(`cases?id=eq.${encodeURIComponent(c.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(body) });
}

export const remoteList = () => rest(`cases?select=${LIST_COLUMNS}&order=created_at.desc&limit=500`);
export const remoteGet = async (id) => (await rest(`cases?id=eq.${encodeURIComponent(id)}&select=*`))?.[0] || null;

/* ---------- combined operations ---------- */

/** Saves a case locally and, when possible, to the shared project. Returns "shared" or "local". */
export async function saveCase(c, { notesOnly = false } = {}) {
  c.updated_at = new Date().toISOString();
  c.synced = false;
  await localPut(c);
  if (sharedConfigured() && signedIn()) {
    try {
      await (notesOnly && c.uploaded ? remoteNotes(c) : remoteUpsert(c));
      c.synced = true;
      await localPut(c);
      return "shared";
    } catch (e) {
      return "local";
    }
  }
  return "local";
}

/** Pushes cases that were saved offline or before signing in. */
export async function syncPending() {
  if (!(sharedConfigured() && signedIn())) return 0;
  let n = 0;
  for (const c of await localAll()) {
    if (c.synced) continue;
    try { await remoteUpsert(c); c.synced = true; await localPut(c); n++; } catch { /* try again later */ }
  }
  return n;
}

/** Cases for the Cases tab: the shared list when signed in (plus unsynced local ones), otherwise local only. */
export async function listCases() {
  const local = await localAll();
  if (!(sharedConfigured() && signedIn())) return { cases: local, shared: false };
  try {
    const remote = await remoteList();
    const ids = new Set(remote.map((c) => c.id));
    return { cases: [...remote, ...local.filter((c) => !ids.has(c.id))], shared: true };
  } catch (e) {
    return { cases: local, shared: false, error: String(e.message || e) };
  }
}

/** Full record (with the report) for one case. */
export async function openCase(id) {
  const local = await localGet(id);
  if (local?.report) return local;
  if (sharedConfigured() && signedIn()) return remoteGet(id);
  return local;
}
