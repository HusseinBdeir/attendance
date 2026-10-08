// Shape of js/endpoints.js (gitignored). Generate the real one with
//   py scripts/att03_endpoints.py
// which reads exports/att02_callback_url.txt + exports/att02_key.txt.
// The app resolves the endpoint by site: sites[SITE] if present, else default.
const ATT_ENDPOINTS = {
  generated: "",
  default: { url: "", key: "" },
  sites: {
    // LAUNA: { url: "https://…", key: "…" },
  },
};
