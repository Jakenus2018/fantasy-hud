// US launch sites. Launch Library 2 location IDs drive the API filter; the
// coordinates are a fallback so a site still renders with no launch on the
// books. Locations the API returns that aren't listed here are added at runtime.
export const SITES = [
  { key: 'ksc', ll2: [27], name: 'Kennedy Space Center', short: 'KSC', region: 'Florida', lat: 28.6082, lon: -80.6041, tz: 'America/New_York', match: /kennedy/i },
  { key: 'ccsfs', ll2: [12], name: 'Cape Canaveral SFS', short: 'CCSFS', region: 'Florida', lat: 28.5618, lon: -80.5772, tz: 'America/New_York', match: /cape canaveral/i },
  { key: 'vandenberg', ll2: [11], name: 'Vandenberg SFB', short: 'VSFB', region: 'California', lat: 34.6321, lon: -120.6106, tz: 'America/Los_Angeles', match: /vandenberg/i },
  { key: 'starbase', ll2: [143], name: 'Starbase', short: 'STARBASE', region: 'Texas', lat: 25.9967, lon: -97.1572, tz: 'America/Chicago', match: /starbase|boca chica/i },
  { key: 'wallops', ll2: [21], name: 'Wallops Island', short: 'MARS', region: 'Virginia', lat: 37.8337, lon: -75.4881, tz: 'America/New_York', match: /wallops|mid-atlantic/i },
  { key: 'kodiak', ll2: [25], name: 'Pacific Spaceport Complex', short: 'PSCA', region: 'Alaska', lat: 57.4358, lon: -152.3378, tz: 'America/Anchorage', match: /kodiak|pacific spaceport/i },
  { key: 'westtexas', ll2: [29], name: 'Launch Site One', short: 'LS-1', region: 'West Texas', lat: 31.4229, lon: -104.7571, tz: 'America/Chicago', match: /corn ranch|van horn|west texas|launch site one/i },
];

// Known landing zones (lat, lon). ASDS drone ships sit downrange on the track.
export const LANDING_ZONES = {
  'LZ-1': [28.4858, -80.5428], 'LZ-2': [28.4855, -80.5446], 'LZ-40': [28.5613, -80.5765], 'LZ-39A': [28.6075, -80.6033],
  'LZ-4': [34.6329, -120.6152], 'LZ-5': [34.6329, -120.6152],
};

export const kmBetween = (a, b, c, d) => {
  const R = 6371, r = Math.PI / 180;
  const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

// Local tangent-plane offset (km east, km north) of b from a.
export const enuKm = (lat0, lon0, lat, lon) => {
  const r = Math.PI / 180, R = 6371;
  return { e: (lon - lon0) * r * R * Math.cos(lat0 * r), n: (lat - lat0) * r * R };
};
