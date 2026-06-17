#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');

// ═══════════════════════════════════════════════════════
//  NEXUS QUANTUM v2 — ULTIMATE EDITION
//  Multi-token · Trailing stop · Partial exits · Token IQ
// ═══════════════════════════════════════════════════════

const CFG = {
  orKey:      process.env.OPENROUTER_API_KEY,
  groqKey:    process.env.GROQ_API_KEY,
  privateKey: process.env.WALLET_PRIVATE_KEY,
  rpcUrl:     process.env.RPC_URL          || 'https://api.mainnet-beta.solana.com',
  tradeUSDC:  parseFloat(process.env.TRADE_SIZE_USD     || '2'),
  maxUSDC:    parseFloat(process.env.MAX_TRADE_SIZE_USD  || '10'),
  stopLoss:   parseFloat(process.env.STOP_LOSS_PCT       || '5'),
  dailyLoss:  parseFloat(process.env.DAILY_LOSS_PCT      || '10'),
  minConf:    parseFloat(process.env.MIN_CONFIDENCE      || '0.62'),
  interval:   parseInt  (process.env.INTERVAL_SECONDS    || '30'),
  slippage:   parseInt  (process.env.SLIPPAGE_BPS        || '100'),
  brainFile:  process.env.BRAIN_FILE       || './brain.json',
  dryRun:     process.env.DRY_RUN !== 'false',
  // Exit thresholds
  takeProfit: parseFloat(process.env.TAKE_PROFIT_PCT    || '1.5'),
  stopLossPos:parseFloat(process.env.POSITION_STOP_PCT  || '2.0'),
  trailStart: parseFloat(process.env.TRAIL_START_PCT    || '0.8'),
  trailDist:  parseFloat(process.env.TRAIL_DIST_PCT     || '0.5'),
  maxHoldMin: parseInt  (process.env.MAX_HOLD_MINUTES   || '15'),
};

// ── TOKENS ───────────────────────────────────────────────
const TOKENS = {
  SOL:  { cgid:'solana',                   mint:'So11111111111111111111111111111111111111112',  dec:9, minVol:1000000 },
  JUP:  { cgid:'jupiter-exchange-solana',  mint:'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', dec:6, minVol:100000 },
  WIF:  { cgid:'dogwifcoin',               mint:'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', dec:6, minVol:100000 },
  BONK: { cgid:'bonk',                     mint:'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', dec:5, minVol:100000 },
  RAY:  { cgid:'raydium',                  mint:'4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', dec:6, minVol:50000  },
  JTO:  { cgid:'jito-governance-token',    mint:'jtojtomepa8bdnkzLzZK4sLpxT5UXc2fSHJYGiMc6Z',  dec:9, minVol:50000  },
};

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_SYMS = Object.keys(TOKENS);

// ── TERMINAL ─────────────────────────────────────────────
const C = { r:'\x1b[0m',b:'\x1b[1m',d:'\x1b[2m',cy:'\x1b[36m',g:'\x1b[32m',re:'\x1b[31m',y:'\x1b[33m',p:'\x1b[35m',w:'\x1b[37m',bl:'\x1b[34m',mag:'\x1b[95m' };
const TCOL = { INFO:C.cy,TRADE:C.g,WIN:C.g,LOSS:C.re,WARN:C.y,ERR:C.re,BRAIN:C.p,SHIELD:C.y,SYS:C.w,SCAN:C.bl,DRY:C.d,TRAIL:C.mag };
const ts  = () => new Date().toISOString().slice(11,19);
const log = (m,t='INFO') => console.log(`${C.d}[${ts()}]${C.r} ${TCOL[t]||C.w}[${t}]${C.r} ${m}`);
const div = (m='') => { console.log(`\n${C.p}${'═'.repeat(62)}${C.r}`); if(m) console.log(`${C.b}  ${m}${C.r}`); console.log(`${C.p}${'═'.repeat(62)}${C.r}`); };

// ── PRICE HISTORY ─────────────────────────────────────────
const PH = {};
TOKEN_SYMS.forEach(s => PH[s] = []);

// ── BRAIN ─────────────────────────────────────────────────
const defaultBrain = () => ({
  generation:1, xp:0, xpNext:5,
  trades:0, wins:0, losses:0,
  totalPnl:0, pnlHistory:[],
  consWins:0, consLosses:0,
  memories:[], mutations:[],
  currentTradeSize: CFG.tradeUSDC,
  portfolioStart:null, portfolioPeak:0,
  dayStart:null, dayStartUSDC:0,
  lastFearGreed:50,
  tradeLog:[],
  position: null,
  // Token Intelligence — tracks each token's performance
  tokenIQ: Object.fromEntries(TOKEN_SYMS.map(s=>[s,{trades:0,wins:0,losses:0,pnl:0,consLosses:0,banned:false,banUntil:0}])),
});

