#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');

// ── CONFIG ──────────────────────────────────────────────
const CFG = {
  orKey:      process.env.OPENROUTER_API_KEY,
  groqKey:    process.env.GROQ_API_KEY,
  privateKey: process.env.WALLET_PRIVATE_KEY,
  rpcUrl:     process.env.RPC_URL         || 'https://api.mainnet-beta.solana.com',
  tradeUSDC:  parseFloat(process.env.TRADE_SIZE_USD     || '5'),
  maxUSDC:    parseFloat(process.env.MAX_TRADE_SIZE_USD || '20'),
  stopLoss:   parseFloat(process.env.STOP_LOSS_PCT      || '20'),
  dailyLoss:  parseFloat(process.env.DAILY_LOSS_PCT     || '20'),
  takePct:    parseFloat(process.env.TAKE_PROFIT_PCT    || '3.0'),
  slPct:      parseFloat(process.env.STOP_LOSS_TRADE_PCT|| '1.5'),
  minConf:    parseFloat(process.env.MIN_CONFIDENCE     || '0.62'),
  interval:   parseInt  (process.env.INTERVAL_SECONDS   || '30'),
  slippage:   parseInt  (process.env.SLIPPAGE_BPS       || '100'),
  brainFile:  process.env.BRAIN_FILE      || './brain.json',
  dryRun:     process.env.DRY_RUN !== 'false',
};

// ── TOKENS ───────────────────────────────────────────────
const TOKENS = {
  SOL:  { cgid:'solana',                      mint:'So11111111111111111111111111111111111111112',  dec:9 },
  JUP:  { cgid:'jupiter-exchange-solana',      mint:'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', dec:6 },
  WIF:  { cgid:'dogwifcoin',                   mint:'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', dec:6 },
  BONK: { cgid:'bonk',                         mint:'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', dec:5 },
};
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ── TERMINAL ─────────────────────────────────────────────
const C = { r:'\x1b[0m',b:'\x1b[1m',d:'\x1b[2m',cy:'\x1b[36m',g:'\x1b[32m',re:'\x1b[31m',y:'\x1b[33m',p:'\x1b[35m',w:'\x1b[37m',bl:'\x1b[34m' };
const TCOL = { INFO:C.cy,TRADE:C.g,WIN:C.g,LOSS:C.re,WARN:C.y,ERR:C.re,BRAIN:C.p,SHIELD:C.y,SYS:C.w,SCAN:C.bl,DRY:C.d };
const ts  = () => new Date().toISOString().slice(11,19);
const log = (m,t='INFO') => console.log(`${C.d}[${ts()}]${C.r} ${TCOL[t]||C.w}[${t}]${C.r} ${m}`);
const div = (m='') => { console.log(`\n${C.p}${'═'.repeat(62)}${C.r}`); if(m) console.log(`${C.b}  ${m}${C.r}`); console.log(`${C.p}${'═'.repeat(62)}${C.r}`); };

// ── PRICE HISTORY per token ───────────────────────────────
const PH = { SOL:[], JUP:[], WIF:[], BONK:[] };

// ── BRAIN ─────────────────────────────────────────────────
const defaultBrain = () => ({
  generation:1, xp:0, xpNext:5,
  trades:0, wins:0, losses:0,
  totalPnl:0, pnlHistory:[],
  consWins:0, consLosses:0,
  memories:[], mutations:[],
  tokenStats:{ SOL:{trades:0,wins:0,pnl:0}, JUP:{trades:0,wins:0,pnl:0}, WIF:{trades:0,wins:0,pnl:0}, BONK:{trades:0,wins:0,pnl:0} },
  currentTradeSize: CFG.tradeUSDC,
  portfolioStart:null, portfolioPeak:0,
  dayStart:null, dayStartUSDC:0,
  lastFearGreed:50,
  tradeLog:[],
  // Open position tracking
  position: null, // { token, entryPrice, entryUSDC, entryTime, size }
});

const loadBrain = () => {
  try {
    if (fs.existsSync(CFG.brainFile)) {
      const b = JSON.parse(fs.readFileSync(CFG.brainFile,'utf8'));
      // Ensure new fields exist
      if (!b.tokenStats) b.tokenStats = defaultBrain().tokenStats;
      if (!b.position) b.position = null;
      log(`Brain loaded — GEN-${b.generation} · ${b.trades} trades · ${b.wins}W/${b.losses}L · P&L: ${b.totalPnl>=0?'+':''}$${b.totalPnl.toFixed(4)}`,'BRAIN');
      if (b.position) log(`Open position: ${b.position.token} @ $${b.position.entryPrice} (${b.position.size} USDC in)`,'BRAIN');
      return b;
    }
  } catch(e) { log('Brain corrupt — fresh start','WARN'); }
  return defaultBrain();
};
const saveBrain = b => { try { fs.writeFileSync(CFG.brainFile, JSON.stringify(b,null,2)); } catch(e) { log('Save: '+e.message,'WARN'); } };

