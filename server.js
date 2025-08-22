const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');
const ti = require('technicalindicators');

const app = express();
const PORT = process.env.PORT || 3000;

// ==== CONFIG (tune for more/less frequent signals) ====
const SYMBOLS = ["EUR/USD", "GBP/USD", "USD/JPY"]; // Twelve Data symbol format
const INTERVAL = "1min";           // 1min or 5min typical for binary signals
const SCAN_EVERY_MS = 30_000;      // scan every 30s
const MIN_CANDLES = 60;            // enough history for indicators
const EXPIRY_HINT_MINUTES = 1;     // suggest 1–5m expiry
// Strategy thresholds
const RSI_LOW = 35;                // CALL filter
const RSI_HIGH = 65;               // PUT filter
const BB_WIDTH_MIN = 0.002;        // filter ultra-tight ranges

// ==== ENV ====
const BOT_TOKEN = process.env.BOT_TOKEN;          // from @BotFather
const TWELVE_DATA_KEY = process.env.TWELVE_DATA_KEY; // from Twelve Data

if (!BOT_TOKEN) { console.error("❌ Missing BOT_TOKEN"); process.exit(1); }
if (!TWELVE_DATA_KEY) { console.error("❌ Missing TWELVE_DATA_KEY"); process.exit(1); }

// Telegram bot (polling is perfect for Railway/Render)
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Simple in-memory subscriber list (resets on deploy)
const subscribers = new Set();

// ==== Commands ====
bot.onText(/^\/status$/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    📊 Symbols: ${SYMBOLS.join(", ")}\n +
    ⏱️ Interval: ${INTERVAL}\n +
    🔁 Scan: ${SCAN_EVERY_MS/1000}s\n +
    ⚙️ Strategy: EMA(9/21) cross + RSI(14) + Bollinger filter
  );
});

bot.onText(/^\/subscribe$/, (msg) => {
  subscribers.add(msg.chat.id);
  bot.sendMessage(msg.chat.id, "✅ Subscribed. You’ll receive signals when they trigger.");
});

bot.onText(/^\/unsubscribe$/, (msg) => {
  subscribers.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, "🚫 Unsubscribed.");
});

bot.onText(/^\/status$/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `📊 Symbols: ${SYMBOLS.join(", ")}
⏱️ Interval: ${INTERVAL}
🔁 Scan: ${SCAN_EVERY_MS / 1000}s
⚙️ Strategy: EMA(9/21) cross + RSI(14) + Bollinger filter`
  );
});

// === Candle download ===
async function fetchCandles(symbol, interval, limit) {
  const url = "https://api.twelvedata.com/time_series";
  const params = { symbol, interval, outputsize: limit, apikey: TWELVE_DATA_KEY };
  const { data } = await axios.get(url, { params });

  if (!data  !data.values  !Array.isArray(data.values)) {
    throw new Error("No data");
  }

  // Twelve Data returns newest first; reverse to oldest->newest
  const sorted = data.values.slice().reverse();
  const close = sorted.map(c => parseFloat(c.close));
  const high = sorted.map(c => parseFloat(c.high));
  const low = sorted.map(c => parseFloat(c.low));
  const time = sorted.map(c => c.datetime);
  return { close, high, low, time };
}

// === Strategy ===
function getSignal({ close, high, low, time }) {
  if (close.length < MIN_CANDLES) return null;

  const ema9 = ti.EMA.calculate({ period: 9, values: close });
  const ema21 = ti.EMA.calculate({ period: 21, values: close });
  const rsi14 = ti.RSI.calculate({ period: 14, values: close });
  const bb = ti.BollingerBands.calculate({ period: 20, stdDev: 2, values: close });

  // align to the latest candle
  const e9_now = ema9[ema9.length - 1];
  const e21_now = ema21[ema21.length - 1];
  const rsi_now = rsi14[rsi14.length - 1];
  const bb_now = bb[bb.length - 1];

  if (e9_now == null  e21_now == null  rsi_now == null || !bb_now) return null;

  // Bollinger width filter
  const c = close[close.length - 1];
  const bbWidth = (bb_now.upper - bb_now.lower) / c;
  if (bbWidth < BB_WIDTH_MIN) return null;

  // Fresh cross (compare with previous candle)
  const e9_prev = ema9[ema9.length - 2];
  const e21_prev = ema21[ema21.length - 2];
  let side = null;

  if (e9_prev < e21_prev && e9_now > e21_now && rsi_now <= RSI_HIGH) {
    side = "CALL";
  }

