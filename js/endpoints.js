// Attendance kiosk sync endpoint: the ISABI cloud (Cloudflare), resolved by site.
// Nothing secret lives in this file. Each tablet's station key is typed once in
// Settings (Cloud Sync card) and stays on that tablet.
const ATT_ENDPOINTS = {
  "default": { "url": "https://isabisystems.com/app/api/kiosk/verify" },
  "sites": {}
};
