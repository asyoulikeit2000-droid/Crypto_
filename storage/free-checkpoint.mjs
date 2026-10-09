export const CHECKPOINT_MS = 120_000;
export const MAX_CHECKPOINT_BYTES = 1_400_000;
const TABLE = 'engine_free_checkpoints';
const KEY = 'mtf_v1';

export function validateCheckpoint(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.signals) || !value.histories || !Array.isArray(value.symbols) || !Number.isFinite(value.savedAt)) throw new Error('Invalid Free checkpoint; refusing overwrite');
  if (value.signals.length > 170 || value.symbols.length > 30) throw new Error('Checkpoint bounds exceeded');
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_CHECKPOINT_BYTES) throw new Error('Checkpoint exceeds safe D1 document size');
  return value;
}

// One complete document is atomic in D1. Only an acknowledged save is published.
// This profile must run as a single replica (also the Railway production setting).
export function createFreeCheckpoint(store, clock = Date.now) {
  let recovered = false, lastAttempt = 0, lastSuccess = 0, error = null;
  return {
    async load() {
      const rows = await store.db(TABLE, 'GET', {id: 'eq.' + KEY, limit: 1});
      const data = rows.length ? validateCheckpoint(rows[0].data) : null;
      recovered = true;
      lastSuccess = data?.savedAt || 0;
      lastAttempt = lastSuccess;
      return data;
    },
    async save(value) {
      if (!recovered) throw new Error('Checkpoint recovery required before saving');
      const now = clock();
      if (lastAttempt && now - lastAttempt < CHECKPOINT_MS) return null;
      lastAttempt = now;
      const data = validateCheckpoint({...structuredClone(value), savedAt: now});
      try {
        const rows = await store.db(TABLE, 'POST', {on_conflict: 'id'}, {id: KEY, data, expectedSavedAt: lastSuccess}, {Prefer: 'return=minimal'});
        const committed = rows?.[0]?.data ? validateCheckpoint(rows[0].data) : data;
        lastSuccess = committed.savedAt; error = null;
        return committed;
      } catch (e) { error = String(e.message || e); throw e; }
    },
    status() { return {recovered, lastAttempt, lastSuccess, error, intervalMs: CHECKPOINT_MS, maxDocumentBytes: MAX_CHECKPOINT_BYTES, plannedSavesPerDay: 720}; }
  };
}
