/**
 * 🤖 Production-Ready Telegram Product Formatter Bot (Main Entrance)
 * 
 * Flow:
 * 1. Receives raw text or photo caption messages from Telegram.
 * 2. Splits multiple product listings inside one message into individual product sub-messages.
 * 3. Parses fields for each product (link, price, units, expiry).
 * 4. Expands short URLs (e.g., a.co -> full Amazon URL) to fetch full addresses.
 * 5. Extracts unique identifiers (ASIN, eBay ID) and runs a deduplication check.
 * 6. Scrapes the destination page for the product title, image, and UPC barcode.
 * 7. Formats the final premium post layout.
 * 8. Sends the post with the scraped image (fallback to original photo, or text if none exists).
 */

const TelegramBot = require('node-telegram-bot-api');
const { BOT_TOKEN } = require('./config');
const { splitMessageIntoProducts, parseMessage } = require('./parser');
const { expandUrl, extractASIN, extractProductKey } = require('./urlHelper');
const { scrapeProductData } = require('./scraper');
const { generateUPC, generatePost } = require('./formatter');


// Warn if token is still placeholder
if (BOT_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  console.warn('\n⚠️  WARNING: You are using the default placeholder token.');
  console.warn('   Please configure the BOT_TOKEN environment variable.\n');
}

// Initialize Telegram bot in polling mode
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log('🤖 Telegram Product Formatter Bot is starting up...');
console.log('📡 Listening for incoming group/private messages...');
console.log('--------------------------------------------------');

// Handle incoming messages
bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const chatTitle = msg.chat.title || 'Private Chat';
    const username = msg.from ? (msg.from.username || msg.from.first_name) : 'Unknown User';

    // Extract text body or photo caption
    const rawText = msg.text || msg.caption || '';
    
    // Ignore small messages silently
    if (rawText.trim().length < 10) {
      return;
    }

    // 1. Split message into individual product sub-messages
    const productTexts = splitMessageIntoProducts(rawText);
    if (!productTexts || productTexts.length === 0) {
      return;
    }

    console.log(`\n📦 [Deal Message Detected] Received from ${username} in "${chatTitle}". Total products detected: ${productTexts.length}`);

    // Loop through each product found in the message
    for (const productText of productTexts) {
      // 2. Parse basic message fields
      const parsedData = parseMessage(productText);
      if (!parsedData) {
        continue;
      }

      console.log(`   Processing Link: ${parsedData.link}`);

      // 3. Expand short links to get the final landing page
      console.log('   Expanding URL...');
      const expandedLink = await expandUrl(parsedData.link);
      console.log(`   Expanded URL: ${expandedLink}`);




      // Extract ASIN log for Amazon urls
      const asin = extractASIN(expandedLink);
      if (asin) {
        console.log(`   ASIN Extracted: ${asin}`);
      }

      // 5. Scrape Product Details (Title & Image)
      console.log('   Scraping product metadata...');
      const scrapedData = await scrapeProductData(expandedLink);
      
      let productTitle = 'Premium Product';
      let scrapedImageUrl = null;

      if (scrapedData) {
        productTitle = scrapedData.title;
        scrapedImageUrl = scrapedData.imageUrl;
        console.log(`   Title Scraped: "${productTitle}"`);
        if (scrapedImageUrl) {
          console.log(`   Image Scraped: ${scrapedImageUrl}`);
        } else if (scrapedData.isBlocked) {
          console.log('   Scraper blocked by Amazon CAPTCHA.');
        } else {
          console.log('   No product image found in scraped page.');
        }
      }

      // 6. Determine UPC: use real UPC scraped from product page, or generate fallback
      const upc = scrapedData ? scrapedData.upc : null;
      let productId;
      if (upc) {
        productId = upc;
        console.log(`🆔 Using real product UPC: ${productId}`);
      } else {
        productId = generateUPC();
        console.log(`🆔 Real UPC not found — generated fallback: ${productId}`);
      }

      // 7. Format premium post (uses original short link from parsedData.link)
      const formattedPost = generatePost(productId, parsedData, scrapedImageUrl);

      // 8. Photo Sending Logic with fallbacks
      let photoToSend = null;

      if (msg.photo && msg.photo.length > 0) {
        console.log('📸 Photo attached to incoming message. Using Telegram file ID...');
        photoToSend = msg.photo[msg.photo.length - 1].file_id;
      } else if (scrapedImageUrl) {
        console.log('🔗 Scraped image URL found. Passing image to Telegram...');
        photoToSend = scrapedImageUrl;
      }

      if (photoToSend) {
        await bot.sendPhoto(chatId, photoToSend, {
          caption: formattedPost,
          reply_to_message_id: msg.message_id
        });
        console.log(`✅ Formatted image post sent to chat ID: ${chatId}`);
      } else {
        await bot.sendMessage(chatId, formattedPost, {
          reply_to_message_id: msg.message_id
        });
        console.log(`✅ Formatted text post sent to chat ID: ${chatId}`);
      }
    }

  } catch (error) {
    console.error('❌ Error processing message:', error.message);
  }
});

// Polling Error handling
bot.on('polling_error', (error) => {
  console.error('\n⚠️  Polling Error occurred:');
  console.error(`Error Code: ${error.code}`);
  console.error(`Message:    ${error.message}`);
  
  if (error.message && error.message.includes('401 Unauthorized')) {
    console.error('\n💡 TIP: Code 401 Unauthorized means your BOT_TOKEN is invalid.');
  }
  console.error('--------------------------------------------------');
});

// Process Exception safety
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});