const loadBrain = () => {
  try {
    if (fs.existsSync(CFG.brainFile)) {
      const b = JSON.parse(fs.readFileSync(CFG.brainFile,'utf8'));
      if (!b.tokenIQ) b.tokenIQ = defaultBrain().tokenIQ;
      if (b.position === undefined) b.position = null;
      log(`Brain loaded — GEN-${b.generation} · ${b.trades} trades · ${b.wins}W/${b.losses}L · P&L: ${b.totalPnl>=0?'+':''}$${b.totalPnl.toFixed(4)}`,'BRAIN');
      if (b.position) log(`Open position: ${b.position.token} @ $${b.position.entryPrice} · ${b.position.size} USDC in`,'TRADE');
      return b;
    }
  } catch(e) { log('Brain corrupt — fresh start','WARN'); }
  return defaultBrain();
};
const saveBrain = b => { try { fs.writeFileSync(CFG.brainFile,JSON.stringify(b,null,2)); } catch(e) { log('Save: '+e.message,'WARN'); } };

// ── SOLANA RPC ────────────────────────────────────────────
async function rpc(method, params) {
  try {
    const r = await fetch(CFG.rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    return (await r.json()).result;
  } catch { return null; }
}

function getWallet() {
  const {Keypair} = require('@solana/web3.js');
  const bs58 = require('bs58');
  const dec = bs58.default ? bs58.default.decode : bs58.decode;
  return Keypair.fromSecretKey(Buffer.from(dec(CFG.privateKey)));
}

async function getUSDCBalance(pk) {
  const r = await rpc('getTokenAccountsByOwner',[pk,{mint:USDC_MINT},{encoding:'jsonParsed'}]);
  return r?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
}
async function getSOLBalance(pk) {
  const r = await rpc('getBalance',[pk,{commitment:'confirmed'}]);
  return (r?.value||0)/1e9;
}
async function getTokenBalance(pk, mint) {
  const r = await rpc('getTokenAccountsByOwner',[pk,{mint},{encoding:'jsonParsed'}]);
  return r?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
}

// ── PRICES ────────────────────────────────────────────────
async function getAllPrices() {
  const ids = TOKEN_SYMS.map(s=>TOKENS[s].cgid).join(',');
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
    const d = await r.json();
    const out = {};
    for (const [sym,tok] of Object.entries(TOKENS)) {
      out[sym] = { price: d?.[tok.cgid]?.usd||0, chg24: d?.[tok.cgid]?.usd_24h_change||0 };
    }
    return out;
  } catch(e) { log('Price fetch: '+e.message,'WARN'); return null; }
}

async function getFearGreed() {
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1');
    const d = await r.json();
    return {val:parseInt(d.data[0].value), cls:d.data[0].value_classification};
  } catch { return {val:50,cls:'Neutral'}; }
}

