/**
 * NeuroTrade Engine v2.0
 * ══════════════════════════════════════════════════════════════
 * Single file. No imports from other files.
 * Run:   node src/engine.js
 * Paper: LIVE_MODE=false node src/engine.js
 * Live:  LIVE_MODE=true  node src/engine.js
 * ══════════════════════════════════════════════════════════════
 */

// ── Load .env ─────────────────────────────────────────────────
import axios from 'axios';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
try { require('dotenv').config(); } catch {}

import { createServer }                            from 'http';
import { WebSocketServer }                         from 'ws';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import WebSocket                                   from 'ws';
import { Connection, Keypair, PublicKey }          from '@solana/web3.js';
import bs58                                        from 'bs58';
import nacl                                        from 'tweetnacl';
// decodeUTF8 not needed in single-file mode

/* ════════════════════════════════════════════════════════════
   1. LOGGER
════════════════════════════════════════════════════════════ */
function makeLogger(ns) {
  const ts = () => new Date().toISOString().slice(11, 23);
  return {
    info:  (...a) => console.log( `\x1b[90m[${ts()}]\x1b[0m \x1b[36m[${ns}]\x1b[0m`, ...a),
    warn:  (...a) => console.warn(`\x1b[90m[${ts()}]\x1b[0m \x1b[33m[${ns}]\x1b[0m`, ...a),
    error: (...a) => console.error(`\x1b[90m[${ts()}]\x1b[0m \x1b[31m[${ns}]\x1b[0m`, ...a),
  };
}

/* ════════════════════════════════════════════════════════════
   2. BINANCE FEED — live prices every 100ms, no API key needed
════════════════════════════════════════════════════════════ */
function createBinanceFeed(pairs) {
  const log       = makeLogger('BINANCE');
  const listeners = {};
  let   retries   = 0;

  function emit(event, data) { (listeners[event] || []).forEach(fn => fn(data)); }

  function connect() {
    const streams = pairs.map(p => `${p.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${streams}`);

    ws.on('open', () => {
      log.info(`Connected — ${pairs.length} pairs streaming`);
      retries = 0;
    });
    ws.on('message', (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (!d.s) return;
        emit('tick', {
          symbol:    d.s,
          price:     parseFloat(d.c),
          change24h: parseFloat(d.P),
          volume24h: parseFloat(d.v),
          high24h:   parseFloat(d.h),
          low24h:    parseFloat(d.l),
          ts:        Date.now(),
        });
      } catch {}
    });
    ws.on('close', () => {
      log.warn(`Disconnected — reconnecting in ${Math.min(++retries * 2, 30)}s...`);
      setTimeout(connect, Math.min(retries * 2000, 30000));
    });
    ws.on('error', (e) => log.error('Error:', e.message));
  }

  return {
    connect,
    on: (event, fn) => { listeners[event] = [...(listeners[event] || []), fn]; },
  };
}

/* ════════════════════════════════════════════════════════════
   3. JUPITER FEED — Solana token prices every 2s, free
════════════════════════════════════════════════════════════ */
function createJupiterFeed(tokens) {
  const log       = makeLogger('JUPITER');
  const listeners = {};

  function emit(event, data) { (listeners[event] || []).forEach(fn => fn(data)); }

  async function poll() {
    try {
      const { data: json } = await axios.get(`https://price.jup.ag/v6/price?ids=${tokens.join(',')}`);
      Object.entries(json.data || {}).forEach(([symbol, data]) => {
        if (data.price && data.price > 0) {
          emit('tick', { symbol, price: data.price, change24h: data.priceChange24h || 0, ts: Date.now() });
        }
      });
    } catch (e) { log.warn('Poll failed:', e.message); }
  }

  function start() {
    poll();
    setInterval(poll, 2000);
    log.info(`Polling ${tokens.length} tokens every 2s`);
  }

  return {
    start,
    on: (event, fn) => { listeners[event] = [...(listeners[event] || []), fn]; },
  };
}

