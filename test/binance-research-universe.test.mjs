import test from "node:test";
import assert from "node:assert/strict";
import {
  isEligibleBinancePerpetual,
  rankBinanceResearchUniverse,
  resolveBinanceResearchUniverse
} from "../market/binance-research-universe.mjs";

const instrument=s=>({
  symbol:s,
  baseAsset:s.replace(/USDT$/,""),
  quoteAsset:"USDT",
  marginAsset:"USDT",
  status:"TRADING",
  contractType:"PERPETUAL"
});

test("selector rejects stable leveraged and non-perpetual instruments",()=>{
  assert.equal(isEligibleBinancePerpetual(instrument("BTCUSDT")),true);
  assert.equal(isEligibleBinancePerpetual(instrument("USDCUSDT")),false);
  assert.equal(isEligibleBinancePerpetual(instrument("BTCUPUSDT")),false);
  assert.equal(isEligibleBinancePerpetual({...instrument("ETHUSDT"),contractType:"CURRENT_QUARTER"}),false);
});

test("ranking keeps BTC pinned and prefers liquid tight-spread contracts",()=>{
  const exchangeInfo=["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT"].map(instrument);
  const tickers=[
    {symbol:"BTCUSDT",quoteVolume:"1000000000",count:"200000",lastPrice:"60000"},
    {symbol:"ETHUSDT",quoteVolume:"800000000",count:"180000",lastPrice:"3000"},
    {symbol:"SOLUSDT",quoteVolume:"700000000",count:"170000",lastPrice:"150"},
    {symbol:"XRPUSDT",quoteVolume:"900000000",count:"180000",lastPrice:"1"}
  ];
  const books=[
    {symbol:"BTCUSDT",bidPrice:"59999",askPrice:"60000"},
    {symbol:"ETHUSDT",bidPrice:"2999.9",askPrice:"3000"},
    {symbol:"SOLUSDT",bidPrice:"149.99",askPrice:"150"},
    {symbol:"XRPUSDT",bidPrice:"0.999",askPrice:"1.001"}
  ];
  const r=rankBinanceResearchUniverse({exchangeInfo,tickers,books,maxAssets:3,pinned:["BTCUSDT"]});
  assert.equal(r.length,3);
  assert.equal(r[0].symbol,"BTCUSDT");
  assert.equal(r[0].pinned,true);
  assert.ok(!r.some(x=>x.symbol==="XRPUSDT"));
});

test("resolver uses only public Binance endpoints and returns ranked symbols",async()=>{
  const responses={
    exchangeInfo:{symbols:[instrument("BTCUSDT"),instrument("ETHUSDT")]},
    ticker:[{symbol:"BTCUSDT",quoteVolume:"1000000000",count:"200000",lastPrice:"60000"},{symbol:"ETHUSDT",quoteVolume:"800000000",count:"180000",lastPrice:"3000"}],
    book:[{symbol:"BTCUSDT",bidPrice:"59999",askPrice:"60000"},{symbol:"ETHUSDT",bidPrice:"2999.9",askPrice:"3000"}]
  };
  const fetchImpl=async url=>({
    ok:true,
    async json(){
      if(url.includes("exchangeInfo")) return responses.exchangeInfo;
      if(url.includes("24hr")) return responses.ticker;
      return responses.book;
    }
  });
  const r=await resolveBinanceResearchUniverse({fetchImpl,maxAssets:2});
  assert.deepEqual(r.map(x=>x.symbol),["BTCUSDT","ETHUSDT"]);
});