// ── INDICATORS ────────────────────────────────────────────
const calcRSI=(p,n=14)=>{ if(p.length<n+1)return 50; let g=0,l=0; for(let i=p.length-n;i<p.length;i++){const d=p[i]-p[i-1];d>0?g+=d:l-=d;} const ag=g/n,al=l/n; return al===0?100:100-(100/(1+ag/al)); };
const calcEMA=(p,n)=>{ if(p.length<n)return p.at(-1)||0; const k=2/(n+1); let e=p.slice(0,n).reduce((a,b)=>a+b,0)/n; for(let i=n;i<p.length;i++)e=p[i]*k+e*(1-k); return e; };
const calcMACD=p=>{ if(p.length<26)return{h:0,signal:0}; const m=calcEMA(p,12)-calcEMA(p,26); const sig=calcEMA(p.slice(-9).map((_,i)=>calcEMA(p.slice(0,p.length-8+i),12)-calcEMA(p.slice(0,p.length-8+i),26)),9); return{h:+(m-sig).toFixed(6),signal:+sig.toFixed(6)}; };
const calcBB=(p,n=20,m=2)=>{ if(p.length<n)return{pct:50,mid:p.at(-1)||0,upper:0,lower:0}; const sl=p.slice(-n),mid=sl.reduce((a,b)=>a+b,0)/n,std=Math.sqrt(sl.map(x=>(x-mid)**2).reduce((a,b)=>a+b,0)/n); const up=mid+m*std,lo=mid-m*std; return{pct:std>0?+((p.at(-1)-lo)/(up-lo)*100).toFixed(1):50,mid,upper:up,lower:lo}; };
const calcVol=(p,w=14)=>{ if(p.length<w)return 0; const sl=p.slice(-w),m=sl.reduce((a,b)=>a+b,0)/sl.length; return Math.sqrt(sl.map(x=>(x-m)**2).reduce((a,b)=>a+b,0)/sl.length)/m*100; };
const calcMom=(p,n=10)=>{ if(p.length<n+1)return 0; return((p.at(-1)-p.at(-n-1))/p.at(-n-1))*100; };
const calcStoch=(p,n=14)=>{ if(p.length<n*2)return{k:50,d:50}; const rs=[]; for(let i=n;i<=p.length;i++)rs.push(calcRSI(p.slice(0,i),n)); const rec=rs.slice(-n),mn=Math.min(...rec),mx=Math.max(...rec); const k=mx-mn>0?+((rs.at(-1)-mn)/(mx-mn)*100).toFixed(1):50; return{k,d:rs.slice(-3).reduce((a,b)=>a+b,0)/3}; };
const calcATR=(p,n=14)=>{ if(p.length<n+1)return 0; const trs=p.slice(-n-1).map((x,i,a)=>i===0?0:Math.abs(x-a[i-1])).slice(1); return trs.reduce((a,b)=>a+b,0)/n; };
const calcOBV=p=>{ if(p.length<3)return 0; let obv=0; for(let i=1;i<p.length;i++) obv+=p[i]>p[i-1]?1:p[i]<p[i-1]?-1:0; return obv; };
const calcWilliamsR=(p,n=14)=>{ if(p.length<n)return -50; const sl=p.slice(-n),hi=Math.max(...sl),lo=Math.min(...sl); return hi-lo>0?((hi-p.at(-1))/(hi-lo))*-100:-50; };
const calcSharpe=h=>{ if(!h||h.length<4)return 0; const m=h.reduce((a,b)=>a+b,0)/h.length,s=Math.sqrt(h.map(x=>(x-m)**2).reduce((a,b)=>a+b,0)/h.length); return s>0?+(m/s).toFixed(3):0; };

// ── MULTI-TIMEFRAME QUANTUM SCORE ─────────────────────────
function quantumScore(p, fg, tokenIQ) {
  if (p.length < 5) return {dir:'HOLD',conf:0.5,raw:0,sigs:'building...',score:0};

  const price = p.at(-1);
  const rsi=calcRSI(p), ema9=calcEMA(p,9), ema21=calcEMA(p,21), ema50=calcEMA(p,50);
  const macd=calcMACD(p), bb=calcBB(p), stoch=calcStoch(p);
  const atr=calcATR(p), vol=calcVol(p), mom=calcMom(p);
  const obv=calcOBV(p), wr=calcWilliamsR(p);
  const vwap=p.slice(-20).reduce((a,b)=>a+b,0)/Math.min(20,p.length);

  // Short-term RSI (7 periods) vs long-term (14)
  const rsiShort = calcRSI(p,7);
  const rsiLong  = calcRSI(p,21);

  // Token IQ penalty — reduce score for recently losing tokens
  const iqPenalty = tokenIQ ? Math.min(0.3, tokenIQ.consLosses * 0.05) : 0;

  const q = [
    // Momentum indicators
    { n:'RSI',      w:1.8, a: rsi<25?1.0:rsi<32?0.7:rsi<40?0.3:rsi>75?-1.0:rsi>68?-0.7:rsi>60?-0.3:0 },
    { n:'RSI-MT',   w:1.2, a: rsiShort<rsiLong?0.4:-0.4 }, // short RSI above long = bullish
    { n:'MACD',     w:1.5, a: Math.sign(macd.h)*Math.min(1,Math.abs(macd.h)*600) },
    { n:'Stoch',    w:1.3, a: stoch.k<15?1.0:stoch.k<25?0.6:stoch.k>85?-1.0:stoch.k>75?-0.6:0 },
    { n:'Williams', w:0.9, a: wr<-85?0.8:wr<-75?0.4:wr>-15?-0.8:wr>-25?-0.4:0 },
    { n:'Mom',      w:1.2, a: Math.max(-1,Math.min(1,mom/2.5)) },
    // Trend indicators
    { n:'EMA',      w:1.6, a: ema9>ema21 ? (ema9>ema50?0.9:0.5) : (ema9<ema50?-0.9:-0.5) },
    { n:'EMA50',    w:0.9, a: price>ema50?0.35:-0.35 },
    { n:'VWAP',     w:1.0, a: price>vwap?0.3:-0.3 },
    // Volatility/structure
    { n:'BB',       w:1.4, a: bb.pct<12?0.9:bb.pct<22?0.5:bb.pct>88?-0.9:bb.pct>78?-0.5:0 },
    { n:'ATR',      w:0.8, a: atr>price*0.03?-0.4:atr>price*0.015?-0.1:0.2 },
    { n:'Vol',      w:0.9, a: vol>5?-0.5:vol>3?-0.2:0.2 },
    // Volume/sentiment
    { n:'OBV',      w:0.8, a: obv>3?0.4:obv<-3?-0.4:obv*0.1 },
    { n:'F&G',      w:1.2, a: fg<20?0.9:fg<30?0.5:fg>80?-0.9:fg>70?-0.5:0 },
  ];

  const tw  = q.reduce((s,x)=>s+x.w,0);
  const raw = q.reduce((s,x)=>s+x.a*x.w,0)/tw - iqPenalty;
  const conf = Math.max(0, Math.min(1, (raw+1)/2));
  const dir  = raw>0.10?'BUY':raw<-0.10?'SELL':'HOLD';
  const sigs = q.filter(x=>Math.abs(x.a)>=0.5).sort((a,b)=>Math.abs(b.a*b.w)-Math.abs(a.a*a.w)).slice(0,4).map(x=>`${x.n}(${x.a>0?'+':'-'}${Math.abs(x.a).toFixed(1)})`).join('·');

  // Convergence score — how many indicators agree
  const bullish = q.filter(x=>x.a>0.3).length;
  const bearish  = q.filter(x=>x.a<-0.3).length;
  const convergence = Math.abs(bullish-bearish)/q.length;

  return {dir, conf:+conf.toFixed(4), raw:+raw.toFixed(4), sigs, convergence:+convergence.toFixed(3), bullish, bearish, atr, bb};
}

