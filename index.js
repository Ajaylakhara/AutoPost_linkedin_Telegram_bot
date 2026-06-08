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
 *
 * FIX LOG:
 *  - Bot froze with no reply when scraper hung → Added 22s hard timeout.
 *  - Bot replied to its own messages creating loops → Added is_bot guard.
 *  - Added process crash guards (unhandledRejection, uncaughtException).
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

// ── Crash Guards (prevent the process from dying silently) ─────────────────────
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err.message);
  // Don't exit — keep the bot alive
});

// Telegram Bot Configuration
const BOT_TOKEN = process.env.BOT_TOKEN;
const isProduction = !!process.env.RENDER_EXTERNAL_URL;
let bot;

if (!BOT_TOKEN) {
  console.error('\n❌ ERROR: Telegram BOT_TOKEN is missing!');
  console.error('Please configure your .env file with BOT_TOKEN=...\n');
  process.exit(1);
}

if (isProduction) {
  bot = new TelegramBot(BOT_TOKEN, { polling: false });
  const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/telegram-webhook`;
  bot.setWebHook(webhookUrl)
    .then(() => console.log(`📡 Webhook set successfully to ${webhookUrl}`))
    .catch(err => console.error('❌ Webhook setup failed:', err.message));
} else {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  console.log('🤖 Bot started in POLLING mode (Local Development)...');
}

// HTTP Server Endpoints
app.get('/', (req, res) => {
  res.send('Bot running ✅');
});

app.post('/telegram-webhook', (req, res) => {
  try {
    bot.processUpdate(req.body);
  } catch (err) {
    console.error('❌ Webhook update processing error:', err.message);
  }
  res.sendStatus(200);
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`📡 Express server listening on port ${PORT}`);
});

// Telegram Command Helpers
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '👋 Welcome! Send me product deals, and I will format and post them to Telegram.');
});

bot.onText(/\/test/, (msg) => {
  bot.sendMessage(msg.chat.id, `⚙️ Bot is operational.\nMode: ${isProduction ? 'Webhook (Render)' : 'Polling (Local)'}`);
});

// ── Scrape with Hard Timeout ──────────────────────────────────────────────────
// If scraping takes more than 22 seconds, return safe defaults so the bot
// ALWAYS posts the deal card (without image/UPC) instead of going silent.
const SCRAPE_TIMEOUT_MS = 22000;

async function scrapeWithTimeout(url) {
  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => {
      console.log(`   ⏱️ Scrape timeout reached for: ${url}`);
      resolve({ title: 'Product', imageUrl: '', upc: 'Not Found' });
    }, SCRAPE_TIMEOUT_MS)
  );

  return Promise.race([
    scrapeProductData(url),
    timeoutPromise
  ]);
}

// ── Utility: Format unit numbers with comma separators ──────────────────────
// Parsing strips commas ("2,124" → "2124") for clean numeric handling.
// This re-adds them for display so the output reads "2,124" not "2124".
function formatUnits(units) {
  if (!units || units === 'N/A') return units;
  const num = parseInt(units.toString().replace(/,/g, ''), 10);
  if (isNaN(num)) return units;
  return num.toLocaleString('en-US');
}

// ── Main Message Listener ─────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  try {
    // Skip bot messages (including our own replies) — prevents infinite loops
    if (msg.from && msg.from.is_bot) {
      return;
    }

    // Skip service/system messages (join, leave, pin, etc.)
    if (!msg.text && !msg.caption) {
      return;
    }

    const rawText = msg.text || msg.caption || '';

    // Ignore slash commands and very short messages
    if (rawText.trim().startsWith('/') || rawText.trim().length < 5) {
      return;
    }

    console.log(`\n📬 [Message Received] Chat: ${msg.chat.id} | From: ${msg.from?.username || msg.from?.first_name}`);

    // 1. Parse products from message text
    const products = parseMessage(rawText);
    if (!products || products.length === 0) {
      console.log('⚠️ No product links found in message.');
      try {
        await bot.sendMessage(
          msg.chat.id,
          '⚠️ No product links found. Please include an Amazon or Walmart URL.',
          { reply_to_message_id: msg.message_id }
        );
      } catch (tgErr) {
        console.error('❌ Failed to send no-links warning:', tgErr.message);
      }
      return;
    }

    console.log(`🔎 Found ${products.length} product(s) in message.`);

    // 2. Process each product link
    for (const product of products) {
      console.log(`   Processing Link: ${product.link}`);
      console.log(`   Parsed → Price: ${product.price} | Units: ${product.units} | FOB: ${product.fob}`);

      // Scrape with hard timeout — bot will ALWAYS respond
      console.log('   Scraping details (max 22s)...');
      const scraped = await scrapeWithTimeout(product.link);
      console.log(`   Scraped → Title: "${scraped.title.substring(0, 40)}" | UPC: ${scraped.upc} | Image: ${scraped.imageUrl ? 'YES' : 'NO'}`);

      // Format the deal card message (units displayed with comma formatting)
      const formattedTelegramPost =
        `UPC: ${scraped.upc}\n` +
        `Price: ${product.price}\n` +
        `Units: ${formatUnits(product.units)}\n` +
        `FOB: ${product.fob}\n` +
        `Exp: ${product.exp}\n` +
        `Link: ${product.link}`;

      const telegramOptions = {
        reply_to_message_id: msg.message_id
      };

      // 3. Send to Telegram — try with image first, fallback to text
      console.log('   Sending to Telegram...');
      try {
        if (scraped.imageUrl) {
          await bot.sendPhoto(msg.chat.id, scraped.imageUrl, {
            caption: formattedTelegramPost,
            ...telegramOptions
          });
          console.log('   ✅ Sent with photo.');
        } else {
          await bot.sendMessage(msg.chat.id, formattedTelegramPost, telegramOptions);
          console.log('   ✅ Sent as text (no image).');
        }
      } catch (tgErr) {
        console.error('   ❌ Photo send failed:', tgErr.message, '— falling back to text');
        try {
          await bot.sendMessage(msg.chat.id, formattedTelegramPost, telegramOptions);
          console.log('   ✅ Fallback text sent.');
        } catch (fbErr) {
          console.error('   ❌ Text fallback also failed:', fbErr.message);
        }
      }
    }

  } catch (err) {
    console.error('❌ Error handling message:', err.message);
    try {
      await bot.sendMessage(
        msg.chat.id,
        `❌ Error processing your message: ${err.message}`,
        { reply_to_message_id: msg.message_id }
      );
    } catch (tgErr) {
      console.error('❌ Failed to send error message:', tgErr.message);
    }
  }
});

// ── Keep-alive self-pinging (prevents Render free tier from sleeping) ──────────
if (isProduction && process.env.RENDER_EXTERNAL_URL) {
  const pingUrl = process.env.RENDER_EXTERNAL_URL;
  console.log(`⏱️ Keep-alive ping active → ${pingUrl} (every 10 min)`);
  setInterval(() => {
    https.get(pingUrl, (res) => {
      console.log(`Keep-alive ping: ${res.statusCode}`);
    }).on('error', (err) => {
      console.error('Keep-alive ping error:', err.message);
    });
  }, 600000); // 10 minutes
}
