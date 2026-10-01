import {discoverLatestProfiles,discoverBoostedTokens,tokenPairs,normalizePair} from "./providers/dexscreener.mjs";
import {evaluatePreRally} from "./scoring.mjs";

const enabled=String(process.env.PRE_RALLY_SCANNER_ENABLED||"false").toLowerCase()==="true";
const chains=new Set(String(process.env.PRE_RALLY_CHAINS||"solana,ethereum,base,bsc").split(",").map(x=>x.trim()).filter(Boolean));
const intervalMs=Math.max(60000,Number(process.env.PRE_RALLY_SCAN_INTERVAL_MS||300000));
const maxTokens=Math.max(5,Math.min(100,Number(process.env.PRE_RALLY_MAX_TOKENS||40)));

export function createPreRallyScanner({db,log=console.log}={}){
  const state={enabled,lastRunAt:null,lastSuccessAt:null,lastError:null,running:false,tokens:[],provider:"DEXSCREENER"};
  async function persist(row,score){
    if(!db)return;
    const now=new Date().toISOString();
    let token=await db("scanner_tokens","GET",{
      chain_id:"eq."+row.chainId,contract_address:"eq."+row.tokenAddress,select:"token_id"
    });
    let tokenId=token?.[0]?.token_id||null;
    if(!tokenId){
      token=await db("scanner_tokens","POST",{on_conflict:"chain_id,contract_address"},{
        chain_id:row.chainId,contract_address:row.tokenAddress,token_name:row.tokenName,token_symbol:row.tokenSymbol,
        logo_url:row.imageUrl,first_seen_at:now,active:true,provider_metadata:{provider:row.provider,websites:row.websites,socials:row.socials}
      },{Prefer:"resolution=ignore-duplicates,return=representation"});
      tokenId=token?.[0]?.token_id||null;
      if(!tokenId){
        token=await db("scanner_tokens","GET",{
          chain_id:"eq."+row.chainId,contract_address:"eq."+row.tokenAddress,select:"token_id"
        });
        tokenId=token?.[0]?.token_id||null;
      }
    }
    if(!tokenId)return;

    let pair=await db("scanner_pairs","GET",{
      chain_id:"eq."+row.chainId,pair_address:"eq."+row.pairAddress,select:"pair_id"
    });
    let pairId=pair?.[0]?.pair_id||null;
    if(!pairId){
      pair=await db("scanner_pairs","POST",{on_conflict:"chain_id,pair_address"},{
        token_id:tokenId,chain_id:row.chainId,pair_address:row.pairAddress,dex_name:row.dexName,
        base_token:{address:row.tokenAddress,name:row.tokenName,symbol:row.tokenSymbol},quote_token:row.quoteToken,
        pair_created_at:row.pairCreatedAt,first_seen_at:now,active:true,primary_pair:true,provider_metadata:{provider:row.provider}
      },{Prefer:"resolution=ignore-duplicates,return=representation"});
      pairId=pair?.[0]?.pair_id||null;
      if(!pairId){
        pair=await db("scanner_pairs","GET",{
          chain_id:"eq."+row.chainId,pair_address:"eq."+row.pairAddress,select:"pair_id"
        });
        pairId=pair?.[0]?.pair_id||null;
      }
    }

    const freshness=row.sourceTimestamp?"FRESH":"UNKNOWN_SOURCE_TIME";
    await db("scanner_market_snapshots","POST",{},{
      token_id:tokenId,pair_id:pairId,observed_at:now,price_usd:row.priceUsd,liquidity_usd:row.liquidityUsd,
      market_cap:row.marketCap,fdv:row.fdv,volume_1h:row.volume1h,volume_6h:row.volume6h,volume_24h:row.volume24h,
      buys_1h:row.buys1h,sells_1h:row.sells1h,buys_24h:row.buys24h,sells_24h:row.sells24h,
      price_change_1h:row.priceChange1h,price_change_6h:row.priceChange6h,price_change_24h:row.priceChange24h,
      pair_age_hours:row.pairAgeHours,provider_name:row.provider,source_timestamp:row.sourceTimestamp,ingestion_timestamp:now,
      freshness_status:freshness,provider_quality:row.sourceTimestamp?"PRIMARY":"PRIMARY_NO_SOURCE_TIMESTAMP",completeness_state:score.dataCoverageScore
    });
    await db("scanner_evaluations","POST",{},{
      token_id:tokenId,pair_id:pairId,evaluated_at:now,pre_rally_score:score.preRallyScore,
      confidence_score:score.confidenceScore,data_coverage_score:score.dataCoverageScore,classification:score.classification,
      category_scores:score.categoryScores,positive_signals:score.positiveSignals,warning_flags:score.warningFlags,
      critical_flags:score.criticalFlags,missing_data:score.missingData,freshness_status:freshness,
      explanation:score.explanation,diagnostic_explanation:{provider:row.provider,sourceTimestampAvailable:Boolean(row.sourceTimestamp)},
      scoring_model_version:score.modelVersion,configuration_version:score.configVersion
    });
  }
  async function run(){
    if(!enabled||state.running)return state;
    state.running=true;state.lastRunAt=new Date().toISOString();
    try{
      const [profiles,boosts]=await Promise.all([discoverLatestProfiles(),discoverBoostedTokens()]);
      const candidates=new Map();
      for(const x of [...(Array.isArray(profiles)?profiles:[]),...(Array.isArray(boosts)?boosts:[])]){
        if(x?.chainId&&x?.tokenAddress&&chains.has(x.chainId))candidates.set(x.chainId+":"+x.tokenAddress,x);
      }
      const out=[];
      for(const c of [...candidates.values()].slice(0,maxTokens)){
        try{
          const pairs=await tokenPairs(c.chainId,c.tokenAddress);
          const normalized=(Array.isArray(pairs)?pairs:[]).map(normalizePair).filter(x=>x.tokenAddress===c.tokenAddress);
          normalized.sort((a,b)=>(b.liquidityUsd||0)-(a.liquidityUsd||0));
          const row=normalized[0]; if(!row)continue;
          const score=evaluatePreRally(row);
          out.push({...row,...score});
          await persist(row,score);
        }catch(e){log("pre_rally_token_error",{chain:c.chainId,token:c.tokenAddress,error:String(e?.message||e)});}
      }
      out.sort((a,b)=>b.preRallyScore-a.preRallyScore||b.confidenceScore-a.confidenceScore);
      state.tokens=out;state.lastSuccessAt=new Date().toISOString();state.lastError=null;
    }catch(e){state.lastError=String(e?.message||e);log("pre_rally_scan_error",{error:state.lastError});}
    finally{state.running=false;}
    return state;
  }
  function start(){if(!enabled)return;run();const t=setInterval(run,intervalMs);t.unref?.();}
  return {state,run,start};
}