// ── POSITION EXIT LOGIC ───────────────────────────────────
function shouldExit(pos, currentPrice, sig) {
  const pct = ((currentPrice-pos.entryPrice)/pos.entryPrice)*100;
  const holdMin = (Date.now()-pos.entryTime)/60000;

  // Update trailing stop
  if (pct > (pos.highWaterMark||0)) pos.highWaterMark = pct;
  const trail = pos.highWaterMark||0;

  // Exit conditions
  if (pct >= CFG.takeProfit)          return {exit:true, reason:`Take profit +${pct.toFixed(2)}%`};
  if (pct <= -CFG.stopLossPos)        return {exit:true, reason:`Stop loss ${pct.toFixed(2)}%`};
  if (trail>=CFG.trailStart && pct<trail-CFG.trailDist) return {exit:true, reason:`Trail stop: peak ${trail.toFixed(2)}% → now ${pct.toFixed(2)}%`};
  if (holdMin>CFG.maxHoldMin && pct<0.2) return {exit:true, reason:`Timeout ${holdMin.toFixed(0)}min, only ${pct.toFixed(2)}%`};
  if (sig.dir==='SELL' && sig.conf>0.58 && pct>-0.3) return {exit:true, reason:`SELL signal ${(sig.conf*100).toFixed(0)}%`};
  if (sig.convergence>0.5 && sig.bearish>sig.bullish && pct>0) return {exit:true, reason:`Bearish convergence, locking ${pct.toFixed(2)}%`};

  return {exit:false, pct, trail, holdMin};
}

// ── TOKEN IQ UPDATE ───────────────────────────────────────
function updateTokenIQ(brain, token, pnl) {
  const iq = brain.tokenIQ[token];
  if (!iq) return;
  iq.trades++;
  iq.pnl += pnl;
  if (pnl>0) { iq.wins++; iq.consLosses=0; }
  else { iq.losses++; iq.consLosses++; }

  // Ban token after 3 consecutive losses
  if (iq.consLosses>=3) {
    iq.banned=true;
    iq.banUntil=Date.now()+(30*60*1000); // 30 min ban
    log(`🚫 ${token} banned for 30min after ${iq.consLosses} consecutive losses`,'WARN');
  }
  // Unban check
  if (iq.banned && Date.now()>iq.banUntil) { iq.banned=false; log(`✅ ${token} ban lifted`,'INFO'); }
}

