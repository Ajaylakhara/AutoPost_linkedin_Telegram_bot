/**
 * Formatter Module.
 * Responsible for formatting outbound Telegram deal messages
 * and generating random fallback UPC codes if a real UPC cannot be scraped.
 */

/**
 * Generates a random unique 6-digit fallback ID in the format UPCXXXXXX.
 * Used when a real UPC could not be extracted from the product page.
 * 
 * @returns {string} E.g., "UPC583920"
 */
function generateUPC() {
  const randomNum = Math.floor(100000 + Math.random() * 900000);
  return `UPC${randomNum}`;
}

/**
 * Formats a premium product post to display in Telegram.
 * Omits the Expiration date field if it is not specified or resolves to "N/A".
 * 
 * @param {string} productId The unique product identifier (UPC barcode or fallback UPC ID).
 * @param {object} parsedData Object containing price, units, exp, and link.
 * @param {string|null} imageUrl Scraped image URL for the product.
 * @returns {string} The formatted text post for Telegram.
 */
function generatePost(productId, parsedData, imageUrl) {
  const cleanImage = imageUrl || 'Not Found';
  
  let post = `UPC: ${productId}  \n`;
  post += `Price: ${parsedData.price}  \n`;
  post += `Units: ${parsedData.units}  \n`;
  
  // Omit expiry date field if not provided or resolves to "N/A"
  if (parsedData.exp && parsedData.exp.toUpperCase() !== 'N/A') {
    post += `Exp: ${parsedData.exp}  \n`;
  }
  
  post += `Link: ${parsedData.link}  \n`;
  post += `Image: ${cleanImage}`;
  
  return post;
}

module.exports = {
  generateUPC,
  generatePost
};
