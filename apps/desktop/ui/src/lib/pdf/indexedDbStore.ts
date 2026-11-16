const PDF_IDB_NAME = "readora_pdf_store_v1";
const PDF_IDB_STORE = "pdfs";

export function isJsdomEnvironment(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /jsdom/i.test(navigator.userAgent ?? "")
  );
}

export function hasUsableCanvas2D(): boolean {
  if (typeof document === "undefined" || isJsdomEnvironment()) {
    return false;
  }
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("2d"));
  } catch {
    return false;
  }
}

export async function readFileToUint8Array(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") {
    const ab = await file.arrayBuffer();
    return new Uint8Array(ab);
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
      } else {
        reject(new Error("Failed to read file bytes"));
      }
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("File read error"));
    reader.readAsArrayBuffer(file);
  });
}

function openPdfIndexedDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined" || isJsdomEnvironment()) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(PDF_IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PDF_IDB_STORE)) {
          db.createObjectStore(PDF_IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function savePdfBytesToIndexedDb(
  docId: string,
  bytes: Uint8Array,
): Promise<void> {
  const db = await openPdfIndexedDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(PDF_IDB_STORE, "readwrite");
      tx.objectStore(PDF_IDB_STORE).put(bytes.slice(), docId);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

export async function loadPdfBytesFromIndexedDb(
  docId: string,
): Promise<Uint8Array | null> {
  const db = await openPdfIndexedDb();
  if (!db) return null;
  return new Promise<Uint8Array | null>((resolve) => {
    try {
      const tx = db.transaction(PDF_IDB_STORE, "readonly");
      const req = tx.objectStore(PDF_IDB_STORE).get(docId);
      req.onsuccess = () => {
        db.close();
        const res = req.result;
        if (res instanceof Uint8Array) {
          resolve(res);
        } else if (res instanceof ArrayBuffer) {
          resolve(new Uint8Array(res));
        } else {
          resolve(null);
        }
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

export async function deletePdfBytesFromIndexedDb(
  docId: string,
): Promise<void> {
  const db = await openPdfIndexedDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(PDF_IDB_STORE, "readwrite");
      tx.objectStore(PDF_IDB_STORE).delete(docId);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

export async function clearPdfIndexedDb(): Promise<void> {
  const db = await openPdfIndexedDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(PDF_IDB_STORE, "readwrite");
      tx.objectStore(PDF_IDB_STORE).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}