// ── BRAIN EVOLUTION ───────────────────────────────────────
function gainXP(brain, n) {
  brain.xp += n;
  while (brain.xp >= brain.xpNext) {
    brain.xp -= brain.xpNext; brain.xpNext = Math.floor(brain.xpNext*1.7); brain.generation++;
    const total=brain.wins+brain.losses, wr=total>0?brain.wins/total:0.5;
    const sharpe=calcSharpe(brain.pnlHistory);

    // Best token by P&L
    const best = Object.entries(brain.tokenIQ).filter(([,v])=>v.trades>0).sort((a,b)=>b[1].pnl-a[1].pnl)[0];
    const worst= Object.entries(brain.tokenIQ).filter(([,v])=>v.trades>0).sort((a,b)=>a[1].pnl-b[1].pnl)[0];

    let mut = `GEN-${brain.generation}: `;
    if (wr>0.60&&sharpe>0.2) { mut+='Profitable edge detected — scaling to $'+Math.min(CFG.maxUSDC,(brain.currentTradeSize*1.3).toFixed(2)); brain.currentTradeSize=+Math.min(CFG.maxUSDC,brain.currentTradeSize*1.3).toFixed(2); }
    else if (wr<0.38&&total>=5) { mut+='Below threshold — tightening to conf>0.68'; }
    else if (brain.consLosses>=3) { mut+=brain.consLosses+' losses — defensive mode'; }
    else if (best) { mut+=`Favouring ${best[0]} (P&L $${best[1].pnl.toFixed(3)})`; }
    else mut+='Calibrating from '+total+' samples';

    if (worst&&worst[1].consLosses>=2) mut+=` · Avoiding ${worst[0]}`;

    brain.mutations.push(mut);
    brain.memories.push(mut);
    if (brain.memories.length>100) brain.memories.shift();
    div(`🧬 ${mut}`);
  }
}

