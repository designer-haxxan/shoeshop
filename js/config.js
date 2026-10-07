// Deployment configuration.
export const CONFIG = {
  APP_NAME: 'Shoe Shop POS',
  // Namespace for everything this app stores in the browser. All apps on designer-haxxan.github.io share
  // one origin (one IndexedDB / LocalStorage / Cache Storage), so every app must use its own unique APP_ID.
  APP_ID: 'disterp',
  APP_VERSION: '2.0.1',
  SCHEMA_VERSION: 1,
  BACKUP_VERSION: 1,
  // Login API: POST {AUTH_API_BASE}/login. The server does not send CORS headers, so the app must be
  // served from the same origin (https://eposwala.com) or the API must allow the app's origin.
  AUTH_API_BASE: 'https://eposwala.com/api',
  SUPPORT_PHONE: '0302-8863131',
};

export const CDN = {
  html5qrcode: 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js',
};

// LocalStorage key inside this app's namespace, e.g. storageKey('settings') -> 'disterp.settings'.
export const storageKey = (name) => `${CONFIG.APP_ID}.${name}`;