/* ════════════════════════════════════════════════════════════
   4. WALLET MANAGER
════════════════════════════════════════════════════════════ */
async function createWallet() {
  const log = makeLogger('WALLET');

  const state = {
    connected:     false,
    address:       null,
    solBalance:    0,
    usdcBalance:   0,
    keypair:       null,
    connection:    new Connection(
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    ),
    dappKeypair:   null,
    sharedSecret:  null,
    session:       null,
    phantomPubKey: null,
  };

  // Try private key from .env
  const pk = process.env.SOLANA_PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY;
  if (pk && pk !== 'paste_your_private_key_here' && pk.length > 10) {
    try {
      const secretKey = pk.trim().startsWith('[')
        ? Uint8Array.from(JSON.parse(pk))
        : bs58.decode(pk.trim());
      state.keypair   = Keypair.fromSecretKey(secretKey);
      state.address   = state.keypair.publicKey.toBase58();
      state.connected = true;
      log.info(`Private key connected: ${state.address.slice(0,4)}...${state.address.slice(-4)}`);
    } catch (err) {
      log.error('Bad private key:', err.message);
    }
  }

  // Try restoring saved Phantom session
  if (!state.connected) {
    try {
      if (existsSync('.phantom_session.json')) {
        const d              = JSON.parse(readFileSync('.phantom_session.json', 'utf8'));
        const sk             = bs58.decode(d.dappSK);
        const phantomPk      = bs58.decode(d.phantomPubKey);
        state.dappKeypair    = nacl.box.keyPair.fromSecretKey(sk);
        state.phantomPubKey  = phantomPk;
        state.sharedSecret   = nacl.box.before(phantomPk, sk);
        state.session        = d.session;
        state.address        = d.address;
        state.connected      = true;
        log.info(`Phantom session restored: ${state.address.slice(0,4)}...${state.address.slice(-4)}`);
      }
    } catch {}
  }

  // Simulation fallback
  if (!state.connected) {
    log.warn('═══════════════════════════════════════════');
    log.warn('SIMULATION MODE — no wallet connected');
    log.warn('Set SOLANA_PRIVATE_KEY=<key> in .env to go live');
    log.warn('═══════════════════════════════════════════');
    state.address     = 'SIMULATION';
    state.usdcBalance = 3.00;
  }

  async function refreshBalances() {
    if (!state.address || state.address === 'SIMULATION') return;
    try {
      const pubkey    = new PublicKey(state.address);
      const lamports  = await state.connection.getBalance(pubkey);
      state.solBalance = +(lamports / 1e9).toFixed(6);
      state.usdcBalance = 0;
      try {
        const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
        const accs = await state.connection.getParsedTokenAccountsByOwner(pubkey, { mint: USDC });
        if (accs.value.length > 0) {
          state.usdcBalance = +(accs.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? 0).toFixed(4);
        }
      } catch {}
      log.info(`Balances — SOL: ${state.solBalance} | USDC: $${state.usdcBalance}`);
    } catch (e) { log.warn('Balance fetch failed:', e.message); }
  }

  async function sendTransaction(transaction) {
    if (!state.keypair) throw new Error('No private key — cannot sign');
    const { blockhash } = await state.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer        = state.keypair.publicKey;
    transaction.sign(state.keypair);
    const sig = await state.connection.sendRawTransaction(
      transaction.serialize(), { skipPreflight: false }
    );
    await state.connection.confirmTransaction(sig, 'confirmed');
    log.info(`TX confirmed: ${sig.slice(0,8)}...`);
    return sig;
  }

  if (state.connected && state.address !== 'SIMULATION') {
    await refreshBalances();
  }

  return {
    get connected()    { return state.connected; },
    get address()      { return state.address; },
    get solBalance()   { return state.solBalance; },
    get usdcBalance()  { return state.usdcBalance; },
    get capital()      { return state.usdcBalance > 0 ? state.usdcBalance : 3; },
    get shortAddress() {
      if (!state.address || state.address === 'SIMULATION') return 'SIMULATION';
      return `${state.address.slice(0,4)}...${state.address.slice(-4)}`;
    },
    refreshBalances,
    sendTransaction,
  };
}

