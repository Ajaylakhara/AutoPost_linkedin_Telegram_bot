/**
 * Scraper Module.
 * Fetches page HTML and extracts product details (Title, Image, UPC).
 */

const axios = require('axios');
const cheerio = require('cheerio');
const urlModule = require('url');

/**
 * Expands short URLs (redirects) to retrieve the full target URL.
 * 
 * @param {string} url The URL to expand.
 * @param {number} maxRedirects Maximum redirect depth.
 * @returns {Promise<string>} Expanded URL.
 */
async function expandUrl(url, maxRedirects = 5) {
  if (maxRedirects <= 0 || !url) {
    return url;
  }
  try {
    const response = await axios.get(url, {
      maxRedirects: 0, // Manual redirect following
      validateStatus: (status) => status >= 200 && status < 400,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      let redirectUrl = response.headers.location;
      if (!redirectUrl.startsWith('http')) {
        redirectUrl = urlModule.resolve(url, redirectUrl);
      }
      return expandUrl(redirectUrl, maxRedirects - 1);
    }
    return url;
  } catch (err) {
    if (err.response && err.response.status >= 300 && err.response.status < 400 && err.response.headers.location) {
      let redirectUrl = err.response.headers.location;
      if (!redirectUrl.startsWith('http')) {
        redirectUrl = urlModule.resolve(url, redirectUrl);
      }
      return expandUrl(redirectUrl, maxRedirects - 1);
    }
    return url;
  }
}

/**
 * Extracts a unique product key for deduplication.
 * 
 * @param {string} url The expanded product URL.
 * @returns {string} Unique identifier.
 */
function extractProductKey(url) {
  if (!url) return 'unknown';

  // Amazon ASIN
  const amazonMatch = url.match(/(?:dp|gp\/product|ASIN|d)\/([A-Z0-9]{10})/i);
  if (amazonMatch) return amazonMatch[1];

  // Walmart Item ID
  const walmartMatch = url.match(/\/ip\/(?:[^\/]+\/)?(\d+)/i);
  if (walmartMatch) return `walmart_${walmartMatch[1]}`;

  // eBay ID
  const ebayMatch = url.match(/itm\/(\d+)/i);
  if (ebayMatch) return `ebay_${ebayMatch[1]}`;

  // General Fallback
  try {
    const parsed = urlModule.parse(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch (e) {
    return url;
  }
}

/**
 * Parses the product page HTML to extract details.
 * Supports Amazon & Walmart, falls back to generic selectors.
 * 
 * @param {string} url The product page URL.
 * @returns {Promise<object>} Parsed product data.
 */
async function scrapeProductData(url) {
  const data = {
    title: 'Product Title',
    imageUrl: '',
    upc: 'Not Found'
  };

  if (!url) return data;

  try {
    const expandedUrl = await expandUrl(url);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'max-age=0'
    };

    if (expandedUrl.includes('amazon.com')) {
      headers['device-memory'] = '8';
      headers['downlink'] = '10';
      headers['ect'] = '4g';
      headers['rtt'] = '50';
      headers['sec-ch-ua'] = '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"';
      headers['sec-ch-ua-mobile'] = '?0';
      headers['sec-ch-ua-platform'] = '"Windows"';
      headers['sec-fetch-dest'] = 'document';
      headers['sec-fetch-mode'] = 'navigate';
      headers['sec-fetch-site'] = 'none';
      headers['sec-fetch-user'] = '?1';
      headers['upgrade-insecure-requests'] = '1';
    }

    const response = await axios.get(expandedUrl, {
      timeout: 10000,
      headers
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // 1. Try JSON-LD Schema (common on Walmart, eBay, and modern stores)
    $('script[type="application/ld+json"]').each((_, element) => {
      try {
        const textContent = $(element).html();
        if (!textContent) return;
        const schema = JSON.parse(textContent.trim());

        // Normal schema or array of schemas
        const schemas = Array.isArray(schema) ? schema : [schema];
        for (const s of schemas) {
          // Check if product type
          if (s['@type'] === 'Product' || s['@type']?.includes('Product') || s.name || s.image) {
            if (s.name && data.title === 'Product Title') {
              data.title = s.name.trim();
            }
            if (s.image) {
              const img = Array.isArray(s.image) ? s.image[0] : s.image;
              if (img && typeof img === 'string' && !data.imageUrl) {
                data.imageUrl = img;
              } else if (img && typeof img === 'object' && img.url && !data.imageUrl) {
                data.imageUrl = img.url;
              }
            }
            // Extract GTIN / UPC / ISBN
            const gtin = s.gtin13 || s.gtin12 || s.gtin || s.upc || s.mpn || s.isbn;
            if (gtin && typeof gtin === 'string' && data.upc === 'Not Found') {
              data.upc = gtin.replace(/[^\d]/g, '');
            }
          }
        }
      } catch (e) {
        // Skip malformed JSON
      }
    });

    // 2. Fallbacks for Title
    if (data.title === 'Product Title') {
      // Amazon specific
      const amzTitle = $('#productTitle').text().trim();
      if (amzTitle) {
        data.title = amzTitle;
      } else {
        // Meta og:title
        const ogTitle = $('meta[property="og:title"]').attr('content') || $('meta[name="twitter:title"]').attr('content');
        if (ogTitle) {
          data.title = ogTitle.trim();
        } else {
          // Standard title tag
          const stdTitle = $('title').text().trim();
          if (stdTitle) {
            data.title = stdTitle.replace(/\s+/g, ' ');
          }
        }
      }
    }

    // Clean title from common suffixes
    if (data.title) {
      data.title = data.title.replace(/\s*-\s*Walmart\.com\s*$/i, '')
                             .replace(/\s*:\s*Amazon\.com\s*(?::\s*.*)?$/i, '');
    }

    // 3. Fallbacks for Image
    if (!data.imageUrl) {
      // Amazon landing image dynamic map
      const amzImgDynamic = $('#landingImage').attr('data-a-dynamic-image');
      if (amzImgDynamic) {
        try {
          const decoded = JSON.parse(amzImgDynamic);
          const urls = Object.keys(decoded);
          if (urls.length > 0) {
            data.imageUrl = urls[0];
          }
        } catch (e) {}
      }

      if (!data.imageUrl) {
        data.imageUrl = $('#landingImage').attr('src') || 
                        $('#imgBlkFront').attr('src') || 
                        $('#main-image').attr('src');
      }

      if (!data.imageUrl) {
        const ogImage = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
        if (ogImage) {
          data.imageUrl = ogImage;
        }
      }

      if (!data.imageUrl) {
        // First reasonable image
        $('img').each((_, img) => {
          const src = $(img).attr('src');
          if (src && src.startsWith('http') && !src.includes('pixel') && !src.includes('sprite') && !src.includes('logo') && !src.includes('tracking')) {
            data.imageUrl = src;
            return false; // break
          }
        });
      }
    }

    // Resolve relative image URLs
    if (data.imageUrl && data.imageUrl.startsWith('//')) {
      data.imageUrl = 'https:' + data.imageUrl;
    } else if (data.imageUrl && data.imageUrl.startsWith('/')) {
      const parsedUrl = urlModule.parse(expandedUrl);
      data.imageUrl = `${parsedUrl.protocol}//${parsedUrl.host}${data.imageUrl}`;
    }

    // 4. Fallbacks for UPC
    if (data.upc === 'Not Found') {
      // Look for Amazon product detail table/list patterns
      const upcText = $('span:contains("UPC"), th:contains("UPC"), td:contains("UPC")')
        .parent()
        .text();
      
      const upcMatch = upcText.match(/\b([0-9]{12})\b/);
      if (upcMatch) {
        data.upc = upcMatch[1];
      } else {
        // Regex search in the raw HTML near the word "UPC"
        const upcIndex = html.search(/\bUPC\b/i);
        if (upcIndex !== -1) {
          const substring = html.substring(upcIndex, upcIndex + 250);
          const rawMatch = substring.match(/\b(\d{12})\b/);
          if (rawMatch) {
            data.upc = rawMatch[1];
          }
        }
      }
    }

  } catch (err) {
    console.error(`[Scraper Error] Error scraping details for ${url}:`, err.message);
  }

  // Ensure output complies with fallback rules
  if (!data.upc || data.upc === '') {
    data.upc = 'Not Found';
  }

  return data;
}

module.exports = {
  scrapeProductData,
  expandUrl,
  extractProductKey
};