// ── SOLANA RPC ────────────────────────────────────────────
async function rpc(method, params) {
  try {
    const r = await fetch(CFG.rpcUrl, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}) });
    return (await r.json()).result;
  } catch { return null; }
}

function getWallet() {
  const { Keypair } = require('@solana/web3.js');
  const bs58 = require('bs58');
  return Keypair.fromSecretKey(Buffer.from(bs58.decode(CFG.privateKey)));
}

async function getUSDCBalance(pubkey) {
  const r = await rpc('getTokenAccountsByOwner',[pubkey,{mint:USDC_MINT},{encoding:'jsonParsed'}]);
  return r?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
}

async function getTokenBalance(pubkey, mint) {
  const r = await rpc('getTokenAccountsByOwner',[pubkey,{mint},{encoding:'jsonParsed'}]);
  return r?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
}

async function getSOLBalance(pubkey) {
  const r = await rpc('getBalance',[pubkey,{commitment:'confirmed'}]);
  return (r?.value||0)/1e9;
}

// ── PRICES ────────────────────────────────────────────────
async function getAllPrices() {
  const ids = Object.values(TOKENS).map(t=>t.cgid).join(',');
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
    const d = await r.json();
    const prices = {};
    for (const [sym, tok] of Object.entries(TOKENS)) {
      prices[sym] = d?.[tok.cgid]?.usd || 0;
    }
    return prices;
  } catch(e) {
    log('Price fetch failed: '+e.message,'WARN');
    return null;
  }
}

async function getFearGreed() {
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1');
    const d = await r.json();
    return { val:parseInt(d.data[0].value), cls:d.data[0].value_classification };
  } catch { return {val:50,cls:'Neutral'}; }
}

// ── INDICATORS ────────────────────────────────────────────
const calcRSI=(p,n=14)=>{ if(p.length<n+1)return 50; let g=0,l=0; for(let i=p.length-n;i<p.length;i++){const d=p[i]-p[i-1];d>0?g+=d:l-=d;} const ag=g/n,al=l/n; return al===0?100:100-(100/(1+ag/al)); };
const calcEMA=(p,n)=>{ if(p.length<n)return p.at(-1)||0; const k=2/(n+1); let e=p.slice(0,n).reduce((a,b)=>a+b,0)/n; for(let i=n;i<p.length;i++)e=p[i]*k+e*(1-k); return e; };
const calcMACD=p=>{ if(p.length<26)return{h:0}; return{h:+(calcEMA(p,12)-calcEMA(p,26)).toFixed(6)}; };
const calcBB=(p,n=20,m=2)=>{ if(p.length<n)return{pct:50,mid:p.at(-1)||0}; const sl=p.slice(-n),mid=sl.reduce((a,b)=>a+b,0)/n,std=Math.sqrt(sl.map(x=>(x-mid)**2).reduce((a,b)=>a+b,0)/n); const up=mid+m*std,lo=mid-m*std; return{pct:std>0?+((p.at(-1)-lo)/(up-lo)*100).toFixed(1):50,mid}; };
const calcVol=(p,w=14)=>{ if(p.length<w)return 0; const sl=p.slice(-w),m=sl.reduce((a,b)=>a+b,0)/sl.length; return Math.sqrt(sl.map(x=>(x-m)**2).reduce((a,b)=>a+b,0)/sl.length)/m*100; };
const calcMom=(p,n=10)=>{ if(p.length<n+1)return 0; return((p.at(-1)-p.at(-n-1))/p.at(-n-1))*100; };
const calcStoch=(p,n=14)=>{ if(p.length<n*2)return{k:50}; const rs=[]; for(let i=n;i<=p.length;i++)rs.push(calcRSI(p.slice(0,i),n)); const rec=rs.slice(-n),mn=Math.min(...rec),mx=Math.max(...rec); return{k:mx-mn>0?+((rs.at(-1)-mn)/(mx-mn)*100).toFixed(1):50}; };
const calcATR=(p,n=14)=>{ if(p.length<n+1)return 0; const trs=p.slice(-n-1).map((x,i,a)=>i===0?0:Math.abs(x-a[i-1])).slice(1); return trs.reduce((a,b)=>a+b,0)/n; };