/* ════════════════════════════════════════════════════════════
   5. MICRO BRAIN — learns from every trade, adapts weights
════════════════════════════════════════════════════════════ */
function createBrain(startCapital = 3) {
  const log = makeLogger('BRAIN');

  const s = {
    capital:        startCapital,
    weights:        { momentum:0.30, microArb:0.35, solanaFlow:0.20, gasAware:0.15 },
    confidence:     0,
    generation:     1,
    mutations:      0,
    synapses:       256,
    lr:             0.06,
    phase:          'SEED',
    trades:         [],
    survivalStreak: 0,
    tradeCount:     0,
    priceHistory:   {},
  };

  function updateConfidence() {
    const n = s.trades.length;
    if (!n) { s.confidence = 0; return; }
    const wr  = s.trades.filter(t => t.pnl > 0).length / n;
    const rWr = s.trades.slice(0, 20).filter(t => t.pnl > 0).length / Math.min(20, n);
    s.confidence = Math.min(99, +((Math.max(0,(wr-0.38)/0.42)*35) + Math.min(n/300,1)*25 + rWr*20 + Math.min(s.generation/10,1)*10 + Math.min(s.survivalStreak/15,1)*10).toFixed(1));
  }

  function updatePhase() {
    const c = s.capital;
    s.phase = c>=50000?'EMPIRE':c>=5000?'FOREST':c>=500?'TREE':c>=50?'SAPLING':c>=10?'SPROUT':'SEED';
  }

  function save() {
    try {
      writeFileSync('.brain_state.json', JSON.stringify({
        capital:s.capital, weights:s.weights, confidence:s.confidence,
        generation:s.generation, mutations:s.mutations, synapses:s.synapses,
        lr:s.lr, phase:s.phase, trades:s.trades.slice(0,200),
        survivalStreak:s.survivalStreak, tradeCount:s.tradeCount,
      }));
    } catch {}
  }

  // Load previous brain state
  try {
    if (existsSync('.brain_state.json')) {
      const saved = JSON.parse(readFileSync('.brain_state.json', 'utf8'));
      Object.assign(s, saved);
      s.priceHistory = {};
      updatePhase(); updateConfidence();
      log.info(`Restored — Gen ${s.generation} | Conf ${s.confidence}% | ${s.tradeCount} trades`);
    }
  } catch { log.warn('Starting fresh brain'); }

  function onPriceUpdate(symbol, price) {
    if (!price || price <= 0) return; // guard zero/null prices
    if (!s.priceHistory[symbol]) s.priceHistory[symbol] = [];
    s.priceHistory[symbol].push(price);
    if (s.priceHistory[symbol].length > 100) s.priceHistory[symbol].shift();
  }

  function generateSignals(prices) {
    const sig = { momentum:0, microArb:0, solanaFlow:0, gasAware:0.3 };
    Object.values(s.priceHistory).forEach(hist => {
      if (hist.length >= 5) {
        const r = hist.slice(-5);
        sig.momentum += Math.max(-1, Math.min(1, (r[4]-r[0])/r[0]*10));
      }
    });
    if (prices.SOL && s.priceHistory.SOL?.length > 2) {
      const h = s.priceHistory.SOL;
      sig.microArb = Math.max(-0.5, Math.min(0.5, (prices.SOL.price - h[h.length-2]) / h[h.length-2] * 100));
    }
    sig.solanaFlow = (Math.random() - 0.48) * 2;
    return sig;
  }

  function score(signals) {
    return Object.entries(s.weights).reduce((a,[k,w]) => a + w*(signals[k]||0), 0);
  }

  function learn(result, signals) {
    const { pnl, won } = result;
    s.capital = Math.max(0, s.capital + pnl);
    s.tradeCount++;
    s.trades.unshift({ pnl, won, ts: Date.now() });
    if (s.trades.length > 500) s.trades.pop();
    const r = won ? 1 : -0.8;
    for (const k of Object.keys(s.weights)) {
      s.weights[k] = Math.max(0.05, Math.min(0.55, s.weights[k] + r*(signals[k]||0)*s.lr));
    }
    const tot = Object.values(s.weights).reduce((a,b)=>a+b,0);
    for (const k of Object.keys(s.weights)) s.weights[k] = +(s.weights[k]/tot).toFixed(4);
    if (won) s.survivalStreak++; else s.survivalStreak = 0;
    if (s.tradeCount % 8 === 0) {
      s.synapses += Math.floor(2+Math.random()*5); s.mutations++;
      if (s.mutations%15===0) { s.generation++; s.lr=Math.max(0.008,s.lr*0.95); log.info(`Gen ${s.generation} | LR: ${s.lr.toFixed(4)}`); }
    }
    updateConfidence(); updatePhase(); save();
  }

  function snapshot() {
    return {
      capital:s.capital, confidence:s.confidence, phase:s.phase,
      generation:s.generation, mutations:s.mutations, synapses:s.synapses,
      lr:s.lr, tradeCount:s.tradeCount,
      winRatePct: s.trades.length ? +(s.trades.filter(t=>t.pnl>0).length/s.trades.length*100).toFixed(1) : 50,
      survivalStreak:s.survivalStreak, weights:{...s.weights},
    };
  }

  return {
    get capital()    { return s.capital; },
    get confidence() { return s.confidence; },
    get phase()      { return s.phase; },
    get tradeCount() { return s.tradeCount; },
    onPriceUpdate, generateSignals, score, learn, snapshot,
  };
}

