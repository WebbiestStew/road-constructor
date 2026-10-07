"use client";

/**
 * A very small IndexedDB wrapper for the things that are too big for localStorage: save slots and run replays. One
 * database, a few object stores keyed by id. Every call can fail (private windows, blocked storage), so they reject
 * and the callers show a message instead of breaking the game.
 */

const DB_NAME = "road-constructor";
const DB_VERSION = 1;
export type StoreName = "slotMeta" | "slotData" | "replayMeta" | "replayData";
const STORES: StoreName[] = ["slotMeta", "slotData", "replayMeta", "replayData"];

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser can't keep saves (IndexedDB is unavailable)"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error("Couldn't open the save database"));
    };
  });
  return dbPromise;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = work(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("Save database error"));
        tx.onabort = () => reject(tx.error ?? new Error("Couldn't write the save (is the disk full?)"));
      })
  );
}

export function idbPut<T extends { id: string }>(store: StoreName, value: T): Promise<void> {
  return run(store, "readwrite", (s) => s.put(value)).then(() => undefined);
}

export function idbGet<T>(store: StoreName, id: string): Promise<T | undefined> {
  return run<T | undefined>(store, "readonly", (s) => s.get(id) as IDBRequest<T | undefined>);
}

export function idbAll<T>(store: StoreName): Promise<T[]> {
  return run<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
}

export function idbDelete(store: StoreName, id: string): Promise<void> {
  return run(store, "readwrite", (s) => s.delete(id)).then(() => undefined);
}