// ── QUANTUM SCORE ─────────────────────────────────────────
function quantumScore(p, fg) {
  if (p.length < 5) return { dir:'HOLD', conf:0.5, raw:0, sigs:'insufficient data' };
  const price = p.at(-1);
  const rsi=calcRSI(p), ema9=calcEMA(p,9), ema21=calcEMA(p,21), ema50=calcEMA(p,50);
  const macd=calcMACD(p), bb=calcBB(p), stoch=calcStoch(p);
  const atr=calcATR(p), vol=calcVol(p), mom=calcMom(p);
  const vwap=p.slice(-20).reduce((a,b)=>a+b,0)/Math.min(20,p.length);

  const q = [
    { n:'RSI',      w:1.8, a: rsi<25?1:rsi<35?0.6:rsi>75?-1:rsi>65?-0.6:0 },
    { n:'MACD',     w:1.5, a: Math.sign(macd.h)*Math.min(1,Math.abs(macd.h)*800) },
    { n:'BB',       w:1.4, a: bb.pct<15?0.9:bb.pct<25?0.5:bb.pct>85?-0.9:bb.pct>75?-0.5:0 },
    { n:'StochRSI', w:1.3, a: stoch.k<15?1:stoch.k<25?0.5:stoch.k>85?-1:stoch.k>75?-0.5:0 },
    { n:'EMA',      w:1.6, a: ema9>ema21?(ema9>ema50?0.9:0.5):(ema9<ema50?-0.9:-0.5) },
    { n:'Mom',      w:1.2, a: Math.max(-1,Math.min(1,mom/3)) },
    { n:'VWAP',     w:1.1, a: price>vwap?0.3:-0.3 },
    { n:'Vol',      w:1.0, a: vol>4?-0.5:vol>2.5?-0.2:0.2 },
    { n:'ATR',      w:0.8, a: atr>price*0.025?-0.3:0.2 },
    { n:'F&G',      w:1.2, a: fg<25?0.8:fg<35?0.4:fg>75?-0.8:fg>65?-0.4:0 },
  ];
  const tw = q.reduce((s,x)=>s+x.w,0);
  const raw = q.reduce((s,x)=>s+x.a*x.w,0)/tw;
  const conf = (raw+1)/2;
  const dir = raw>0.08?'BUY':raw<-0.08?'SELL':'HOLD';
  const sigs = q.filter(x=>Math.abs(x.a)>=0.5).sort((a,b)=>Math.abs(b.a*b.w)-Math.abs(a.a*a.w)).slice(0,3).map(x=>`${x.n}(${x.a>0?'+':'-'}${Math.abs(x.a).toFixed(1)})`).join('·');
  return { dir, conf:+conf.toFixed(4), raw:+raw.toFixed(4), sigs };
}