/* ════════════════════════════════════════════════════════════
   6. RISK ENGINE — Kelly sizing, drawdown limits, kill-switch
════════════════════════════════════════════════════════════ */
function createRisk(brain) {
  const log = makeLogger('RISK');
  let peakCapital = brain.capital;
  let dailyStart  = brain.capital;
  let killed      = false;
  let killReason  = null;
  const DAILY_DD  = parseFloat(process.env.DAILY_LOSS_PCT  || '3');
  const TOTAL_DD  = parseFloat(process.env.STOP_LOSS_PCT   || '10');

  setInterval(() => { dailyStart = brain.capital; log.info('Daily counter reset'); }, 24*3600000);

  function maxTradeSize() {
    const c = brain.capital;
    return c * (c>=500?0.06:c>=50?0.04:c>=10?0.03:0.02);
  }

  function kellySize(winRate, confidence) {
    const b    = 0.004/0.002;
    const full = Math.max(0, (winRate*b-(1-winRate))/b);
    const safe = full * 0.10 * (confidence/100);
    const maxP = brain.capital>=500?0.06:brain.capital>=50?0.04:brain.capital>=10?0.03:0.02;
    return Math.max(0.001, brain.capital * Math.min(safe, maxP));
  }

  function assess() {
    if (killed) return { killSwitch:true, killReason };
    const cap   = brain.capital;
    const ddDay = Math.max(0, (dailyStart-cap)/Math.max(dailyStart,0.001)*100);
    const ddTot = Math.max(0, (peakCapital-cap)/Math.max(peakCapital,0.001)*100);
    if (cap > peakCapital) peakCapital = cap;
    if (ddDay >= DAILY_DD) return triggerKill(`Daily loss ${ddDay.toFixed(2)}% hit ${DAILY_DD}% limit`);
    if (ddTot >= TOTAL_DD) return triggerKill(`Total loss ${ddTot.toFixed(2)}% hit ${TOTAL_DD}% limit`);
    return { killSwitch:false, ddDay:+ddDay.toFixed(3), ddTotal:+ddTot.toFixed(3) };
  }

  function triggerKill(reason) {
    log.error('KILL SWITCH:', reason);
    killed = true; killReason = reason;
    return { killSwitch:true, killReason };
  }

  function findBestOpportunity(prices, snap) {
    const opts = [
      { symbol:'SOL',  chain:'Solana', gas:0.00025 },
      { symbol:'JUP',  chain:'Solana', gas:0.00025 },
      { symbol:'RAY',  chain:'Solana', gas:0.00025 },
      { symbol:'BONK', chain:'Solana', gas:0.00025 },
    ].filter(c => prices[c.symbol] && prices[c.symbol].price > 0);  // zero-price guard
    for (const c of opts) {
      const size = kellySize(snap.winRatePct/100||0.5, snap.confidence);
      if (size*0.004 < c.gas*3 || size < 0.001) continue;
      return { ...c, size:+size.toFixed(7), price:prices[c.symbol]?.price };
    }
    return null;
  }

  function fullMetrics() {
    const cap   = brain.capital;
    const ddDay = Math.max(0, (dailyStart-cap)/Math.max(dailyStart,0.001)*100);
    const ddTot = Math.max(0, (peakCapital-cap)/Math.max(peakCapital,0.001)*100);
    return {
      capital:+cap.toFixed(6), peakCapital:+peakCapital.toFixed(6),
      ddDay:+ddDay.toFixed(3), ddTotal:+ddTot.toFixed(3),
      ddDayLimit:DAILY_DD, ddTotalLimit:TOTAL_DD,
      maxTradeSize:+maxTradeSize().toFixed(6),
      killSwitch:killed, killReason,
    };
  }

  return { assess, findBestOpportunity, maxTradeSize, fullMetrics, triggerKill };
}

