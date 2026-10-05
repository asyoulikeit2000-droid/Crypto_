export function grtFramework(symbol,price,h1,h4,d1){
  if(symbol==="GRTUSDT"){
    return {hedgeTrigger:0.02790,hard4h:0.02720,reduceTrigger:0.02650,resistance1:0.02940,resistance2:0.03050,resistance3:0.03110,entryZone:0.03500,profitExtension:0.03670,source:"agreed_grt_rescue_framework"};
  }
  const level=(x,d=5)=>Number.isFinite(x)?Number(x.toFixed(d)):null;
  const recentSupport=h1?Math.min(h1.recentLow,h4?.recentLow??h1.recentLow):price*0.97;
  const atr1=h1?.atr14||price*0.01;
  const hedgeTrigger=level(Math.max(recentSupport-0.15*atr1,price-1.6*atr1),5);
  const hard4h=level(Math.min(h4?.recentLow??recentSupport,recentSupport)-0.75*(h4?.atr14||atr1*3),5);
  const reduceTrigger=level(hard4h-0.75*(h4?.atr14||atr1*3),5);
  const r1=level(Math.max(h1?.ema20||price,h1?.recentHigh||price),5);
  const r2=level(Math.max(h4?.ema20||r1,h4?.recentHigh||r1),5);
  const r3=level(Math.max(d1?.ema20||r2,r2*1.035),5);
  return {hedgeTrigger,hard4h,reduceTrigger,resistance1:r1,resistance2:r2,resistance3:r3,entryZone:null,profitExtension:null,source:"dynamic"};
}

export function decideAction({direction,price,entry,hedgeNotional,h1Close,h4Close,score,framework}){
  let action="HOLD",secondaryAction="ADD NOTHING";
  if(direction==="long"){
    if(h4Close!=null&&h4Close<framework.reduceTrigger){
      action="REDUCE";secondaryAction="CAPITAL PRESERVATION";
    }else if((h4Close!=null&&h4Close<framework.hard4h)||(h1Close!=null&&h1Close<framework.hedgeTrigger)){
      action="HEDGE";secondaryAction=h4Close!=null&&h4Close<framework.hard4h?"TARGET ~50% HEDGE":"TARGET ~25% HEDGE";
    }else if(hedgeNotional>0&&h4Close!=null&&h4Close>=framework.resistance2&&score>0.5){
      action="EXIT-HEDGE";secondaryAction="KEEP CORE LONG";
    }else if(price>=entry){
      action="REDUCE";secondaryAction=score>=2.5?"TAKE PARTIAL PROFIT; KEEP RUNNER":"SECURE RECOVERED CAPITAL";
    }
  }
  return {action,secondaryAction};
}
