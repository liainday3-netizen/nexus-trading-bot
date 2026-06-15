# Nexus Trading Bot 🤖

Solana AI trading bot — scans SOL, JUP, WIF, BONK every 30s using Jupiter DEX.

## Strategy
- 10 technical indicators combined into a weighted quantum score (RSI, MACD, Bollinger Bands, EMA crossover, Stochastic RSI, Momentum, VWAP, Volatility, ATR, Fear & Greed)
- One position at a time: BUY on signal confidence ≥ 62%, SELL on reversal, take profit (+1.5%), or stop loss (-2%)
- Auto-scales trade size +10% after wins (up to `MAX_TRADE_SIZE_USD`)
- Brain evolution: learns which tokens perform best and adjusts strategy each generation

## Setup

```bash
git clone https://github.com/YOUR_USERNAME/nexus-trading-bot
cd nexus-trading-bot
npm install
cp .env.example .env
# Edit .env with your wallet key and RPC URL
```

## Run

```bash
# Dry run (safe, no real trades)
npm run dev

# Live trading
DRY_RUN=false npm start
```

## Environment Variables

See `.env.example` for all options. Minimum required: `WALLET_PRIVATE_KEY`

## Hosting (Railway)

1. Push to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add environment variables in Railway dashboard
4. Done — runs 24/7

## Performance

Brain state is saved to `brain.json` after every cycle. The bot remembers:
- Trade history & P&L
- Per-token win rates
- Open positions (survives restarts)
- Evolutionary mutations

## ⚠️ Risk Warning

This bot trades real funds. Start with `DRY_RUN=true` to validate signals before going live. Never trade more than you can afford to lose.