/* ════════════════════════════════════════════════════════════
   7. TRADE EXECUTOR — paper or live Jupiter swaps
════════════════════════════════════════════════════════════ */
function createExecutor(wallet, risk, brain) {
  const log = makeLogger('EXEC');

  // Smart price formatter — handles micro-price tokens like BONK
  const fmtPrice = (p) => !p ? '0' : p >= 0.01 ? p.toFixed(5) : p >= 0.000001 ? p.toFixed(8) : p.toExponential(3);

  async function execute(opp, liveMode = false) {
    const { symbol, chain, size } = opp;
    const gas = 0.00025;

    if (!opp.price || opp.price <= 0) {
      log.warn(`SKIP ${symbol} — price is ${opp.price} (invalid)`);
      return { symbol, size, pnl:0, won:false, status:'SKIPPED', ts:Date.now() };
    }

    if (size*0.004 < gas*3) {
      log.warn(`SKIP ${symbol} — too small for gas`);
      return { symbol, size, pnl:0, won:false, status:'SKIPPED', ts:Date.now() };
    }

    // Paper trade
    if (!liveMode || wallet.address === 'SIMULATION') {
      const won = Math.random() < (0.40 + brain.confidence*0.004);
      const pnl = won
        ? +(size*(Math.random()*0.006+0.002)-gas).toFixed(7)
        : -(size*(Math.random()*0.003+0.001)+gas).toFixed(7);
      log.info(`PAPER ${symbol} @ $${fmtPrice(opp.price)} ${won?'WIN ✓':'LOSS ✗'} ${pnl>=0?'+':''}$${pnl.toFixed(7)}`);
      return { symbol, chain, size, pnl, won, gas, mode:'PAPER', status:'FILLED', ts:Date.now() };
    }

    // Live swap via Jupiter
    try {
      const USDC  = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      const MINTS = {
        SOL:  'So11111111111111111111111111111111111111112',
        JUP:  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
        RAY:  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
        BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      };
      const amount    = Math.floor(size*1e6);
      const { data: quote } = await axios.get(`https://api.jup.ag/swap/v1/quote?inputMint=${USDC}&outputMint=${MINTS[symbol]||MINTS.SOL}&amount=${amount}&slippageBps=300`);
      if (quote.error) throw new Error(quote.error);
      const { data: { swapTransaction } } = await axios.post('https://api.jup.ag/swap/v1/swap', {
        quoteResponse:quote, userPublicKey:wallet.address, wrapAndUnwrapSol:true,
      });
      const { VersionedTransaction } = await import('@solana/web3.js');
      const tx  = VersionedTransaction.deserialize(Buffer.from(swapTransaction,'base64'));
      const sig = await wallet.sendTransaction(tx);
      log.info(`LIVE ${symbol} @ $${fmtPrice(opp.price)} | sig: ${sig.slice(0,8)}...`);
      log.info(`   https://solscan.io/tx/${sig}`);
      return { symbol, chain:'Solana', size, pnl:-gas, won:true, gas, mode:'LIVE', status:'FILLED', txSignature:sig, ts:Date.now() };
    } catch (err) {
      log.error(`LIVE failed: ${err.message}`);
      return { symbol, size, pnl:-gas, won:false, mode:'LIVE', status:'FAILED', error:err.message, ts:Date.now() };
    }
  }

  return { execute };
}

