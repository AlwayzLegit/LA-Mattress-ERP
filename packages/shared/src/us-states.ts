/**
 * US state / territory names → USPS codes. Addresses are typed by hand
 * ("MO", "Mo.", "missouri"), so anything that compares two states runs
 * both through `stateCode` first.
 */
const STATES: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  PR: 'Puerto Rico',
  GU: 'Guam',
  VI: 'Virgin Islands',
  AS: 'American Samoa',
  MP: 'Northern Mariana Islands',
};

const BY_NAME = new Map(
  Object.entries(STATES).map(([code, name]) => [name.toLowerCase().replace(/[^a-z]/g, ''), code]),
);

/** 'MO' for "MO", "mo.", "Missouri"; null when blank or not a US state. */
export function stateCode(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  const letters = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (letters.length === 2) {
    const code = letters.toUpperCase();
    return code in STATES ? code : null;
  }
  return BY_NAME.get(letters) ?? null;
}
