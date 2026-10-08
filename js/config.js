// BHFIRMS Attendance kiosk — configuration
// One tablet = one site. The site is picked once in Settings (manager PIN) and
// maps to the Dataverse business unit whose staff the tablet serves.
// Nothing secret lives here: the API URL + key come from js/endpoints.js
// (generated per site by scripts/att03_endpoints.py, gitignored).

const ATT_CONFIG = {
  version: "0.2.1",

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
  // Stored hashed (SHA-256) on the device; a plain value left by v0.1 is hashed on boot.
  firstRunManagerPin: "9999",
  pinLength: 4,
  // Wrong PINs: after `pinLockAfter` failures in a row the keypad locks for `pinLockSec`.
  pinLockAfter: 5,
  pinLockSec: 30,

  // Face matching (face-api.js 128-d descriptors, euclidean distance).
  // A person is accepted when BOTH hold:
  //   1. distance to their closest enrolment sample <= threshold
  //   2. the closest sample of ANY OTHER person is at least `margin` further away
  // Lower threshold = stricter. Typical values: same person 0.25-0.45, different
  // people 0.55-0.80. Use Settings -> Calibration on the real tablet: it reports the
  // closest pair of different people and the loosest same-person pair from the
  // stored samples and recommends a threshold.
  match: {
    detector: "ssd",      // "ssd" = SSD MobileNet v1 (accurate, ~5.6 MB) | "tiny" = Tiny Face Detector (fast, weaker)
    threshold: 0.5,
    margin: 0.08,         // required gap between the best person and the runner-up
    weakAbove: 0.45,      // a match above this distance is still accepted but flagged "weak" for review
    minSamples: 3,        // enrolment samples required before a face is usable
    maxSamples: 6,        // 5 guided poses + one spare
    confirmFrames: 3,     // same person in N consecutive frames before punching
    unknownFrames: 3,     // unknown face in N consecutive frames before the PIN hint
    minFaceFrac: 0.14,    // face box width / frame width: smaller faces (people in the background) are ignored
    detectorInputSize: 320,   // tiny detector only
    detectorScore: 0.5,
    enrolScore: 0.7,      // detector confidence required for an enrolment sample
    // Guided enrolment: the prompt shown for sample 1..n.
    poses: ["Look straight at the camera", "Turn your head slightly LEFT", "Turn your head slightly RIGHT", "Tilt your chin up a little", "Natural smile", "One more, straight on"],
  },

  // Liveness (anti-photo) check: after a face is recognised the kiosk asks for a
  // blink and only punches once it sees one. Off by default; switch it on in
  // Settings once recognition itself is tuned. Blink = eye aspect ratio dips below
  // `earClosed` and recovers above `earOpen` within `windowSec`.
  liveness: {
    enabled: false,
    earClosed: 0.20,
    earOpen: 0.26,
    windowSec: 4,
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
    rosterMaxAgeHours: 24, // boot pulls the site roster when it is empty or older than this
  },
};
