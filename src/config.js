/**
 * Configuration module.
 * Stores bot tokens and database file paths.
 */

const path = require('path');

module.exports = {
  // Telegram Bot API Token
  BOT_TOKEN: process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN_HERE',
  
  // JSON database file to store posted product keys for deduplication
  DEDUPE_FILE: path.join(__dirname, '../crawled_asins.json')
};
