/**
 * Deduplication helper module.
 * Reads and writes from/to crawled_asins.json to ensure
 * the same product isn't posted multiple times.
 */

const fs = require('fs');
const { DEDUPE_FILE } = require('./config');

/**
 * Checks if a product has already been posted in the channel.
 * If it hasn't, it adds the key to the database to prevent future duplicates.
 * 
 * @param {string} key Unique identifier for the product (e.g. Amazon ASIN, eBay ID).
 * @returns {boolean} True if the product is new (not previously posted), false if it's a duplicate.
 */
function checkAndAddProductKey(key) {
  if (!key) return false;
  
  let database = [];

  // 1. Read existing crawled keys from file
  try {
    if (fs.existsSync(DEDUPE_FILE)) {
      const fileContent = fs.readFileSync(DEDUPE_FILE, 'utf8');
      database = JSON.parse(fileContent);
    }
  } catch (e) {
    console.error('[Dedupe Error] Could not read duplicate JSON cache:', e.message);
  }

  // 2. Check if this key is already in our list
  if (database.includes(key)) {
    return false; // Already posted before
  }

  // 3. Add the new key and save back to the file
  database.push(key);

  try {
    fs.writeFileSync(DEDUPE_FILE, JSON.stringify(database, null, 2), 'utf8');
  } catch (e) {
    console.error('[Dedupe Error] Could not write duplicate JSON cache:', e.message);
  }

  return true; // New product, successfully registered
}

module.exports = {
  checkAndAddProductKey
};
