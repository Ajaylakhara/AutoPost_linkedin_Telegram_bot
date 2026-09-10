/**
 * Database & Deduplication Layer
 *
 * Provides persistent ASIN/product deduplication:
 * - Production: Cloud Firestore ('crawled_asins' collection with atomic document creation)
 * - Local Development: Fallback to local 'crawled_asins.json' file
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const DEDUPE_FILE = path.join(__dirname, 'crawled_asins.json');
const COLLECTION_NAME = 'crawled_asins';

let db = null;
let firestoreInitialized = false;

// Initialize Firebase Admin if running in Cloud Functions or if credentials are available
try {
  if (admin.apps.length === 0) {
    admin.initializeApp();
  }
  db = admin.firestore();
  firestoreInitialized = true;
  console.log('[DB] Firestore initialized successfully.');
} catch (err) {
  firestoreInitialized = false;
  console.log('[DB] Running in local file storage mode (Firestore not available:', err.message, ')');
}

/**
 * Sanitizes a product key to make it a safe Firestore document ID (removes / and non-safe chars).
 */
function sanitizeDocId(key) {
  if (!key) return 'unknown';
  return encodeURIComponent(key).replace(/\./g, '%2E');
}

/**
 * Checks if a product key is already crawled/recorded.
 *
 * @param {string} key
 * @returns {Promise<boolean>} True if already exists (duplicate), false if new.
 */
async function isKeyProcessed(key) {
  if (!key || key === 'unknown') return false;

  if (firestoreInitialized && db) {
    try {
      const docId = sanitizeDocId(key);
      const doc = await db.collection(COLLECTION_NAME).doc(docId).get();
      return doc.exists;
    } catch (err) {
      console.warn('[DB] Firestore read warning, falling back to local file:', err.message);
    }
  }

  // Local JSON Fallback
  try {
    if (fs.existsSync(DEDUPE_FILE)) {
      const content = fs.readFileSync(DEDUPE_FILE, 'utf8');
      const list = JSON.parse(content);
      return Array.isArray(list) && list.includes(key);
    }
  } catch (err) {
    console.error('[DB Local Read Error]:', err.message);
  }
  return false;
}

/**
 * Atomically checks if a product key exists, and adds it if it does not.
 *
 * @param {string} key Unique identifier for the product deal (e.g. ASIN or URL).
 * @param {object} metadata Additional optional metadata (title, price, link).
 * @returns {Promise<boolean>} True if newly added, False if it was already processed.
 */
async function checkAndAddProductKey(key, metadata = {}) {
  if (!key || key === 'unknown') return true;

  if (firestoreInitialized && db) {
    try {
      const docId = sanitizeDocId(key);
      const docRef = db.collection(COLLECTION_NAME).doc(docId);

      // Atomic create: throws ALREADY_EXISTS (code 6) if the document already exists
      await docRef.create({
        key: key,
        asin: metadata.asin || key,
        title: metadata.title || '',
        price: metadata.price || null,
        units: metadata.units || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSeenAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return true; // Successfully created (new deal)
    } catch (err) {
      if (err.code === 6 || err.code === 'already-exists' || (err.message && err.message.includes('ALREADY_EXISTS'))) {
        return false; // Duplicate detected
      }
      console.warn('[DB] Firestore write failed, using local file storage:', err.message);
    }
  }

  // Local JSON Fallback
  let database = [];
  try {
    if (fs.existsSync(DEDUPE_FILE)) {
      const content = fs.readFileSync(DEDUPE_FILE, 'utf8');
      database = JSON.parse(content);
      if (!Array.isArray(database)) database = [];
    }
  } catch (e) {
    console.error('[DB Local Fallback Read Error]:', e.message);
  }

  if (database.includes(key)) {
    return false; // Duplicate
  }

  database.push(key);
  try {
    fs.writeFileSync(DEDUPE_FILE, JSON.stringify(database, null, 2), 'utf8');
  } catch (e) {
    console.error('[DB Local Fallback Write Error]:', e.message);
  }

  return true; // New deal added
}

/**
 * Fetches all registered ASIN/product keys.
 *
 * @returns {Promise<Array<string>>}
 */
async function getAllKeys() {
  if (firestoreInitialized && db) {
    try {
      const snapshot = await db.collection(COLLECTION_NAME).orderBy('createdAt', 'desc').limit(200).get();
      const keys = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        keys.push(data.key || doc.id);
      });
      return keys;
    } catch (err) {
      console.warn('[DB] Firestore getAllKeys warning:', err.message);
    }
  }

  // Local Fallback
  try {
    if (fs.existsSync(DEDUPE_FILE)) {
      const content = fs.readFileSync(DEDUPE_FILE, 'utf8');
      const list = JSON.parse(content);
      return Array.isArray(list) ? list : [];
    }
  } catch (err) {
    console.error('[DB Local getAllKeys Error]:', err.message);
  }
  return [];
}

/**
 * Deletes a product key from the database.
 *
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function deleteKey(key) {
  if (!key) return false;

  let deleted = false;
  if (firestoreInitialized && db) {
    try {
      const docId = sanitizeDocId(key);
      const docRef = db.collection(COLLECTION_NAME).doc(docId);
      const doc = await docRef.get();
      if (doc.exists) {
        await docRef.delete();
        deleted = true;
      }
    } catch (err) {
      console.warn('[DB] Firestore deleteKey warning:', err.message);
    }
  }

  // Also remove from local file if present
  try {
    if (fs.existsSync(DEDUPE_FILE)) {
      const content = fs.readFileSync(DEDUPE_FILE, 'utf8');
      let list = JSON.parse(content);
      if (Array.isArray(list)) {
        const index = list.indexOf(key);
        if (index !== -1) {
          list.splice(index, 1);
          fs.writeFileSync(DEDUPE_FILE, JSON.stringify(list, null, 2), 'utf8');
          deleted = true;
        }
      }
    }
  } catch (err) {
    console.error('[DB Local deleteKey Error]:', err.message);
  }

  return deleted;
}

/**
 * Returns database status info for the dashboard.
 */
function getDbStatus() {
  return {
    engine: firestoreInitialized ? 'Cloud Firestore' : 'Local JSON File',
    collection: COLLECTION_NAME,
    isFirestore: firestoreInitialized
  };
}

module.exports = {
  checkAndAddProductKey,
  isKeyProcessed,
  getAllKeys,
  deleteKey,
  getDbStatus
};
