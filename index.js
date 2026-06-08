/**
 * 🤖 AutoPost Telegram Bot (Main Orchestrator)
 *
 * Flow:
 * 1. Runs an Express HTTP server (health check + Telegram webhooks).
 * 2. Connects to Telegram using webhook (in production) or polling (local dev).
 * 3. Listens for incoming product deal messages.
 * 4. Parses deals using utils.js.
 * 5. Scrapes product details (title, image, UPC) using scraper.js with timeout.
 * 6. Formats deal messages.
 * 7. Automatically posts to Telegram — ALWAYS responds, even on scrape failure.
 */

require('dotenv').config();
const express = require('express');
const https = require('https');
const TelegramBot = require('node-telegram-bot-api');
const { parseMessage } = require('./utils');
const { scrapeProductData } = require('./scraper');

// Express App Initialization
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ── Crash Guards ───────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err.message);
});

// Telegram Bot Configuration
const BOT_TOKEN = process.env.BOT_TOKEN;
const isProduction = !!process.env.RENDER_EXTERNAL_URL;
let bot;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing in .env');
  process.exit(1);
}

if (isProduction) {
  bot = new TelegramBot(BOT_TOKEN, { polling: false });
  const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/telegram-webhook`;
  bot.setWebHook(webhookUrl)
    .catch(err => console.error('❌ Webhook setup failed:', err.message));
} else {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
}

// HTTP Server Endpoints
app.get('/', (req, res) => {
  res.send('Bot running ✅');
});

app.post('/telegram-webhook', (req, res) => {
  try {
    bot.processUpdate(req.body);
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
  res.sendStatus(200);
});

app.listen(PORT);

// Telegram Command Helpers
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '👋 Welcome! Send me product deals and I will format and post them to Telegram.');
});

bot.onText(/\/test/, (msg) => {
  bot.sendMessage(msg.chat.id, `⚙️ Bot is operational.\nMode: ${isProduction ? 'Webhook (Render)' : 'Polling (Local)'}`);
});

// ── Scrape with Hard Timeout ───────────────────────────────────────────────────
// If scraping hangs, resolve with safe defaults after 22s so bot always replies.
const SCRAPE_TIMEOUT_MS = 22000;

async function scrapeWithTimeout(url) {
  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve({ title: 'Product', imageUrl: '', upc: 'Not Found' }), SCRAPE_TIMEOUT_MS)
  );
  return Promise.race([scrapeProductData(url), timeoutPromise]);
}

// ── Format unit numbers with comma separators ──────────────────────────────────
// Parsing strips commas (2,124 → 2124). This re-adds them for display.
function formatUnits(units) {
  if (!units || units === 'N/A') return units;
  const num = parseInt(units.toString().replace(/,/g, ''), 10);
  if (isNaN(num)) return units;
  return num.toLocaleString('en-US');
}

// ── Main Message Listener ──────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  try {
    // Skip bot messages — prevents infinite loops
    if (msg.from && msg.from.is_bot) return;

    // Skip service/system messages (joins, pins, etc.)
    if (!msg.text && !msg.caption) return;

    const rawText = msg.text || msg.caption || '';

    // Ignore slash commands and very short inputs
    if (rawText.trim().startsWith('/') || rawText.trim().length < 5) return;

    // 1. Parse product links from message
    const products = parseMessage(rawText);
    if (!products || products.length === 0) {
      try {
        await bot.sendMessage(
          msg.chat.id,
          '⚠️ No product links found. Please include an Amazon or Walmart URL.',
          { reply_to_message_id: msg.message_id }
        );
      } catch (tgErr) {
        console.error('❌ Failed to send warning:', tgErr.message);
      }
      return;
    }

    // 2. Process each product link
    for (const product of products) {
      const scraped = await scrapeWithTimeout(product.link);

      const formattedTelegramPost =
        `UPC: ${scraped.upc}\n` +
        `Price: ${product.price}\n` +
        `Units: ${formatUnits(product.units)}\n` +
        `FOB: ${product.fob}\n` +
        `Exp: ${product.exp}\n` +
        `Link: ${product.link}`;

      const telegramOptions = { reply_to_message_id: msg.message_id };

      // 3. Send with image if available, fallback to text
      try {
        if (scraped.imageUrl) {
          await bot.sendPhoto(msg.chat.id, scraped.imageUrl, {
            caption: formattedTelegramPost,
            ...telegramOptions
          });
        } else {
          await bot.sendMessage(msg.chat.id, formattedTelegramPost, telegramOptions);
        }
      } catch (tgErr) {
        console.error('❌ Photo send failed:', tgErr.message);
        try {
          await bot.sendMessage(msg.chat.id, formattedTelegramPost, telegramOptions);
        } catch (fbErr) {
          console.error('❌ Text fallback failed:', fbErr.message);
        }
      }
    }

  } catch (err) {
    console.error('❌ Message handler error:', err.message);
    try {
      await bot.sendMessage(
        msg.chat.id,
        `❌ Error: ${err.message}`,
        { reply_to_message_id: msg.message_id }
      );
    } catch (tgErr) {
      console.error('❌ Failed to send error message:', tgErr.message);
    }
  }
});

// ── Keep-alive ping (prevents Render free tier from sleeping) ──────────────────
if (isProduction && process.env.RENDER_EXTERNAL_URL) {
  const pingUrl = process.env.RENDER_EXTERNAL_URL;
  setInterval(() => {
    https.get(pingUrl).on('error', (err) => {
      console.error('Keep-alive ping error:', err.message);
    });
  }, 600000); // every 10 minutes
}
