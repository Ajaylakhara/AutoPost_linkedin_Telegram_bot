/**
 * LinkedIn Integration Module.
 * Manages OAuth 2.0 token refreshes and publishing posts.
 */

const axios = require('axios');
const querystring = require('querystring');

// Retrieve environment variables
const {
  LINKEDIN_CLIENT_ID,
  LINKEDIN_CLIENT_SECRET,
  LINKEDIN_REFRESH_TOKEN,
  LINKEDIN_AUTHOR_URN
} = process.env;

// Cache for access token and expiration time
let cachedAccessToken = null;
let tokenExpiryTime = 0;

/**
 * Exchanges the long-lived refresh token for a fresh access token.
 * Cache standard: returns cached token if valid.
 * 
 * @returns {Promise<string|null>} The access token or null on failure.
 */
async function getAccessToken() {
  // Check if cache is still valid (with 60-second safety margin)
  const now = Date.now();
  if (cachedAccessToken && now < tokenExpiryTime - 60000) {
    return cachedAccessToken;
  }

  // Verify that required environment variables are set
  if (!LINKEDIN_CLIENT_ID || !LINKEDIN_CLIENT_SECRET || !LINKEDIN_REFRESH_TOKEN) {
    console.warn('[LinkedIn Warning] Missing client_id, client_secret, or refresh_token in .env. Cannot authenticate.');
    return null;
  }

  try {
    console.log('🔄 Fetching new LinkedIn Access Token using Refresh Token...');
    const response = await axios.post(
      'https://www.linkedin.com/oauth/v2/accessToken',
      querystring.stringify({
        grant_type: 'refresh_token',
        refresh_token: LINKEDIN_REFRESH_TOKEN,
        client_id: LINKEDIN_CLIENT_ID,
        client_secret: LINKEDIN_CLIENT_SECRET
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    if (response.data && response.data.access_token) {
      cachedAccessToken = response.data.access_token;
      // expires_in is usually in seconds (e.g. 5184000 = 60 days)
      const expiresInMs = (response.data.expires_in || 3600) * 1000;
      tokenExpiryTime = Date.now() + expiresInMs;

      console.log('✅ LinkedIn Access Token successfully refreshed.');
      
      // If LinkedIn rotated the refresh token, notify the user
      if (response.data.refresh_token && response.data.refresh_token !== LINKEDIN_REFRESH_TOKEN) {
        console.warn('\n⚠️ WARNING: LinkedIn has rotated your refresh token!');
        console.warn('Please update your .env file with the new LINKEDIN_REFRESH_TOKEN value:');
        console.warn(response.data.refresh_token);
        console.warn('--------------------------------------------------\n');
      }

      return cachedAccessToken;
    }
  } catch (err) {
    console.error('❌ [LinkedIn Auth Error] Failed to refresh access token:', err.response?.data || err.message);
  }

  return null;
}

/**
 * Publishes a commentary post to the user's LinkedIn profile or organization page.
 * 
 * @param {string} text The formatted text content of the post.
 * @returns {Promise<boolean>} True if published successfully, false otherwise.
 */
async function publishPost(text) {
  if (!LINKEDIN_AUTHOR_URN) {
    console.warn('[LinkedIn Warning] LINKEDIN_AUTHOR_URN is not set in .env. Skipping post.');
    return false;
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    console.warn('[LinkedIn Warning] Could not obtain LinkedIn access token. Skipping post.');
    return false;
  }

  try {
    console.log('📤 Publishing post to LinkedIn...');
    
    // Construct the payload matching LinkedIn Versioned Posts API /rest/posts
    const payload = {
      author: LINKEDIN_AUTHOR_URN,
      commentary: text,
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
      },
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: []
      },
      lifecycleState: 'PUBLISHED'
    };

    const response = await axios.post(
      'https://api.linkedin.com/rest/posts',
      payload,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'LinkedIn-Version': '202401',
          'X-Restli-Protocol-Version': '2.0.0'
        }
      }
    );

    if (response.status === 201) {
      console.log('✅ LinkedIn Post published successfully!');
      return true;
    } else {
      console.warn('⚠️ LinkedIn API response code:', response.status);
      return false;
    }
  } catch (err) {
    console.error('❌ [LinkedIn Post Error] Failed to publish post:', err.response?.data || err.message);
    return false;
  }
}

module.exports = {
  getAccessToken,
  publishPost
};
