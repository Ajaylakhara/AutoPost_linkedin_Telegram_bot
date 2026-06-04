/**
 * Parser Module.
 * Responsible for splitting messages containing multiple product posts
 * and parsing individual product information (link, price, units, expiry).
 */

/**
 * Splits a raw Telegram message containing multiple product links into
 * separate messages for each product. It preserves global headers (top text)
 * and global footers (pricing/expiry/location info at the bottom) so that each
 * split message is fully self-contained.
 * 
 * @param {string} text The raw incoming text message.
 * @returns {Array<string>} An array of self-contained product text blocks.
 */
function splitMessageIntoProducts(text) {
  if (!text) return [];

  // Find all URLs in the message
  const linkRegex = /(https?:\/\/[^\s]+)/g;
  const matches = [...text.matchAll(linkRegex)];
  
  // If there is only one link or no links, process the whole message as a single product
  if (matches.length <= 1) {
    return [text];
  }

  // 1. Extract the global top text (everything before the first product link)
  const firstLinkIndex = matches[0].index;
  const globalTopText = text.substring(0, firstLinkIndex).trim();

  // 2. Extract the last product's local block and any global bottom footer
  const lastLinkIndex = matches[matches.length - 1].index;
  const afterLastLinkText = text.substring(lastLinkIndex);
  
  const lines = afterLastLinkText.split('\n');
  let lastProductBlockLines = [];
  let globalBottomLines = [];
  
  let foundGlobalFooter = false;
  for (const line of lines) {
    const cleanLine = line.trim();
    
    // Detect if we hit global footer lines (e.g. price, expiry date, shipping location, etc.)
    if (!foundGlobalFooter) {
      if (cleanLine.includes('$') || 
          /\bexp(?:iry)?\b/i.test(cleanLine) || 
          /\bfob\b/i.test(cleanLine) ||
          cleanLine.toLowerCase().includes('per unit')) {
        foundGlobalFooter = true;
      }
    }
    
    if (foundGlobalFooter) {
      globalBottomLines.push(line);
    } else {
      lastProductBlockLines.push(line);
    }
  }

  const lastProductLocalText = lastProductBlockLines.join('\n');
  const globalBottomText = globalBottomLines.join('\n').trim();

  // 3. Construct individual product blocks
  const subMessages = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    let localText = '';
    
    // For intermediate products, local text runs from current link up to the start of the next link
    if (i < matches.length - 1) {
      const nextLinkIndex = matches[i + 1].index;
      localText = text.substring(match.index, nextLinkIndex).trim();
    } else {
      // For the last product, use the separated local block lines
      localText = lastProductLocalText.trim();
    }

    // Assemble parts: [Header] + [Product-Specific Details] + [Footer]
    const parts = [];
    if (globalTopText) parts.push(globalTopText);
    parts.push(localText);
    if (globalBottomText) parts.push(globalBottomText);

    subMessages.push(parts.join('\n\n'));
  }

  return subMessages;
}

/**
 * Parses details from a single, self-contained product text message.
 * Extracts: link, price, units count, and expiry date.
 * 
 * @param {string} text The product text block to parse.
 * @returns {object|null} The parsed details object or null if invalid/no link found.
 */
function parseMessage(text) {
  if (!text || text.trim().length < 10) {
    return null;
  }

  // 1. Extract link
  const linkRegex = /(https?:\/\/[^\s]+)/;
  const linkMatch = text.match(linkRegex);
  if (!linkMatch) {
    return null;
  }

  // 2. Extract Price (format: $X,XXX.XX)
  const priceRegex = /(\$[0-9,]+(?:\.[0-9]+)?)/;
  const priceMatch = text.match(priceRegex);
  const price = priceMatch ? priceMatch[0] : 'Contact for Price';

  // 3. Extract Units count
  let units = 'Inquire';
  // Try pattern: "5400 Units" or "3,000 unit"
  const unitsKeywordMatch = text.match(/(\d[\d,]*)\s*Units?/i);
  if (unitsKeywordMatch) {
    units = unitsKeywordMatch[1].replace(/,/g, '');
  } else {
    // If no keyword, check if there's a line containing only digits (excluding price line)
    const lines = text.split('\n');
    for (const line of lines) {
      const cleanLine = line.trim();
      if (/^\d[\d,]*$/.test(cleanLine)) {
        units = cleanLine.replace(/,/g, '');
        break;
      }
    }
  }

  // 4. Extract Expiry date (e.g. Exp 12/26 or Expiry: Nov 2025)
  let exp = 'N/A';
  const expMatch = text.match(/\bExp(?:iry)?\s*[:\-]?\s*([^\s\n]+)/i);
  if (expMatch) {
    exp = expMatch[1].trim();
  }

  // 5. Extract FOB location (e.g. FOB - CA or FOB: Texas)
  let fob = 'N/A';
  const fobMatch = text.match(/\bFOB\s*[:\-]?\s*([^\n\r]+)/i);
  if (fobMatch && fobMatch[1].trim()) {
    fob = fobMatch[1].trim();
  }

  return {
    link: linkMatch[0],
    price,
    units,
    exp,
    fob
  };
}

module.exports = {
  splitMessageIntoProducts,
  parseMessage
};
