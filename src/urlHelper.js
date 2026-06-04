/**
 * URL Helper Module.
 * Deals with expanding redirect URLs (e.g. Amazon short links a.co)
 * and extracting unique identifiers like Amazon ASINs or eBay/Walmart product keys.
 */

const https = require('https');
const urlModule = require('url');

/**
 * Asynchronously follows HTTP redirects to expand short URLs.
 * E.g., translates "https://a.co/d/xyz" into the full Amazon product page URL.
 * 
 * @param {string} shortUrl The URL to expand.
 * @param {number} maxRedirects Maximum redirection steps before stopping. Prevents infinite redirect loops.
 * @returns {Promise<string>} The fully expanded destination URL.
 */
function expandUrl(shortUrl, maxRedirects = 5) {
  return new Promise((resolve) => {
    if (maxRedirects <= 0) {
      return resolve(shortUrl);
    }

    let parsedUrl;
    try {
      parsedUrl = urlModule.parse(shortUrl);
    } catch (e) {
      return resolve(shortUrl);
    }

    const options = {
      method: 'GET',
      hostname: parsedUrl.hostname,
      path: parsedUrl.path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      }
    };

    const req = https.request(options, (res) => {
      // Consume response data to free up memory
      res.resume();

      // Check for redirect status codes (3xx) and a Location header
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = urlModule.resolve(shortUrl, redirectUrl);
        }
        return resolve(expandUrl(redirectUrl, maxRedirects - 1));
      }
      // If not redirecting, this is the final URL
      resolve(shortUrl);
    });

    req.on('error', () => {
      // Return shortUrl on connection error as fallback
      resolve(shortUrl);
    });

    req.end();
  });
}

/**
 * Extracts the 10-character Amazon Standard Identification Number (ASIN) from Amazon product URLs.
 * 
 * @param {string} url The Amazon product URL.
 * @returns {string|null} The ASIN, or null if not found.
 */
function extractASIN(url) {
  if (!url) return null;
  // Look for patterns like dp/ASIN, product/ASIN, or d/ASIN
  const match = url.match(/(?:dp|gp\/product|ASIN|d)\/([A-Z0-9]{10})/i);
  return match ? match[1] : null;
}

/**
 * Generates a unique deduplication key for Amazon, eBay, Walmart, or other product URLs.
 * This key is used to detect duplicate posts.
 * 
 * @param {string} url The expanded product URL.
 * @returns {string} Unique product key string.
 */
function extractProductKey(url) {
  // 1. Try Amazon ASIN first
  const asin = extractASIN(url);
  if (asin) return asin;

  // 2. Extract eBay Item ID (e.g. /itm/123456789012)
  const ebayMatch = url.match(/itm\/(\d+)/i);
  if (ebayMatch) return `ebay_${ebayMatch[1]}`;

  // 3. Extract Walmart Item ID (e.g. /ip/Product-Name/12345678)
  const walmartMatch = url.match(/\/ip\/(?:[^\/]+\/)?(\d+)/i);
  if (walmartMatch) return `walmart_${walmartMatch[1]}`;

  // 4. Fallback: Clean up URL query parameters and use the hostname + path
  try {
    const parsed = urlModule.parse(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch (e) {
    return url;
  }
}

module.exports = {
  expandUrl,
  extractASIN,
  extractProductKey
};
