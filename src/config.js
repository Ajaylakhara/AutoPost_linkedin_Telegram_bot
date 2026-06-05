/**
 * Configuration module.
 * Stores bot tokens and database file paths.
 */

const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const placeholder = 'YOUR_TELEGRAM_BOT_TOKEN_HERE';

if (!BOT_TOKEN || BOT_TOKEN.trim() === '' || BOT_TOKEN === placeholder) {
  console.error('\n❌ ERROR: Telegram BOT_TOKEN is missing or invalid!');
  console.error('   Please create a `.env` file in the root directory and set BOT_TOKEN.');
  console.error('   Example:');
  console.error('   BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ\n');
  process.exit(1);
}

module.exports = {
  // Telegram Bot API Token
  BOT_TOKEN,
  
  // JSON database file to store posted product keys for deduplication
  DEDUPE_FILE: path.join(__dirname, '../crawled_asins.json')
};
