/**
 * Scraper Module.
 * Fetches page HTML and parses details such as product title, images,
 * and the actual UPC barcode (if available on the page).
 */

const https = require('https');
const urlModule = require('url');

/**
 * Fetches the raw HTML content of a URL.
 * Automatically follows HTTP redirects.
 * 
 * @param {string} targetUrl The URL to load.
 * @param {number} maxRedirects Maximum redirect depth.
 * @returns {Promise<string>} HTML text content.
 */
function fetchUrl(targetUrl, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      return reject(new Error('Too many redirects'));
    }

    let parsedUrl;
    try {
      parsedUrl = urlModule.parse(targetUrl);
    } catch (e) {
      return reject(e);
    }

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive'
      }
    };

    https.get(options, (res) => {
      // Handle redirect status codes (3xx)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = urlModule.resolve(targetUrl, redirectUrl);
        }
        return resolve(fetchUrl(redirectUrl, maxRedirects - 1));
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to fetch page, status code: ${res.statusCode}`));
      }

      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve(data);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Parses the product title from raw HTML.
 * Priority:
 *   1. Amazon productTitle span id
 *   2. HTML standard <title> tag
 * 
 * @param {string} html Page HTML.
 * @returns {string} Extracted title.
 */
function extractTitleFromHtml(html) {
  // Try Amazon-specific product title element first
  const amazonTitleRegex = /<span[^>]+id=["']productTitle["'][^>]*>([^<]+)<\/span>/i;
  let match = html.match(amazonTitleRegex);
  if (match && match[1]) {
    return match[1].trim();
  }

  // Fallback to standard <title> tag
  const titleRegex = /<title>([^<]+)<\/title>/i;
  match = html.match(titleRegex);
  if (match && match[1]) {
    return match[1].trim().replace(/\s+/g, ' ');
  }

  return 'Premium Product';
}

/**
 * Parses image URL from HTML content.
 * Matches:
 *   1. Amazon dynamic image JSON map
 *   2. OpenGraph Image tag (<meta property="og:image"...>)
 *   3. Twitter Image tag (<meta name="twitter:image"...>)
 *   4. Normal img tags (ignoring icons, pixels, tracking)
 * 
 * @param {string} html Page HTML.
 * @returns {string|null} The image URL, or null if none found.
 */
function extractImageFromHtml(html) {
  // 1. Amazon dynamic image map
  const dynamicImageRegex = /data-a-dynamic-image=["']([^"']+)["']/i;
  const dynamicMatch = html.match(dynamicImageRegex);
  if (dynamicMatch && dynamicMatch[1]) {
    try {
      const decoded = JSON.parse(dynamicMatch[1].replace(/&quot;/g, '"'));
      const imageUrls = Object.keys(decoded);
      if (imageUrls.length > 0) {
        return imageUrls[0];
      }
    } catch (e) {
      // Ignore and proceed to next selector
    }
  }

  // 2. OpenGraph Image tag (Standard format)
  const ogImageRegex = /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i;
  let match = html.match(ogImageRegex);
  if (match && match[1]) {
    return match[1];
  }

  // OpenGraph Image tag (Alternative attribute order format)
  const ogImageRegexAlt = /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i;
  match = html.match(ogImageRegexAlt);
  if (match && match[1]) {
    return match[1];
  }

  // 3. Twitter Image tag
  const twitterImageRegex = /<meta[^>]+name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i;
  match = html.match(twitterImageRegex);
  if (match && match[1]) {
    return match[1];
  }

  // 4. Fallback: Parse first reasonable <img> tag in page
  const imgRegex = /<img\s+[^>]*src=["']([^"']+)["']/gi;
  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1];
    if (src && !src.includes('sprite') && !src.includes('pixel') && !src.includes('clear.gif') && !src.includes('tracking')) {
      return src;
    }
  }

  return null;
}

/**
 * Extracts the real product UPC barcode from the page HTML.
 * Priority:
 *   1. Amazon product detail table (th: UPC -> td: value)
 *   2. Inline label pattern (UPC: 012345678901)
 *   3. First 12-digit number adjacent to the word "UPC"
 * 
 * @param {string} html Page HTML content.
 * @returns {string|null} Real UPC string, or null if not found.
 */
function extractUPCFromHtml(html) {
  // 1. Amazon product-detail table pattern:
  //    <th>UPC</th> ... <td>042000352574</td>
  const tableRegex = /UPC\s*<\/th>\s*<td[^>]*>\s*([0-9][\d\s,]{9,}[0-9])\s*<\/td>/i;
  let match = html.match(tableRegex);
  if (match && match[1]) {
    return match[1].replace(/[\s,]/g, '').trim();
  }

  // 2. Inline label: "UPC: 042000352574" or "UPC - 042000352574"
  const inlineRegex = /\bUPC\s*[:\-]\s*([0-9][\d\s]{9,}[0-9])/i;
  match = html.match(inlineRegex);
  if (match && match[1]) {
    return match[1].replace(/\s/g, '').trim();
  }

  // 3. Fallback: Search for any 12-digit number in the vicinity (300 chars) of the word "UPC"
  const upcIdx = html.search(/\bUPC\b/i);
  if (upcIdx !== -1) {
    const windowText = html.substring(upcIdx, upcIdx + 300);
    const numMatch = windowText.match(/\b(\d{12})\b/);
    if (numMatch) {
      return numMatch[1];
    }
  }

  return null;
}

/**
 * Scrapes metadata (title, image, UPC) from a product page.
 * Detects Amazon robot/CAPTCHA pages to prevent sending broken placeholders.
 * 
 * @param {string} url Product URL to scrape.
 * @returns {Promise<object|null>} Scraped details object, or null on network/fetch failure.
 */
async function scrapeProductData(url) {
  if (!url) return null;
  try {
    const html = await fetchUrl(url);
    
    // Check if blocked by Amazon CAPTCHA
    const isBlocked = html.includes('Robot Check') || html.includes('captcha') || html.includes('Please confirm you are not a robot');
    if (isBlocked) {
      console.warn('[Scraper Warning] Robot detection triggered by Amazon.');
    }

    const title = extractTitleFromHtml(html);

    let imageUrl = extractImageFromHtml(html);
    if (imageUrl && imageUrl.startsWith('//')) {
      imageUrl = 'https:' + imageUrl;
    }

    // Extract real product UPC if not blocked
    const realUpc = isBlocked ? null : extractUPCFromHtml(html);
    if (realUpc) {
      console.log(`   Real UPC found on page: ${realUpc}`);
    } else {
      console.log('   Real UPC not found on page. Will use generated fallback.');
    }

    return {
      title,
      imageUrl: isBlocked ? null : imageUrl,
      upc: realUpc,
      isBlocked
    };
  } catch (err) {
    console.error(`[Scraper Error] Could not scrape ${url}:`, err.message);
    return null;
  }
}

module.exports = {
  scrapeProductData,
  extractTitleFromHtml,
  extractImageFromHtml,
  extractUPCFromHtml
};