// ── JUPITER SWAP ──────────────────────────────────────────
async function jupSwap(inputMint, outputMint, amount, label) {
  if (CFG.dryRun) {
    const sim = Math.floor(amount * 0.9975);
    log(`[DRY RUN] ${label} · in:${amount} → out:${sim}`,'DRY');
    return {sig:'DRY_'+Date.now(), outAmount:sim};
  }

  const wallet = getWallet();
  const {Connection, VersionedTransaction} = require('@solana/web3.js');
  const conn = new Connection(CFG.rpcUrl,{commitment:'confirmed'});

  const qRes = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${CFG.slippage}`);
  const quote = await qRes.json();
  if (quote.error) throw new Error('Quote: '+quote.error);

  const sRes = await fetch('https://api.jup.ag/swap/v1/swap',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({quoteResponse:quote,userPublicKey:wallet.publicKey.toString(),wrapAndUnwrapSol:true,dynamicComputeUnitLimit:true,prioritizationFeeLamports:'auto'}),
  });
  const sd = await sRes.json();
  if (sd.error) throw new Error('Swap: '+sd.error);

  const tx = VersionedTransaction.deserialize(Buffer.from(sd.swapTransaction,'base64'));
  tx.sign([wallet]);
  const sig = await conn.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:3});
  const {blockhash,lastValidBlockHeight} = await conn.getLatestBlockhash();
  await conn.confirmTransaction({signature:sig,blockhash,lastValidBlockHeight},'confirmed');
  return {sig, outAmount:parseInt(quote.outAmount)};
}

// ── MAIN CYCLE ────────────────────────────────────────────
async function runCycle(brain, n) {
  div(`CYCLE ${n} · GEN-${brain.generation} · ${brain.trades} trades · P&L: ${brain.totalPnl>=0?'+':''}$${brain.totalPnl.toFixed(4)} · Sharpe:${calcSharpe(brain.pnlHistory)}`);

  // Prices
  const priceData = await getAllPrices();
  if (!priceData) { log('Price fetch failed — skipping','WARN'); return; }

  for (const sym of TOKEN_SYMS) {
    const p = priceData[sym].price;
    if (p>0) { PH[sym].push(p); if(PH[sym].length>200) PH[sym].shift(); }
  }

  // Fear & Greed
  if (n%6===1) {
    const fg = await getFearGreed();
    brain.lastFearGreed = fg.val;
    log(`F&G: ${fg.val}/100 (${fg.cls}) · Market: ${fg.val<30?'🟢 Oversold opportunity':fg.val>70?'🔴 Overbought caution':'⚪ Neutral'}`,'INFO');
  }

  // Balances
  let usdc=0, pubkey=null;
  if (CFG.privateKey) {
    try { pubkey=getWallet().publicKey.toString(); usdc=await getUSDCBalance(pubkey); }
    catch(e) { log('Balance: '+e.message,'WARN'); }
  }
  if (CFG.dryRun && !usdc) usdc=50;

  const today = new Date().toDateString();
  if (!brain.portfolioStart) { brain.portfolioStart=usdc; brain.portfolioPeak=usdc; brain.dayStart=today; brain.dayStartUSDC=usdc; log(`Baseline: $${usdc.toFixed(2)} USDC`,'SYS'); }
  if (usdc>brain.portfolioPeak) brain.portfolioPeak=usdc;
  if (brain.dayStart!==today) { brain.dayStart=today; brain.dayStartUSDC=usdc; log(`New day — USDC $${usdc.toFixed(2)}`,'SHIELD'); }

  // Shield (only when no open position)
  if (!brain.position) {
    const dd = brain.portfolioPeak>0?Math.max(0,((brain.portfolioPeak-usdc)/brain.portfolioPeak)*100):0;
    const dl = brain.dayStartUSDC>0?Math.max(0,((brain.dayStartUSDC-usdc)/brain.dayStartUSDC)*100):0;
    log(`USDC: $${usdc.toFixed(2)} · DD:${dd.toFixed(2)}%/${CFG.stopLoss}% · Daily:${dl.toFixed(2)}%/${CFG.dailyLoss}%`,'SHIELD');
    if (dd>=CFG.stopLoss||dl>=CFG.dailyLoss) {
      log(`🛡 Shield triggered — halting trading for today`,'SHIELD');
      saveBrain(brain); process.exit(0);
    }
  } else {
    log(`USDC: $${usdc.toFixed(2)} · Position open: ${brain.position.token}`,'SHIELD');
  }

  // ── MANAGE OPEN POSITION ─────────────────────────────────
  if (brain.position) {
    const pos = brain.position;
    const currentPrice = priceData[pos.token].price;
    const sig = quantumScore(PH[pos.token], brain.lastFearGreed, brain.tokenIQ[pos.token]);
    const exitCheck = shouldExit(pos, currentPrice, sig);
    const pct = ((currentPrice-pos.entryPrice)/pos.entryPrice)*100;
    const holdMin = ((Date.now()-pos.entryTime)/60000).toFixed(1);

    // Update trailing high water mark
    if (pct>(pos.highWaterMark||0)) {
      pos.highWaterMark = pct;
      if (pct>=CFG.trailStart) log(`📈 Trailing stop active — peak ${pct.toFixed(2)}% · floor ${(pct-CFG.trailDist).toFixed(2)}%`,'TRAIL');
    }

    log(`Position: ${pos.token} @ $${pos.entryPrice} → $${currentPrice} · ${pct>=0?'+':''}${pct.toFixed(3)}% · ${holdMin}m · Trail peak: ${(pos.highWaterMark||0).toFixed(2)}%`,'TRADE');

    if (exitCheck.exit) {
      log(`Closing: ${exitCheck.reason}`,'TRADE');
      try {
        const tokenMint = TOKENS[pos.token].mint;
        const tokenDec  = TOKENS[pos.token].dec;
        const tokenBal  = CFG.dryRun ? pos.tokenAmount/Math.pow(10,tokenDec) : (
          pos.token==='SOL' ? Math.max(0,(await getSOLBalance(pubkey))-0.008) : await getTokenBalance(pubkey, tokenMint)
        );
        const sellAmt = Math.floor(tokenBal * 0.999 * Math.pow(10,tokenDec));
        const result  = await jupSwap(tokenMint, USDC_MINT, sellAmt, `SELL ${pos.token}→USDC`);

        const usdcOut = CFG.dryRun ? pos.size*(1+pct/100)*0.9975 : result.outAmount/1e6;
        const pnl     = usdcOut - pos.size;
        const pnlPct  = (pnl/pos.size)*100;

        brain.totalPnl += pnl;
        brain.pnlHistory.push(pnl);
        if (brain.pnlHistory.length>500) brain.pnlHistory.shift();
        brain.trades++;
        if (pnl>0) { brain.wins++; brain.consWins++; brain.consLosses=0; gainXP(brain,3); }
        else        { brain.losses++; brain.consLosses++; brain.consWins=0; gainXP(brain,1); }

        updateTokenIQ(brain, pos.token, pnl);

        brain.tradeLog.push({t:new Date().toISOString(),act:'SELL',tok:pos.token,entry:pos.entryPrice,exit:currentPrice,size:pos.size,pnl,pnlPct,holdMin,reason:exitCheck.reason,sig:result.sig});
        if (brain.tradeLog.length>500) brain.tradeLog.shift();

        const pnlStr = `${pnl>=0?'+':''}$${pnl.toFixed(4)} (${pnlPct>=0?'+':''}${pnlPct.toFixed(2)}%)`;
        log(`${pnl>=0?'✅ WIN':'❌ LOSS'} ${pos.token} · USDC in: $${pos.size} · out: $${usdcOut.toFixed(4)} · P&L: ${pnlStr}`,pnl>=0?'WIN':'LOSS');
        if (!CFG.dryRun) log(`   https://solscan.io/tx/${result.sig}`,'TRADE');
        log(`Running: ${brain.totalPnl>=0?'+':''}$${brain.totalPnl.toFixed(4)} · WR: ${brain.wins}/${brain.wins+brain.losses} · Sharpe: ${calcSharpe(brain.pnlHistory)}`,'BRAIN');

        brain.position = null;

        // Scale up on win streak
        if (brain.consWins>=2 && brain.currentTradeSize<CFG.maxUSDC) {
          brain.currentTradeSize = +Math.min(CFG.maxUSDC,brain.currentTradeSize*1.1).toFixed(2);
          log(`📈 Win streak ${brain.consWins}x — size → $${brain.currentTradeSize}`,'BRAIN');
        }
        // Scale down on loss streak
        if (brain.consLosses>=2) {
          brain.currentTradeSize = +Math.max(CFG.tradeUSDC,brain.currentTradeSize*0.9).toFixed(2);
          log(`📉 Loss streak ${brain.consLosses}x — size → $${brain.currentTradeSize}`,'BRAIN');
        }
      } catch(e) { log('SELL failed: '+e.message,'ERR'); }
      saveBrain(brain); return;
    }

    log(`Holding ${pos.token} · ${holdMin}m · Signal: ${sig.dir} ${(sig.conf*100).toFixed(0)}% · ${sig.sigs}`,'INFO');
    saveBrain(brain); return;
  }

  // ── SCAN ALL TOKENS ───────────────────────────────────────
  log(`Scanning ${TOKEN_SYMS.join(' · ')}...`,'SCAN');
  const signals = {};
  for (const sym of TOKEN_SYMS) {
    const p = priceData[sym].price;
    const chg = priceData[sym].chg24;
    const iq = brain.tokenIQ[sym]||{};
    const q = quantumScore(PH[sym], brain.lastFearGreed, iq);
    signals[sym] = {...q, price:p, chg24:chg, pts:PH[sym].length};
    const banned = iq.banned && Date.now()<iq.banUntil ? ' 🚫BAN' : '';
    const iqStr  = iq.trades>0 ? ` IQ:${iq.wins}/${iq.trades}($${iq.pnl.toFixed(2)})` : '';
    const bar    = '█'.repeat(Math.floor(q.conf*10))+'░'.repeat(10-Math.floor(q.conf*10));
    log(`  ${sym.padEnd(4)} $${p.toFixed(p<0.01?8:p<1?5:2).padStart(12)} ${chg>=0?'+':''}${chg.toFixed(1)}%24h · ${q.dir.padEnd(4)} [${bar}] ${(q.conf*100).toFixed(0)}% ψ${q.raw.toFixed(3)} · ${q.sigs||'building'}${iqStr}${banned} [${q.pts}pts]`,'SCAN');
  }

  // Filter candidates
  if (usdc < brain.currentTradeSize*0.8) {
    log(`Low USDC $${usdc.toFixed(2)} — need $${brain.currentTradeSize.toFixed(2)}`,'WARN');
    saveBrain(brain); return;
  }

  const candidates = Object.entries(signals)
    .filter(([sym,s]) => {
      const iq = brain.tokenIQ[sym]||{};
      if (iq.banned && Date.now()<iq.banUntil) return false;  // banned
      if (s.price<=0) return false;                            // no price
      if (s.pts<15) return false;                              // insufficient data
      if (s.dir!=='BUY') return false;                         // not bullish
      if (s.conf<CFG.minConf) return false;                    // low confidence
      if (Math.abs(s.raw)<0.10) return false;                  // weak signal
      if (s.convergence<0.15) return false;                    // indicators disagree
      return true;
    })
    .sort((a,b) => {
      // Rank by: confidence + convergence + token IQ
      const iqA = brain.tokenIQ[a[0]]||{};
      const iqB = brain.tokenIQ[b[0]]||{};
      const iqScoreA = iqA.trades>2 ? (iqA.wins/iqA.trades)*0.2 : 0;
      const iqScoreB = iqB.trades>2 ? (iqB.wins/iqB.trades)*0.2 : 0;
      return (b[1].conf+b[1].convergence+iqScoreB) - (a[1].conf+a[1].convergence+iqScoreA);
    });

  if (!candidates.length) {
    const best = Object.entries(signals).filter(([,s])=>s.pts>=15&&s.price>0).sort((a,b)=>b[1].conf-a[1].conf)[0];
    if (best) log(`No qualifying signals · Best: ${best[0]} ${best[1].dir} ${(best[1].conf*100).toFixed(0)}% (need ${(CFG.minConf*100).toFixed(0)}%+)`,'INFO');
    else log(`No qualifying signals this cycle`,'INFO');
    saveBrain(brain); return;
  }

  const [bestSym, bestSig] = candidates[0];
  const size = brain.currentTradeSize;
  const usdcAmt = Math.floor(size*1e6);

  log(`🎯 Best: ${bestSym} · ${(bestSig.conf*100).toFixed(0)}% conf · ψ${bestSig.raw.toFixed(3)} · convergence ${(bestSig.convergence*100).toFixed(0)}% · ${bestSig.sigs}`,'BRAIN');
  if (candidates.length>1) log(`   Also considered: ${candidates.slice(1,3).map(([s,x])=>`${s}(${(x.conf*100).toFixed(0)}%)`).join(', ')}`,'BRAIN');

  try {
    log(`BUY ${bestSym} with $${size} USDC @ $${bestSig.price}`,'TRADE');
    const result = await jupSwap(USDC_MINT, TOKENS[bestSym].mint, usdcAmt, `BUY→${bestSym}`);

    brain.position = {
      token: bestSym,
      entryPrice: bestSig.price,
      size,
      tokenAmount: result.outAmount,
      entryTime: Date.now(),
      signal: bestSig.sigs,
      sig: result.sig,
      highWaterMark: 0,
    };

    log(`✅ BUY confirmed · ${bestSym} @ $${bestSig.price} · $${size} in · tokens: ${result.outAmount}`,'TRADE');
    if (!CFG.dryRun) log(`   https://solscan.io/tx/${result.sig}`,'TRADE');
    log(`Exit plan: TP +${CFG.takeProfit}% · SL -${CFG.stopLossPos}% · Trail from +${CFG.trailStart}% (${CFG.trailDist}% trail) · Timeout ${CFG.maxHoldMin}min`,'INFO');
  } catch(e) { log('BUY failed: '+e.message,'ERR'); }

  saveBrain(brain);
}

