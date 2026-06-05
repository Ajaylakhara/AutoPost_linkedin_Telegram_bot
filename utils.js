/**
 * Parser Utility module for parsing product deals.
 */

const fs = require('fs');
const path = require('path');

const DEDUPE_FILE = path.join(__dirname, 'crawled_asins.json');

/**
 * Parses details from a Telegram message containing one or more product deals.
 * Extracts details per product link.
 * 
 * @param {string} text The raw Telegram message text.
 * @returns {Array<object>} An array of parsed product objects.
 */
function parseMessage(text) {
  if (!text || text.trim().length < 5) {
    return [];
  }

  // 1. Find all links using regex
  const linkRegex = /(https?:\/\/[^\s]+)/g;
  const matches = [...text.matchAll(linkRegex)];
  
  if (matches.length === 0) {
    return [];
  }

  // 2. Extract Global Fallbacks from the entire message
  // Global Price
  const priceRegex = /(\$[0-9,]+(?:\.[0-9]+)?)/;
  const globalPriceMatch = text.match(priceRegex);
  const globalPrice = globalPriceMatch ? globalPriceMatch[0] : 'Contact for Price';

  // Global Expiry
  const expRegex = /\bExp(?:iry)?\s*[:\-]?\s*([^\s\n\r]+)/i;
  const globalExpMatch = text.match(expRegex);
  const globalExp = globalExpMatch ? globalExpMatch[1].trim() : 'N/A';

  // Global FOB
  const fobRegex = /\bFOB\s*[:\-]?\s*([^\n\r]+)/i;
  const globalFobMatch = text.match(fobRegex);
  const globalFob = globalFobMatch ? globalFobMatch[1].trim() : 'N/A';

  const products = [];

  // 3. Loop through links and isolate the text block associated with each
  for (let i = 0; i < matches.length; i++) {
    const currentMatch = matches[i];
    const link = currentMatch[0];

    // Determine the boundaries of the text block for this link
    // The block starts at the current link and runs until the start of the next link
    const startIdx = currentMatch.index;
    const endIdx = (i === matches.length - 1) ? text.length : matches[i + 1].index;
    
    const blockText = text.substring(startIdx, endIdx);

    // Parse local block details:
    // Local Units
    let units = 'N/A';
    const unitsPrefixMatch = blockText.match(/Units?\s*[:\-]?\s*(\d[\d,]*)/i);
    const unitsSuffixMatch = blockText.match(/(\d[\d,]*)[ \t]+Units?/i);
    
    if (unitsPrefixMatch) {
      units = unitsPrefixMatch[1].replace(/,/g, '');
    } else if (unitsSuffixMatch) {
      units = unitsSuffixMatch[1].replace(/,/g, '');
    } else {
      // Check if there is a line containing only digits (excluding any price string like $)
      const lines = blockText.split('\n');
      for (const line of lines) {
        const cleanLine = line.trim();
        if (/^\d[\d,]*$/.test(cleanLine)) {
          units = cleanLine.replace(/,/g, '');
          break;
        }
      }
    }

    // Local Price (fallback to global price)
    const localPriceMatch = blockText.match(priceRegex);
    const price = localPriceMatch ? localPriceMatch[0] : globalPrice;

    // Local Expiry (fallback to global expiry)
    const localExpMatch = blockText.match(expRegex);
    const exp = localExpMatch ? localExpMatch[1].trim() : globalExp;

    // Local FOB (fallback to global FOB)
    const localFobMatch = blockText.match(fobRegex);
    const fob = localFobMatch ? localFobMatch[1].trim() : globalFob;

    products.push({
      link,
      price,
      units,
      exp,
      fob
    });
  }

  return products;
}

/**
 * Checks if a product has already been posted.
 * Adds the key to crawled_asins.json if new.
 * 
 * @param {string} key Unique identifier for the product.
 * @returns {boolean} True if new/added, false if duplicate.
 */
function checkAndAddProductKey(key) {
  if (!key || key === 'unknown') return true; // Don't block if unknown

  let database = [];
  try {
    if (fs.existsSync(DEDUPE_FILE)) {
      const content = fs.readFileSync(DEDUPE_FILE, 'utf8');
      database = JSON.parse(content);
    }
  } catch (e) {
    console.error('[Dedupe Read Error]', e.message);
  }

  if (database.includes(key)) {
    return false;
  }

  database.push(key);
  try {
    fs.writeFileSync(DEDUPE_FILE, JSON.stringify(database, null, 2), 'utf8');
  } catch (e) {
    console.error('[Dedupe Write Error]', e.message);
  }

  return true;
}

module.exports = {
  parseMessage,
  checkAndAddProductKey
};
