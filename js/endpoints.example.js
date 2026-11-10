// Shape of js/endpoints.js. The app resolves the endpoint by site: sites[SITE] if present, else default.
// Only the URL goes here. Never put a key in this file: the station key is typed on the tablet.
const ATT_ENDPOINTS = {
  default: { url: "https://isabisystems.com/app/api/kiosk/verify" },
  sites: {
    // LAUNA: { url: "https://example.invalid/other-endpoint" },
  },
};