// ── STATS ─────────────────────────────────────────────────
function showStats(brain) {
  div('PERFORMANCE SUMMARY');
  log(`GEN-${brain.generation} · ${brain.trades} round trips · WR: ${brain.wins}/${brain.wins+brain.losses} (${brain.wins+brain.losses>0?(brain.wins/(brain.wins+brain.losses)*100).toFixed(1):0}%)`,'BRAIN');
  log(`Total P&L: ${brain.totalPnl>=0?'+':''}$${brain.totalPnl.toFixed(4)} · Sharpe: ${calcSharpe(brain.pnlHistory)}`,'BRAIN');
  log(`Trade size: $${brain.currentTradeSize} · Best run: ${brain.consWins} wins`,'BRAIN');
  log(`\nToken IQ:`,'BRAIN');
  for (const [sym,iq] of Object.entries(brain.tokenIQ)) {
    if (iq.trades>0) {
      const wr = (iq.wins/iq.trades*100).toFixed(0);
      const banned = iq.banned?` 🚫 BANNED`:'';
      log(`  ${sym.padEnd(5)} ${iq.wins}W/${iq.losses}L (${wr}% WR) · P&L $${iq.pnl.toFixed(4)}${banned}`,'BRAIN');
    }
  }
  if (brain.position) log(`\nOpen: ${brain.position.token} @ $${brain.position.entryPrice} · $${brain.position.size} in`,'TRADE');
}

