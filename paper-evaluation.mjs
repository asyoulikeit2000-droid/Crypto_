export const PAPER_EVALUATION_VERSION = 'paper_v3';
export const MAX_PATH_GAP_MS = 120_000;

// Evaluate persisted observations only. Missing coverage never becomes a synthetic fill.
export function evaluatePaperPath(trade, ticks, now = Date.now()) {
  const meta = trade.metadata || {};
  const start = Date.parse(trade.opened_at);
  const horizon = Number(meta.max_horizon_seconds);
  const entry = Number(trade.entry_price);
  const side = String(trade.side).toUpperCase();
  const levels = [meta.stop_loss, meta.target_1, meta.target_2, meta.target_3].map(Number);
  if (!Number.isFinite(start) || !Number.isFinite(now) || now < start ||
      !Number.isFinite(horizon) || horizon <= 0 || !Number.isFinite(entry) || entry <= 0 ||
      !['LONG','SHORT'].includes(side) || levels.some(x => !Number.isFinite(x) || x <= 0)) return null;
  const sign = side === 'LONG' ? 1 : -1;
  const [stop, t1, t2, t3] = levels;
  if (!((entry-stop)*sign > 0 && (t1-entry)*sign > 0 &&
        (t2-t1)*sign > 0 && (t3-t2)*sign > 0)) return null;
  const deadline = start + horizon * 1000;
  const path = ticks.map(x => ({time: Date.parse(x.observed_at), price: Number(x.price)}))
    .filter(x => Number.isFinite(x.time) && Number.isFinite(x.price) && x.price > 0 &&
      x.time >= start && x.time <= Math.min(now, deadline))
    .sort((a,b) => a.time-b.time || sign*(a.price-b.price));
  if (!path.length) return null;
  let previous = start, last = null;
  let mfe = 0, mae = 0, t1Hit = false, t2Hit = false, t3Hit = false, slHit = false;
  const finish = (outcome, exitPrice, time) => ({outcome, exit_price: exitPrice,
    exit_at: new Date(time).toISOString(), holding_seconds: (time-start)/1000,
    t1_hit:t1Hit, t2_hit:t2Hit, t3_hit:t3Hit, sl_hit:slHit, mfe, mae,
    evaluation_version:PAPER_EVALUATION_VERSION, path_valid:true,
    path_max_gap_seconds:MAX_PATH_GAP_MS/1000, price_source:'persisted_market_ticks'});
  for (const observation of path) {
    if (observation.time-previous > MAX_PATH_GAP_MS) return null;
    previous = observation.time; last = observation;
    // A terminal fill bounds excursion statistics too; later observations cannot alter it.
    slHit = (observation.price-stop)*sign <= 0;
    t3Hit = (observation.price-t3)*sign >= 0;
    const price = slHit ? stop : t3Hit ? t3 : observation.price;
    t1Hit ||= (price-t1)*sign >= 0;
    t2Hit ||= (price-t2)*sign >= 0;
    mfe = Math.max(mfe, sign*(price-entry)/entry);
    mae = Math.max(mae, sign*(entry-price)/entry);
    if (slHit) return finish('STOP_LOSS', stop, observation.time);
    if (t3Hit) return finish('TARGET_3', t3, observation.time);
  }
  if (now >= deadline && deadline-last.time <= MAX_PATH_GAP_MS) {
    return finish('TIMEOUT', last.price, deadline);
  }
  return null;
}

// Cursor pagination avoids treating a limited prefix as a whole holding-period path.
export async function readPaperPath(db, trade, now = Date.now(), pageSize = 1000) {
  const deadline = Date.parse(trade.opened_at) + Number(trade.metadata?.max_horizon_seconds)*1000;
  if (!Number.isFinite(deadline)) return [];
  const end = Math.min(now, deadline), result = [];
  let cursor = trade.opened_at;
  for (let page = 0; page < 50; page++) {
    const rows = await db('market_ticks','GET', {select:'observed_at,price',
      asset_id:'eq.'+trade.metadata.asset_id, exchange:'eq.BYBIT',
      observed_at:(page ? 'gt.' : 'gte.')+cursor, order:'observed_at.asc', limit:String(pageSize)});
    const within = rows.filter(x => Date.parse(x.observed_at) <= end);
    result.push(...within);
    if (rows.length < pageSize || within.length < rows.length) return result;
    const next = rows.at(-1)?.observed_at;
    if (!next || Date.parse(next) <= Date.parse(cursor)) return [];
    cursor = next;
  }
  return []; // A bounded read that cannot prove completeness is not evidence.
}

export function verifiedPaperOutcome(outcome, maxHorizonSeconds) {
  return outcome?.evaluation_version === PAPER_EVALUATION_VERSION && outcome.path_valid === true &&
    typeof outcome.holding_seconds === 'number' && Number.isFinite(outcome.holding_seconds) && outcome.holding_seconds >= 0 &&
    Number(outcome.holding_seconds) <= maxHorizonSeconds &&
    Number.isFinite(Date.parse(outcome.exit_at)) &&
    typeof outcome.pnl_after_cost === 'number' && Number.isFinite(outcome.pnl_after_cost) &&
    typeof outcome.t1_hit === 'boolean' &&
    ['TARGET_3','STOP_LOSS','TIMEOUT'].includes(outcome.outcome);
}