// ── JUPITER SWAP ──────────────────────────────────────────
async function swap(inputMint, outputMint, amount, label) {
  if (CFG.dryRun) {
    log(`[DRY RUN] ${label} · amount: ${amount}`,'DRY');
    return { sig:'DRY_'+Date.now(), outAmount: amount * 0.9975 }; // simulate 0.25% fee
  }
  const wallet = getWallet();
  const { Connection, VersionedTransaction } = require('@solana/web3.js');
  const conn = new Connection(CFG.rpcUrl,{commitment:'confirmed'});

  const qRes = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${CFG.slippage}`);
  const quote = await qRes.json();
  if (quote.error) throw new Error('Quote: '+quote.error);

  const sRes = await fetch('https://api.jup.ag/swap/v1/swap', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({quoteResponse:quote,userPublicKey:wallet.publicKey.toString(),wrapAndUnwrapSol:true,dynamicComputeUnitLimit:true,prioritizationFeeLamports:'auto'}),
  });
  const swapData = await sRes.json();
  if (swapData.error) throw new Error('Swap: '+swapData.error);

  const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction,'base64'));
  tx.sign([wallet]);
  const sig = await conn.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:3});
  const {blockhash,lastValidBlockHeight} = await conn.getLatestBlockhash();
  await conn.confirmTransaction({signature:sig,blockhash,lastValidBlockHeight},'confirmed');
  return { sig, outAmount: parseInt(quote.outAmount) };
}

// ── BRAIN EVOLUTION ───────────────────────────────────────
const calcSharpe=h=>{ if(!h||h.length<4)return 0; const m=h.reduce((a,b)=>a+b,0)/h.length,s=Math.sqrt(h.map(x=>(x-m)**2).reduce((a,b)=>a+b,0)/h.length); return s>0?+(m/s).toFixed(3):0; };

function gainXP(brain, n) {
  brain.xp += n;
  while (brain.xp >= brain.xpNext) {
    brain.xp -= brain.xpNext; brain.xpNext = Math.floor(brain.xpNext*1.7); brain.generation++;
    const total=brain.wins+brain.losses, wr=total>0?brain.wins/total:0.5;
    // Best performing token
    const best = Object.entries(brain.tokenStats).sort((a,b)=>b[1].pnl-a[1].pnl)[0];
    let mut;
    if (wr>0.60) mut = `WR ${(wr*100).toFixed(0)}% — expanding to $${Math.min(CFG.maxUSDC,brain.currentTradeSize*1.5).toFixed(2)}`;
    else if (brain.consLosses>=3) mut = `${brain.consLosses} losses — tightening to high-conviction only`;
    else mut = `Best token: ${best[0]} P&L $${best[1].pnl.toFixed(3)} — favouring`;
    brain.mutations.push(mut);
    brain.memories.push(`[G${brain.generation}] ${mut}`);
    if (brain.memories.length>100) brain.memories.shift();
    div(`🧬 GEN-${brain.generation}: ${mut}`);
  }
}

// ── MAIN CYCLE ────────────────────────────────────────────
async function runCycle(brain, n) {
  div(`CYCLE ${n} · GEN-${brain.generation} · ${brain.trades} trades · P&L: ${brain.totalPnl>=0?'+':''}$${brain.totalPnl.toFixed(4)}`);

  // 1. Fetch all prices
  const prices = await getAllPrices();
  if (!prices) { log('Price fetch failed — skipping','WARN'); return; }

  // Update price histories
  for (const sym of Object.keys(TOKENS)) {
    if (prices[sym]) { PH[sym].push(prices[sym]); if(PH[sym].length>200) PH[sym].shift(); }
  }

  // 2. Fear & Greed every 4 cycles
  if (n%4===1) {
    const fg = await getFearGreed();
    brain.lastFearGreed = fg.val;
    log(`F&G: ${fg.val}/100 (${fg.cls})`,'INFO');
  }

  // 3. Get USDC balance
  let usdc = 0;
  let pubkey = null;
  if (CFG.privateKey) {
    try { pubkey=getWallet().publicKey.toString(); usdc=await getUSDCBalance(pubkey); }
    catch(e) { log('Balance error: '+e.message,'WARN'); }
  }
  if (CFG.dryRun && !usdc) usdc = 50; // simulated balance for dry run

  const today = new Date().toDateString();
  if (!brain.portfolioStart) { brain.portfolioStart=usdc; brain.portfolioPeak=usdc; brain.dayStart=today; brain.dayStartUSDC=usdc; log(`Baseline USDC: $${usdc.toFixed(2)}`,'SYS'); }
  if (usdc>brain.portfolioPeak) brain.portfolioPeak=usdc;
  if (brain.dayStart!==today) { brain.dayStart=today; brain.dayStartUSDC=usdc; log(`New day — USDC baseline $${usdc.toFixed(2)}`,'SHIELD'); }

  // 4. Shield check
  const dd = brain.portfolioPeak>0?Math.max(0,((brain.portfolioPeak-usdc)/brain.portfolioPeak)*100):0;
  const dl = brain.dayStartUSDC>0?Math.max(0,((brain.dayStartUSDC-usdc)/brain.dayStartUSDC)*100):0;
  log(`USDC: $${usdc.toFixed(2)} · DD:${dd.toFixed(2)}%/${CFG.stopLoss}% · Daily:${dl.toFixed(2)}%/${CFG.dailyLoss}%`,'SHIELD');
  if (!brain.position && (dd>=CFG.stopLoss||dl>=CFG.dailyLoss) && brain.trades>2) { log(`🛡 Shield triggered — halting`,'SHIELD'); saveBrain(brain); process.exit(0); }

  // 5. Scan all tokens
  log(`Scanning ${Object.keys(TOKENS).join(' · ')}...`,'SCAN');
  const signals = {};
  for (const sym of Object.keys(TOKENS)) {
    const q = quantumScore(PH[sym], brain.lastFearGreed);
    const pts = PH[sym].length;
    signals[sym] = { ...q, price:prices[sym], pts };
    log(`  ${sym.padEnd(4)} $${prices[sym].toFixed(5).padStart(10)} · ${q.dir.padEnd(4)} ψ:${q.raw.toFixed(3)} · ${(q.conf*100).toFixed(0)}% · ${q.sigs||'building...'}  [${pts}pts]`,'SCAN');
  }

  // 6. Check open position — should we SELL?
  if (brain.position) {
    const pos = brain.position;
    const currentPrice = prices[pos.token];
    const priceChange = ((currentPrice-pos.entryPrice)/pos.entryPrice)*100;
    const holdTime = ((Date.now()-pos.entryTime)/1000/60).toFixed(1);
    const sig = signals[pos.token];

    const shouldSell =
      (sig.dir==='SELL' && sig.conf>0.55) ||
      (sig.dir==='HOLD' && sig.conf<0.45 && priceChange<0) ||
      priceChange >= CFG.takePct ||
      priceChange <= -CFG.slPct ||
      (parseFloat(holdTime) > 10 && priceChange < 0.3);

    log(`Position: ${pos.token} @ $${pos.entryPrice.toFixed(5)} · now $${currentPrice.toFixed(5)} · ${priceChange>=0?'+':''}${priceChange.toFixed(3)}% · held ${holdTime}m`,'TRADE');

    if (shouldSell) {
      log(`Closing ${pos.token} position — ${sig.dir} signal · ${priceChange>=0?'+':''}${priceChange.toFixed(3)}%`,'TRADE');
      try {
        const tokenMint = TOKENS[pos.token].mint;
        const tokenDec = TOKENS[pos.token].dec;
        const tokenBal = CFG.dryRun ? pos.size/pos.entryPrice : (pos.tokenAmount/Math.pow(10,tokenDec))*0.999;

        const tokenAmount = Math.floor(tokenBal * 0.999 * Math.pow(10, tokenDec));
        const result = await swap(tokenMint, USDC_MINT, tokenAmount, `SELL ${pos.token}→USDC`);

        const usdcReceived = CFG.dryRun ? pos.size*(1+priceChange/100)*0.9975 : (result.outAmount/1e6);
        const pnl = usdcReceived - pos.size;
        const pnlPct = (pnl/pos.size)*100;

        brain.totalPnl += pnl;
        brain.pnlHistory.push(pnl);
        if (brain.pnlHistory.length>500) brain.pnlHistory.shift();
        brain.trades++;
        if (pnl>0) { brain.wins++; brain.consWins++; brain.consLosses=0; gainXP(brain,3); }
        else { brain.losses++; brain.consLosses++; brain.consWins=0; gainXP(brain,1); }

        if (!brain.tokenStats[pos.token]) brain.tokenStats[pos.token]={trades:0,wins:0,pnl:0};
        brain.tokenStats[pos.token].trades++;
        brain.tokenStats[pos.token].pnl += pnl;
        if (pnl>0) brain.tokenStats[pos.token].wins++;

        brain.tradeLog.push({time:new Date().toISOString(),action:'SELL',token:pos.token,entry:pos.entryPrice,exit:currentPrice,size:pos.size,pnl,pnlPct,holdTime,sig:result.sig});
        if (brain.tradeLog.length>500) brain.tradeLog.shift();

        log(`${pnl>=0?'✅ WIN':'❌ LOSS'} SELL ${pos.token} → $${usdcReceived.toFixed(4)} USDC · P&L: ${pnl>=0?'+':''}$${pnl.toFixed(4)} (${pnlPct>=0?'+':''}${pnlPct.toFixed(2)}%)`,pnl>=0?'WIN':'LOSS');
        log(`   Sig: ${result.sig}`,'TRADE');
        log(`Total P&L: ${brain.totalPnl>=0?'+':''}$${brain.totalPnl.toFixed(4)} · WR: ${brain.wins}/${brain.wins+brain.losses} · Sharpe: ${calcSharpe(brain.pnlHistory)}`,'BRAIN');

        brain.position = null;
        if (pnl>0 && brain.currentTradeSize<CFG.maxUSDC) {
          brain.currentTradeSize = +Math.min(CFG.maxUSDC, brain.currentTradeSize*1.1).toFixed(2);
          log(`📈 Scaling up → $${brain.currentTradeSize} per trade`,'BRAIN');
        }
      } catch(e) {
        log('SELL failed: '+e.message,'ERR');
      }
      saveBrain(brain);
      return;
    }
    log(`Holding ${pos.token} · signal: ${sig.dir} · ${holdTime}m in`,'INFO');
    saveBrain(brain); return;
  }

  // 7. No position — find best BUY signal
  if (usdc < brain.currentTradeSize * 0.8) {
    log(`Low USDC $${usdc.toFixed(2)} — need $${brain.currentTradeSize.toFixed(2)} to trade`,'WARN');
    saveBrain(brain); return;
  }

  const candidates = Object.entries(signals)
    .filter(([sym,s]) => s.dir==='BUY' && s.conf>=CFG.minConf && Math.abs(s.raw)>=0.08 && s.pts>=15)
    .sort((a,b)=>b[1].conf-a[1].conf);

  if (!candidates.length) {
    log(`No qualifying BUY signals this cycle (min conf: ${CFG.minConf})`,'INFO');
    saveBrain(brain); return;
  }

  const [bestSym, bestSig] = candidates[0];
  log(`Best signal: ${bestSym} · ${(bestSig.conf*100).toFixed(0)}% · ${bestSig.sigs}`,'BRAIN');

  const size = brain.currentTradeSize;
  const usdcAmount = Math.floor(size * 1e6);
  const tokenMint = TOKENS[bestSym].mint;

  try {
    log(`BUY ${bestSym} with $${size} USDC @ $${bestSig.price.toFixed(5)}`,'TRADE');
    const result = await swap(USDC_MINT, tokenMint, usdcAmount, `BUY USDC→${bestSym}`);

    brain.position = {
      token: bestSym,
      entryPrice: bestSig.price,
      entryUSDC: size,
      size,
      entryTime: Date.now(),
      signal: bestSig.sigs,
      sig: result.sig,
      tokenAmount: result.outAmount,
    };

    log(`✅ BUY confirmed · ${bestSym} @ $${bestSig.price.toFixed(5)} · $${size} in · sig: ${result.sig}`,'TRADE');
    if (!CFG.dryRun) log(`   https://solscan.io/tx/${result.sig}`,'TRADE');
    log(`Waiting for SELL signal or exit condition...`,'INFO');
  } catch(e) {
    log('BUY failed: '+e.message,'ERR');
  }

  saveBrain(brain);
}

