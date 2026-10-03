import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDerivativeContext, derivePositionContext } from "../swing-context.mjs";

test("extreme same-side long funding blocks via critical flag",()=>{
  const r=evaluateDerivativeContext({direction:"LONG",fundingRate:0.0016,oiChange30m:0.02});
  assert.ok(r.critical.includes("EXTREME_SAME_SIDE_FUNDING"));
  assert.ok(r.adjustment<0);
});

test("extreme same-side short funding blocks via critical flag",()=>{
  const r=evaluateDerivativeContext({direction:"SHORT",fundingRate:-0.0017,oiChange30m:0.01});
  assert.ok(r.critical.includes("EXTREME_SAME_SIDE_FUNDING"));
});

test("rising open interest can strengthen an uncrowded setup",()=>{
  const r=evaluateDerivativeContext({direction:"LONG",fundingRate:0.0001,oiChange30m:0.015});
  assert.equal(r.critical.length,0);
  assert.ok(r.reasons.includes("OPEN_INTEREST_EXPANSION"));
  assert.ok(r.adjustment>0);
});

test("missing derivative history is explicit and not treated as evidence",()=>{
  const r=evaluateDerivativeContext({direction:"LONG"});
  assert.equal(r.coverage,0);
  assert.ok(r.warnings.includes("FUNDING_CONTEXT_MISSING"));
  assert.ok(r.warnings.includes("OPEN_INTEREST_HISTORY_WARMING"));
  assert.equal(r.adjustment,0);
});

test("position context requires 4h and 24h alignment with setup direction",()=>{
  const longOk=derivePositionContext({price:110,close4h:108,close24h:100,direction:"LONG"});
  assert.equal(longOk.ready,true);
  const conflict=derivePositionContext({price:110,close4h:112,close24h:100,direction:"LONG"});
  assert.equal(conflict.ready,false);
  assert.equal(conflict.reason,"position_context_direction_conflict");
});

test("position context rejects weak drift",()=>{
  const r=derivePositionContext({price:100.5,close4h:100.3,close24h:100,direction:"LONG"});
  assert.equal(r.ready,false);
  assert.equal(r.reason,"position_context_weak");
});