/* ════════════════════════════════════════════════════════════
   8. MAIN — boot everything and run
════════════════════════════════════════════════════════════ */
const log       = makeLogger('ENGINE');
const PRICES    = {};
const wsClients = new Set();
let   tickLoop  = null;

function broadcast(msg) {
  const p = JSON.stringify(msg);
  wsClients.forEach(ws => { if (ws.readyState === 1) ws.send(p); });
}

// Smart price formatter for display
const fmtP = (p) => !p ? '0' : p >= 0.01 ? p.toFixed(5) : p >= 0.000001 ? p.toFixed(8) : p.toExponential(3);
const div  = (s) => log.info(`══ ${s} ══`);

async function main() {
  div('NeuroTrade v2.0');

  // ── Wallet ──────────────────────────────────────────────
  const wallet = await createWallet();
  log.info(`Wallet: ${wallet.shortAddress} | SOL: ${wallet.solBalance} | USDC: $${wallet.usdcBalance}`);

  // ── Brain ───────────────────────────────────────────────
  const brain = createBrain(wallet.capital);
  log.info(`Brain: ${brain.phase} | Conf: ${brain.confidence}% | Trades: ${brain.tradeCount}`);

  // ── Risk ────────────────────────────────────────────────
  const risk = createRisk(brain);

  // ── Executor ────────────────────────────────────────────
  const executor = createExecutor(wallet, risk, brain);

  // ── Binance WebSocket feed ───────────────────────────────
  const binance = createBinanceFeed(['SOLUSDT', 'JUPUSDT', 'RAYUSDT', 'BONKUSDT']);
  binance.on('tick', (tick) => {
    const sym = tick.symbol.replace('USDT', '');
    if (tick.price && tick.price > 0) {
      PRICES[sym] = tick;
      brain.onPriceUpdate(sym, tick.price);
    }
  });
  binance.connect();

  // ── Jupiter feed (backup / cross-check) ─────────────────
  const jupiter = createJupiterFeed(['SOL', 'JUP', 'RAY', 'BONK']);
  jupiter.on('tick', (tick) => {
    // Fill any gaps from Binance
    if (!PRICES[tick.symbol] || !PRICES[tick.symbol].price) {
      PRICES[tick.symbol] = tick;
      brain.onPriceUpdate(tick.symbol, tick.price);
    }
  });
  jupiter.start();

  // ── WebSocket dashboard server ───────────────────────────
  const WS_PORT  = parseInt(process.env.WS_PORT || '8080');
  const httpSrv  = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status:'ok', engine:'NeuroTrade v2.0', ...brain.snapshot(), risk: risk.fullMetrics() }));
  });
  const wss = new WebSocketServer({ server: httpSrv });
  wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.send(JSON.stringify({ type:'connected', ...brain.snapshot(), risk: risk.fullMetrics(), prices: PRICES }));
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
  });
  httpSrv.listen(WS_PORT, () => log.info(`Dashboard WS on port ${WS_PORT}`));

  // ── Trade config ─────────────────────────────────────────
  const LIVE_MODE   = process.env.LIVE_MODE === 'true' || process.env.DRY_RUN === 'false';
  const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || '30000');
  let   cycleCount  = 0;

  div(`Mode: ${LIVE_MODE ? '🔴 LIVE' : '📄 PAPER'} | Interval: ${INTERVAL_MS/1000}s`);

  // ── Trading cycle ─────────────────────────────────────────
  async function cycle() {
    cycleCount++;
    const snap = brain.snapshot();

    div(`CYCLE ${cycleCount} · GEN-${snap.generation} · ${snap.tradeCount} trades · Capital: $${snap.capital.toFixed(4)}`);

    // Shield check
    const riskState = risk.assess();
    if (riskState.killSwitch) {
      log.error(`🛡 KILL SWITCH — ${riskState.killReason}`);
      broadcast({ type:'kill', reason: riskState.killReason, ...snap });
      clearInterval(tickLoop);
      return;
    }
    log.info(`Shield: DD ${riskState.ddDay}%/day · ${riskState.ddTotal}%/total`);

    // Wait for prices
    const validPrices = Object.fromEntries(
      Object.entries(PRICES).filter(([,d]) => d.price && d.price > 0)
    );
    if (!Object.keys(validPrices).length) {
      log.warn('No valid prices yet — waiting for feeds...');
      broadcast({ type:'tick', cycle: cycleCount, ...snap });
      return;
    }

    // Log current prices
    Object.entries(validPrices).forEach(([sym, d]) =>
      log.info(`  ${sym.padEnd(4)} $${fmtP(d.price)}${d.change24h ? ` (${d.change24h>=0?'+':''}${d.change24h?.toFixed(2)}% 24h)` : ''}`)
    );

    // Generate signals
    const signals = brain.generateSignals(validPrices);
    const s = brain.score(signals);
    log.info(`Signals: momentum=${signals.momentum.toFixed(3)} microArb=${signals.microArb.toFixed(3)} score=${s.toFixed(4)}`);

    // Find best opportunity
    const opp = risk.findBestOpportunity(validPrices, snap);
    if (!opp) {
      log.info(`No qualifying opportunity (score=${s.toFixed(4)})`);
      broadcast({ type:'tick', cycle: cycleCount, prices: validPrices, signals, ...snap, riskMetrics: risk.fullMetrics() });
      return;
    }

    log.info(`Opportunity: ${opp.symbol} @ $${fmtP(opp.price)} · size: $${opp.size}`);

    // Execute
    const result = await executor.execute(opp, LIVE_MODE);
    if (result.status !== 'SKIPPED') {
      brain.learn(result, signals);
      await wallet.refreshBalances();
    }

    const newSnap = brain.snapshot();
    broadcast({ type:'trade', cycle: cycleCount, result, prices: validPrices, ...newSnap, riskMetrics: risk.fullMetrics() });

    const pnlStr = result.pnl != null ? `${result.pnl>=0?'+ ':'-'}$${Math.abs(result.pnl).toFixed(7)}` : 'N/A';
    log.info(`Result: ${result.won ? '✅ WIN' : result.status === 'SKIPPED' ? '⏭ SKIP' : '❌ LOSS'} ${pnlStr} | Capital: $${newSnap.capital.toFixed(4)}`);
  }

  // Run first cycle immediately, then on interval
  await cycle();
  tickLoop = setInterval(cycle, INTERVAL_MS);
}

main().catch(e => {
  log.error('Fatal:', e.message);
  process.exit(1);
});
