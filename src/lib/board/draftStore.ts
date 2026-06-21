// CLIENT-ONLY persistence for UNSUBMITTED board proof images (IndexedDB).
//
// Staged proofs live in component memory, so a refresh / navigating away / closing the
// submit modal loses them — painful for a "pre-pic" (the before screenshot you take, go do
// the content, then come back for the after-pic): you can't retake a before. This keeps
// staged Files NATIVELY (no base64) keyed per tile + box, so reopening the tile restores
// them; cleared on submit. TTL-swept so abandoned drafts don't pile up.
//
// IndexedDB (not localStorage) because images are multi-MB binary: localStorage is ~5MB
// for the whole origin, string-only (base64 +~33%), and synchronous. IDB stores Blobs
// directly with a far larger quota. Everything here is best-effort: any failure (SSR,
// private mode, quota) degrades to "not persisted" rather than throwing.

const DB_NAME = 'voli-board-drafts';
const STORE = 'staged';
const VERSION = 1;
const TTL_MS = 14 * 24 * 60 * 60 * 1000; // drop drafts older than 14 days

interface DraftRecord {
	key: string;
	files: File[];
	savedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function available(): boolean {
	return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return openDb().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const t = db.transaction(STORE, mode);
				const req = fn(t.objectStore(STORE));
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			})
	);
}

// Save (or, when empty, delete) the staged files for a draft key.
export async function saveDraftFiles(key: string, files: File[]): Promise<void> {
	if (!available()) return;
	try {
		if (files.length === 0) {
			await clearDraftFiles(key);
			return;
		}
		await run('readwrite', (s) => s.put({ key, files, savedAt: Date.now() } satisfies DraftRecord));
	} catch {
		/* best-effort */
	}
}

// Restore the staged files for a draft key ([] if none / expired / unavailable).
export async function loadDraftFiles(key: string): Promise<File[]> {
	if (!available()) return [];
	try {
		const rec = (await run('readonly', (s) => s.get(key))) as DraftRecord | undefined;
		if (!rec) return [];
		if (Date.now() - rec.savedAt > TTL_MS) {
			await clearDraftFiles(key);
			return [];
		}
		return rec.files ?? [];
	} catch {
		return [];
	}
}

export async function clearDraftFiles(key: string): Promise<void> {
	if (!available()) return;
	try {
		await run('readwrite', (s) => s.delete(key));
	} catch {
		/* best-effort */
	}
}

// Opportunistic sweep of expired drafts (call on modal open). Keeps the store from growing
// unbounded when players stage proofs they never submit.
export async function sweepExpiredDrafts(): Promise<void> {
	if (!available()) return;
	try {
		const all = ((await run('readonly', (s) => s.getAll())) as DraftRecord[]) ?? [];
		const now = Date.now();
		for (const r of all) if (now - r.savedAt > TTL_MS) await clearDraftFiles(r.key);
	} catch {
		/* best-effort */
	}
}
