const metrics = rows => {
  const pnls = rows.map(x => x.pnl_after_cost);
  const totalPnl = pnls.reduce((a,b) => a+b,0);
  const wins = rows.filter(x => x.pnl_after_cost > 0).length;
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const p of pnls) { equity += p; peak = Math.max(peak,equity); maxDrawdown = Math.max(maxDrawdown,peak-equity); }
  return {n:rows.length,wins,winRate:rows.length ? wins/rows.length : 0,
    avgPnl:rows.length ? totalPnl/rows.length : 0,totalPnl,maxDrawdown};
};

// Assess recorded, fixed-model decisions. This does not optimize or backtest alternative entries.
export function validateRecordedEvidence(signals, outcomes, now = Date.now()) {
  const byId = new Map(signals.map(s => [s.signal_id,s]));
  const rows = outcomes.map(o => ({...o,signal:byId.get(o.signal_id)}))
    .filter(o => o.signal && Number.isFinite(Date.parse(o.signal.created_at)) &&
      Date.parse(o.exit_at) >= Date.parse(o.signal.created_at) && Date.parse(o.exit_at) <= now)
    .sort((a,b) => Date.parse(a.signal.created_at)-Date.parse(b.signal.created_at) ||
      String(a.signal_id).localeCompare(String(b.signal_id)));
  const minimumTrain = 50, minimumTest = 20, foldCount = 5;
  const size = Math.floor((rows.length-minimumTrain)/foldCount);
  const insufficient = () => ({status:'INSUFFICIENT_SAMPLE',sampleCount:rows.length,
    minimumTrain,minimumTest,requiredFolds:foldCount,method:'purged_expanding_window',test:metrics([])});
  if (size < minimumTest) return insufficient();
  const folds = [], heldOut = [];
  for (let i = 0; i < foldCount; i++) {
    const from = minimumTrain+i*size;
    const test = rows.slice(from,i === foldCount-1 ? rows.length : from+size);
    const boundary = Date.parse(test[0].signal.created_at);
    // Purge every training outcome that would not have been known before this test window.
    const train = rows.slice(0,from).filter(x => Date.parse(x.exit_at) < boundary);
    if (train.length < minimumTrain) return insufficient();
    const smooth = part => (part.filter(x => x.t1_hit).length+2.4)/(part.length+12);
    const global = smooth(train);
    const probabilities = Object.fromEntries(['LONG','SHORT'].map(side => {
      const part = train.filter(x => x.signal.signal === side);
      return [side,part.length ? smooth(part) : global];
    }));
    const brierScore = test.reduce((sum,x) => sum+((probabilities[x.signal.signal] ?? global)-(x.t1_hit ? 1 : 0))**2,0)/test.length;
    folds.push({index:i+1,trainN:train.length,trainLatestExit:new Date(Math.max(...train.map(x => Date.parse(x.exit_at)))).toISOString(),
      testStartsAt:test[0].signal.created_at,calibration:{globalProbability:global,byDirection:probabilities},brierScore,...metrics(test)});
    heldOut.push(...test);
  }
  const avgs = folds.map(x => x.avgPnl).sort((a,b) => a-b);
  return {status:'COMPLETE',evaluatedAt:new Date(now).toISOString(),sampleCount:rows.length,
    split:{method:'purged_expanding_window',train:minimumTrain,test:heldOut.length},folds,
    test:metrics(heldOut),costCoverageComplete:heldOut.every(x => x.funding_model === 'historical_settlements'),
    robustness:{foldCount:folds.length,positiveFolds:folds.filter(x => x.avgPnl > 0).length,
      medianAvgPnl:avgs[Math.floor(avgs.length/2)],recentTotalPnl:folds.slice(-3).reduce((sum,x) => sum+x.totalPnl,0),folds}};
}
