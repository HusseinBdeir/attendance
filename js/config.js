// BHFIRMS Attendance kiosk — configuration
// One tablet = one site. The site is picked once in Settings (manager PIN) and
// maps to the Dataverse business unit whose staff the tablet serves.
// Nothing secret lives here: the API URL + key are entered on the device.

const ATT_CONFIG = {
  version: "0.1.0",

  // Site code -> business-unit display name in Dataverse (exact, the API filters on it).
  sites: {
    LAUNA:    { name: "La Una",          bu: "La Una" },
    BLANCA:   { name: "Blanca",          bu: "Blanca" },
    PALMS:    { name: "Palms",           bu: "Palms" },
    VOILE:    { name: "Voile",           bu: "Voile" },
    WTC:      { name: "WTC",             bu: "WTC" },
    BBCO:     { name: "BBConstruction",  bu: "BBConstruction" },
    LIONS:    { name: "Lions Transport", bu: "Lions Transport" },
    KORRI:    { name: "Korri Auto",      bu: "Korri Auto" },
    SHACMAN:  { name: "Shacman",         bu: "Shacman" },
    PROPS:    { name: "Properties",      bu: "Properties" },
  },
  defaultSite: "LAUNA",

  // Manager PIN seeded on a fresh device — CHANGE IT in Settings on first login.
  firstRunManagerPin: "9999",
  pinLength: 4,

  // Face matching (face-api.js 128-d descriptors, euclidean distance).
  // Lower threshold = stricter. 0.5 is a good tablet-at-the-door value with
  // 3-5 enrolment samples; raise toward 0.6 only if genuine staff get rejected.
  match: {
    threshold: 0.5,
    minSamples: 3,        // enrolment samples required before a face is usable
    maxSamples: 5,
    confirmFrames: 2,     // same person in N consecutive frames before punching
    unknownFrames: 3,     // unknown face in N consecutive frames before the PIN hint
    detectorInputSize: 320,
    detectorScore: 0.5,
  },

  punch: {
    debounceMinutes: 2,   // same person again within N minutes = "already clocked"
    cardSeconds: 4,       // how long the confirmation card stays up
    snapshotWidth: 240,   // audit snapshot saved with every punch (JPEG)
    snapshotQuality: 0.6,
  },

  sync: {
    intervalSec: 60,      // background push when online
    batchPunches: 20,     // punches per request (snapshots ~15 KB each)
    batchFaces: 10,
  },
};
