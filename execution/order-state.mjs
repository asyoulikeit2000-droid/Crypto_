const TRANSITIONS = Object.freeze({
  INTENT: new Set(["APPROVED", "REJECTED"]),
  APPROVED: new Set(["SUBMITTED", "CANCELLED", "FAILED"]),
  SUBMITTED: new Set(["ACKNOWLEDGED", "REJECTED", "FAILED"]),
  ACKNOWLEDGED: new Set(["PARTIALLY_FILLED", "FILLED", "CANCELLED", "FAILED"]),
  PARTIALLY_FILLED: new Set(["PARTIALLY_FILLED", "FILLED", "CANCELLED", "FAILED"]),
  FILLED: new Set(["EXIT_SUBMITTED", "FAILED"]),
  EXIT_SUBMITTED: new Set(["CLOSED", "FAILED"]),
  REJECTED: new Set(),
  CANCELLED: new Set(),
  CLOSED: new Set(),
  FAILED: new Set()
});

export function transitionOrder(order, nextState, metadata = {}) {
  const current = String(order?.state || "INTENT");
  const next = String(nextState || "");
  const allowed = TRANSITIONS[current];
  if (!allowed || !allowed.has(next)) {
    throw new Error(`Illegal order transition ${current} -> ${next}`);
  }
  const now = new Date().toISOString();
  return {
    ...order,
    state: next,
    updatedAt: now,
    history: [
      ...(order?.history || []),
      { from: current, to: next, at: now, metadata }
    ]
  };
}

export function terminalOrderState(state) {
  return ["REJECTED", "CANCELLED", "CLOSED", "FAILED"].includes(String(state || ""));
}
