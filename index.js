/**
 * 🤖 AutoPost Telegram Bot (Main Orchestrator)
 * 
 * Flow:
 * 1. Runs an Express HTTP server (health check + Telegram webhooks).
 * 2. Connects to Telegram using webhook (in production) or polling (local development).
 * 3. Listens for incoming product deal messages.
 * 4. Parses deals using utils.js.
 * 5. Scrapes product details (title, image, UPC) using scraper.js.
 * 6. Formats deal messages.
 * 7. Automatically posts to Telegram.
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
  res.send('Bot running');
});

app.post('/telegram-webhook', (req, res) => {
  try {
    bot.processUpdate(req.body);
  } catch (err) {
    console.error('❌ Webhook update processing error:', err.message);
  }
  res.sendStatus(200);
});

// Start keep-alive Express Server
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

// Main Message Listener
bot.on('message', async (msg) => {
  try {
    // ── Skip bot messages (including our own replies) ──────────────────────
    if (msg.from && msg.from.is_bot) {
      return;
    }

    // ── Skip service messages (joins, leaves, pins, etc.) ─────────────────
    if (!msg.text && !msg.caption) {
      return;
    }

    const rawText = msg.text || msg.caption || '';

    // Ignore bot command slash-prefix and extremely short inputs
    if (rawText.trim().startsWith('/') || rawText.trim().length < 5) {
      return;
    }

    console.log(`\n📬 [Message Received] Processing deal content from user...`);

    // 1. Parse products array
    const products = parseMessage(rawText);
    if (!products || products.length === 0) {
      console.log('⚠️ No product links found in message.');
      try {
        await bot.sendMessage(msg.chat.id, '⚠️ No product links found in your message. Please include a product link (e.g. Amazon or Walmart).', {
          reply_to_message_id: msg.message_id
        });
      } catch (tgErr) {
        console.error('❌ Failed to send no-links warning to Telegram:', tgErr.message);
      }
      return;
    }

    console.log(`🔎 Found ${products.length} product(s) in message.`);

    // 2. Loop each product
    for (const product of products) {
      console.log(`   Processing Link: ${product.link}`);

      // Scrape product details
      console.log('   Scraping details...');
      const scraped = await scrapeProductData(product.link);
      console.log(`   Scraped: "${scraped.title}" (UPC: ${scraped.upc})`);

      // Telegram specific format without the redundant/empty Image line
      const formattedTelegramPost = 
        `UPC: ${scraped.upc}\n` +
        `Price: ${product.price}\n` +
        `Units: ${product.units}\n` +
        `FOB: ${product.fob}\n` +
        `Exp: ${product.exp}\n` +
        `Link: ${product.link}`;

      const telegramOptions = {
        reply_to_message_id: msg.message_id
      };

      // 3. Send to Telegram
      console.log('   Sending to Telegram...');
      try {
        if (scraped.imageUrl) {
          await bot.sendPhoto(msg.chat.id, scraped.imageUrl, {
            caption: formattedTelegramPost,
            ...telegramOptions
          });
        } else {
          await bot.sendMessage(msg.chat.id, formattedTelegramPost, telegramOptions);
        }
        console.log('   ✅ Telegram post successful.');
      } catch (tgErr) {
        console.error('   ❌ Telegram posting failed:', tgErr.message);
        // Fallback to plain text message
        try {
          await bot.sendMessage(msg.chat.id, formattedTelegramPost, telegramOptions);
          console.log('   ✅ Telegram post fallback successful.');
        } catch (fbErr) {
          console.error('   ❌ Telegram fallback failed:', fbErr.message);
        }
      }
    }

  } catch (err) {
    console.error('❌ Error handling telegram message:', err.message);
    try {
      await bot.sendMessage(msg.chat.id, `❌ Error processing your message: ${err.message}`, {
        reply_to_message_id: msg.message_id
      });
    } catch (tgErr) {
      console.error('❌ Failed to send error message to Telegram:', tgErr.message);
    }
  }
});

// Keep-alive self-pinging to prevent Render free tier from going to sleep
if (isProduction && process.env.RENDER_EXTERNAL_URL) {
  const pingUrl = process.env.RENDER_EXTERNAL_URL;
  console.log(`⏱️ Setting up keep-alive self-ping for: ${pingUrl} (every 10 minutes)`);
  setInterval(() => {
    https.get(pingUrl, (res) => {
      console.log(`Self-ping sent. Status Code: ${res.statusCode}`);
    }).on('error', (err) => {
      console.error('Self-ping error:', err.message);
    });
  }, 600000); // 10 minutes
}