// ── STATS DISPLAY ─────────────────────────────────────────
function showStats(brain) {
  div('PERFORMANCE SUMMARY');
  log(`GEN-${brain.generation} · ${brain.trades} completed round trips`,'BRAIN');
  log(`Win Rate: ${brain.wins}/${brain.wins+brain.losses} (${brain.wins+brain.losses>0?(brain.wins/(brain.wins+brain.losses)*100).toFixed(1):0}%)`,'BRAIN');
  log(`Total P&L: ${brain.totalPnl>=0?'+':''}$${brain.totalPnl.toFixed(4)}`,'BRAIN');
  log(`Sharpe: ${calcSharpe(brain.pnlHistory)}`,'BRAIN');
  log(`Trade Size: $${brain.currentTradeSize}`,'BRAIN');
  log(`\nToken breakdown:`,'BRAIN');
  for (const [sym,stats] of Object.entries(brain.tokenStats)) {
    if (stats.trades>0) log(`  ${sym}: ${stats.trades} trades · ${stats.wins}W · P&L $${stats.pnl.toFixed(4)}`,'BRAIN');
  }
}

// ── MAIN ──────────────────────────────────────────────────
async function main() {
  div('NEXUS TRADING BOT — STARTING');
  log(`Mode: ${CFG.dryRun?'DRY RUN (no real trades)':'🔴 LIVE TRADING'}`,'SYS');
  log(`Trade size: $${CFG.tradeUSDC} → max $${CFG.maxUSDC}`,'SYS');
  log(`Interval: ${CFG.interval}s · Stop loss: ${CFG.stopLoss}% · Daily limit: ${CFG.dailyLoss}%`,'SYS');

  const brain = loadBrain();
  let cycle = 0;

  process.on('SIGINT', () => { log('Shutting down...','SYS'); showStats(brain); saveBrain(brain); process.exit(0); });
  process.on('SIGTERM', () => { saveBrain(brain); process.exit(0); });

  while (true) {
    cycle++;
    try {
      await runCycle(brain, cycle);
    } catch(e) {
      log('Cycle error: '+e.message,'ERR');
    }
    await new Promise(r => setTimeout(r, CFG.interval * 1000));
  }
}

main().catch(e => { log('Fatal: '+e.message,'ERR'); process.exit(1); });