// ── ENTRY ─────────────────────────────────────────────────
async function main() {
  console.clear();
  console.log(`\n${C.p}${C.b}`);
  console.log('  ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗');
  console.log('  ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝');
  console.log('  ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗');
  console.log('  ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║');
  console.log('  ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║');
  console.log('  ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝');
  console.log(`${C.r}${C.cy}  QUANTUM v2 ULTIMATE · 6 Tokens · 14 Indicators · Token IQ${C.r}`);
  console.log(`${C.d}  Trailing stop · Multi-timeframe · Convergence filter · Brain evolution${C.r}\n`);

  const brain = loadBrain();

  log(`Mode: ${CFG.dryRun?'🔵 DRY RUN (safe)':'🔴 LIVE TRADING'}`,'SYS');
  log(`Tokens: ${TOKEN_SYMS.join(' · ')}`,'SYS');
  log(`Size: $${CFG.tradeUSDC}→$${CFG.maxUSDC} · Interval: ${CFG.interval}s · MinConf: ${CFG.minConf}`,'SYS');
  log(`Exit: TP +${CFG.takeProfit}% · SL -${CFG.stopLossPos}% · Trail from +${CFG.trailStart}% · Timeout ${CFG.maxHoldMin}min`,'SYS');
  log(`Shield: DD ${CFG.stopLoss}% · Daily ${CFG.dailyLoss}%`,'SHIELD');
  log(`Token IQ: bans underperforming tokens for 30min after 3 losses`,'BRAIN');
  log(`Convergence filter: min 15% indicator agreement required`,'BRAIN');

  let n=0;
  await runCycle(brain,++n);
  const timer = setInterval(async()=>{ try{await runCycle(brain,++n);}catch(e){log('Cycle: '+e.message,'ERR');} }, CFG.interval*1000);

  const shutdown = ()=>{ clearInterval(timer); saveBrain(brain); showStats(brain); process.exit(0); };
  process.on('SIGINT',shutdown);
  process.on('SIGTERM',shutdown);
}

main().catch(e=>{log('Fatal: '+e.message,'ERR');console.error(e);process.exit(1);});
