/**
 * Formatter Module.
 * Responsible for formatting outbound Telegram deal messages
 * and generating random fallback UPC codes if a real UPC cannot be scraped.
 */

/**
 * Formats a premium product post to display in Telegram.
 * Omits the Expiration date field if it is not specified or resolves to "N/A".
 * Omits the UPC field if it is not found.
 * 
 * @param {string|null} productId The unique product identifier (UPC barcode).
 * @param {object} parsedData Object containing price, units, exp, and link.
 * @param {string|null} imageUrl Scraped image URL for the product.
 * @returns {string} The formatted text post for Telegram.
 */
function generatePost(productId, parsedData, imageUrl) {
  const cleanImage = imageUrl || 'Not Found';
  
  let post = '';
  if (productId) {
    post += `UPC: ${productId}  \n`;
  }
  post += `Price: ${parsedData.price}  \n`;
  post += `Units: ${parsedData.units}  \n`;
  
  // Omit expiry date field if not provided or resolves to "N/A"
  if (parsedData.exp && parsedData.exp.toUpperCase() !== 'N/A') {
    post += `Exp: ${parsedData.exp}  \n`;
  }
  
  // Omit FOB field if not provided or resolves to "N/A"
  if (parsedData.fob && parsedData.fob.toUpperCase() !== 'N/A') {
    post += `FOB: ${parsedData.fob}  \n`;
  }
  
  post += `Link: ${parsedData.link}  \n`;
  post += `Image: ${cleanImage}`;
  
  return post;
}

module.exports = {
  generatePost
};
