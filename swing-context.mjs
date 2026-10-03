const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const n=v=>{const x=Number(v);return Number.isFinite(x)?x:null};

export function evaluateDerivativeContext({direction,fundingRate,oiChange30m}={}){
  const sign=direction==="SHORT"?-1:1;
  const funding=n(fundingRate);
  const oi=n(oiChange30m);
  const reasons=[],warnings=[],critical=[];
  let adjustment=0, coverage=0;

  if(funding!=null){
    coverage++;
    const directionalFunding=sign*funding;
    if(directionalFunding>=0.0015){
      critical.push("EXTREME_SAME_SIDE_FUNDING");
      adjustment-=0.08;
    }else if(directionalFunding>=0.0006){
      warnings.push("CROWDED_SAME_SIDE_FUNDING");
      adjustment-=0.035;
    }else if(directionalFunding<=-0.0004){
      reasons.push("FUNDING_NOT_CROWDED");
      adjustment+=0.015;
    }else{
      reasons.push("FUNDING_BALANCED");
      adjustment+=0.005;
    }
  }else warnings.push("FUNDING_CONTEXT_MISSING");

  if(oi!=null){
    coverage++;
    if(oi>=0.01){
      reasons.push("OPEN_INTEREST_EXPANSION");
      adjustment+=0.035;
    }else if(oi>=0.002){
      reasons.push("OPEN_INTEREST_CONFIRMING");
      adjustment+=0.02;
    }else if(oi<=-0.02){
      warnings.push("OPEN_INTEREST_CONTRACTION");
      adjustment-=0.025;
    }else{
      reasons.push("OPEN_INTEREST_STABLE");
    }
  }else warnings.push("OPEN_INTEREST_HISTORY_WARMING");

  return {
    adjustment:clamp(adjustment,-0.10,0.06),
    coverage:coverage/2,
    critical,
    warnings,
    reasons,
    fundingRate:funding,
    oiChange30m:oi
  };
}

export function derivePositionContext({price,close4h,close24h,direction}={}){
  const p=n(price),c4=n(close4h),c24=n(close24h);
  if(!(p>0&&c4>0&&c24>0)) return {ready:false,reason:"position_context_missing"};
  const r4h=Math.log(p/c4),r24h=Math.log(p/c24);
  const sign=direction==="SHORT"?-1:1;
  const aligned=sign*r4h>0 && sign*r24h>0;
  const strongEnough=Math.abs(r4h)>=0.003 && Math.abs(r24h)>=0.008;
  return {
    ready:aligned&&strongEnough,
    reason:!aligned?"position_context_direction_conflict":(!strongEnough?"position_context_weak":"position_context_confirmed"),
    r4h,r24h
  };
}
