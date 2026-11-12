const CONGRESS_START = new Date('2027-01-03T12:00:00-05:00');
const GEOCODER = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer';
const DISTRICTS = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer';
const COUNTRIES = 'USA,PRI,GUM,VIR,ASM,MNP';
const EXAMPLE = '301 W 2nd St, Austin, TX 78701';
const HOUSE_DIRECTORY = 'https://clerk.house.gov/Members';
const SENATE_DIRECTORY = 'https://www.senate.gov/senators/contact/';
const FIPS = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT',
  '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL',
  '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD',
  '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE',
  '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND',
  '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV',
  '55': 'WI', '56': 'WY', '60': 'AS', '66': 'GU', '69': 'MP', '72': 'PR', '78': 'VI',
};
const TERRITORIES = new Set(['AS', 'DC', 'GU', 'MP', 'PR', 'VI']);
const US_REGION = new Intl.DisplayNames('en-US', { type: 'region' });
const ORDINAL = new Intl.PluralRules('en-US', { type: 'ordinal' });
const easternDate = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
});
const form = document.querySelector('#address-form');
const address = document.querySelector('#address');
const listbox = document.querySelector('#suggestions');
const submit = form.querySelector('button[type="submit"]');
const example = document.querySelector('#example');
const status = document.querySelector('#lookup-status');
const results = document.querySelector('#results');

let suggestions = [];
let highlighted = -1;
let selected = null;
let suggestionTimer;
let suggestionRequest;
let lookupRequest;
let dataRequest;

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content) node.textContent = content;
  return node;
}

function icon(id) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const use = document.createElementNS(ns, 'use');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', '#' + id);
  svg.append(use);
  return svg;
}

function link(label, href, image = 'external') {
  if (!href) return null;
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!['https:', 'tel:'].includes(url.protocol)) return null;
  const node = element('a', '', label);
  node.href = url.href;
  if (image) node.prepend(icon(image), ' ');
  return node;
}

function tick() {
  const secondsLeft = Math.max(0, Math.ceil((CONGRESS_START - Date.now()) / 1000));
  const units = {
    days: Math.floor(secondsLeft / 86400),
    hours: Math.floor(secondsLeft / 3600) % 24,
    minutes: Math.floor(secondsLeft / 60) % 60,
    seconds: secondsLeft % 60,
  };
  for (const [unit, value] of Object.entries(units)) {
    const display = document.querySelector(`[data-time="${unit}"]`);
    const text = String(value).padStart(2, '0');
    if (display.textContent !== text) display.textContent = text;
  }
  if (secondsLeft === 0) {
    document.querySelector('#hero-emphasis').textContent = 'has begun.';
    document.querySelector('.countdown').hidden = true;
  }
  return secondsLeft > 0;
}

if (tick()) {
  const timer = setInterval(() => {
    if (!tick()) clearInterval(timer);
  }, 250);
}

function queryUrl(base, params) {
  const url = new URL(base);
  url.search = new URLSearchParams(params);
  return url;
}

async function fetchJson(url, signal) {
  const timeout = AbortSignal.timeout(12000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(url, { signal: requestSignal });
  if (!response.ok) throw new Error('Request failed');
  const payload = await response.json();
  if (payload.error) throw new Error('Service returned an error');
  return payload;
}

function loadData() {
  if (!dataRequest) {
    dataRequest = fetchJson(new URL('./data/congress.json', import.meta.url)).catch(error => {
      dataRequest = null;
      throw error;
    });
  }
  return dataRequest;
}

function closeSuggestions() {
  clearTimeout(suggestionTimer);
  suggestionRequest?.abort();
  suggestions = [];
  highlighted = -1;
  listbox.replaceChildren();
  listbox.hidden = true;
  address.setAttribute('aria-expanded', 'false');
  address.removeAttribute('aria-activedescendant');
}

function openSuggestions(items) {
  suggestions = items;
  highlighted = -1;
  const nodes = items.map((item, index) => {
    const node = element('li', '', item.text);
    node.id = 'address-option-' + index;
    node.dataset.index = index;
    node.setAttribute('role', 'option');
    node.setAttribute('aria-selected', 'false');
    return node;
  });
  listbox.replaceChildren(...nodes);
  listbox.hidden = nodes.length === 0;
  address.setAttribute('aria-expanded', String(nodes.length > 0));
}

function chooseSuggestion(index) {
  selected = suggestions[index];
  address.value = selected.text;
  closeSuggestions();
  address.focus();
}

function moveHighlight(direction) {
  highlighted = highlighted < 0
    ? (direction > 0 ? 0 : suggestions.length - 1)
    : (highlighted + direction + suggestions.length) % suggestions.length;
  for (const [index, node] of Array.from(listbox.children).entries()) {
    node.setAttribute('aria-selected', String(index === highlighted));
  }
  address.setAttribute('aria-activedescendant', listbox.children[highlighted].id);
}

async function suggest(text) {
  const request = new AbortController();
  suggestionRequest = request;
  try {
    const url = queryUrl(GEOCODER + '/suggest', {
      text, countryCode: COUNTRIES, category: 'Address', maxSuggestions: '5', f: 'json',
    });
    const payload = await fetchJson(url, request.signal);
    if (request.signal.aborted || document.activeElement !== address || address.value.trim() !== text) return;
    const matches = (payload.suggestions || []).filter(item => !item.isCollection && item.magicKey);
    openSuggestions(matches);
  } catch {
    // Manual address entry remains available if suggestions time out.
  }
}

address.addEventListener('input', () => {
  selected = null;
  closeSuggestions();
  showStatus('');
  const text = address.value.trim();
  if (text.length >= 6) suggestionTimer = setTimeout(() => suggest(text), 300);
});

address.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    closeSuggestions();
    return;
  }
  if (!suggestions.length) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
  }
  if (event.key === 'Enter' && highlighted >= 0) {
    event.preventDefault();
    chooseSuggestion(highlighted);
  }
});

address.addEventListener('blur', closeSuggestions);
listbox.addEventListener('pointerdown', event => event.preventDefault());
listbox.addEventListener('click', event => {
  const option = event.target.closest('[role="option"]');
  if (option) chooseSuggestion(Number(option.dataset.index));
});

class LookupError extends Error {}

async function geocode(text, selection, signal) {
  if (selection?.point) return selection.point;
  const url = queryUrl(GEOCODER + '/findAddressCandidates', {
    SingleLine: text, sourceCountry: COUNTRIES, category: 'Address', maxLocations: '5',
    outFields: 'Addr_type,City,RegionAbbr', forStorage: 'false', f: 'json',
    ...(selection?.magicKey ? { magicKey: selection.magicKey } : {}),
  });
  const payload = await fetchJson(url, signal);
  const streetTypes = new Set(['PointAddress', 'Subaddress', 'StreetAddress']);
  const candidates = (payload.candidates || []).filter(candidate =>
    candidate.score >= 90 && streetTypes.has(candidate.attributes?.Addr_type) &&
    Number.isFinite(candidate.location?.x) && Number.isFinite(candidate.location?.y));
  if (!candidates.length) {
    throw new LookupError('We couldn’t match that street address. Include the house number, city, and state or ZIP code.');
  }
  const [best] = candidates;
  const similar = candidates.filter(candidate => best.score - candidate.score <= 1);
  const alternatives = Array.from(new Map(similar.map(candidate => [candidate.address, candidate])).values());
  if (!selection && alternatives.length > 1) {
    return { alternatives: alternatives.map(point => ({ text: point.address, point })) };
  }
  return best;
}

async function districtFor(point, session, signal) {
  const layer = session === 119 ? 4 : 0;
  const url = queryUrl(`${DISTRICTS}/${layer}/query`, {
    f: 'json', geometry: `${point.location.x},${point.location.y}`,
    geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    returnGeometry: 'false', outFields: 'STATE,CDSESSN,GEOID',
  });
  const payload = await fetchJson(url, signal);
  const attributes = payload.features?.[0]?.attributes;
  const state = FIPS[attributes?.STATE];
  if (payload.features?.length !== 1 || !state || Number(attributes.CDSESSN) !== session) {
    throw new LookupError('We couldn’t verify a single congressional district for that address. Double-check the address or try a nearby street number.');
  }
  return { state, number: TERRITORIES.has(state) ? 0 : Number(attributes.GEOID.slice(2)) };
}

function showStatus(message, isError = false) {
  status.textContent = message;
  status.hidden = !message;
  status.classList.toggle('error', isError);
}

function districtName(district) {
  if (district.number === 0) return 'At-large district';
  const suffix = { one: 'st', two: 'nd', few: 'rd', other: 'th' }[ORDINAL.select(district.number)];
  return `${district.number}${suffix} district`;
}

function stateName(state) {
  if (state === 'DC') return 'Washington, D.C.';
  if (TERRITORIES.has(state)) return US_REGION.of(state);
  // Intl.DisplayNames accepts regions, so derive U.S. subdivision names from a local table.
  return ({
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
    CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
    HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
    KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
    MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
    MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
    NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
    OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
    SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
    VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  })[state];
}

function houseRole(state) {
  if (state === 'PR') return 'Resident commissioner';
  return TERRITORIES.has(state) ? 'U.S. House delegate' : 'U.S. House';
}

function congressionalSeats(district, data) {
  const state = district.state;
  const seats = [{
    chamber: 'house', key: state + '-' + String(district.number).padStart(2, '0'),
    label: houseRole(state) + ' · ' + districtName(district),
  }];
  if (TERRITORIES.has(state)) return seats;
  for (const classNumber of [1, 2, 3]) {
    const key = state + '-' + classNumber;
    if (data.roster.senate[key] || data.elections.senate[key] || data.active?.senate[key]) {
      seats.push({ chamber: 'senate', key, label: 'U.S. Senate · Class ' + ['I', 'II', 'III'][classNumber - 1] });
    }
  }
  return seats;
}

function contactLinks(office, chamber) {
  if (!office) return [];
  const number = office.phone?.replace(/[^\d+]/g, '');
  return [
    link(office.phone, number ? 'tel:' + number : null, 'phone'),
    link('Contact form', office.contact !== office.website ? office.contact : null, 'mail'),
    link('Official website', office.website),
    !office.website ? link(chamber === 'house' ? 'House directory' : 'Senate directory',
      chamber === 'house' ? HOUSE_DIRECTORY : SENATE_DIRECTORY) : null,
  ];
}

function seatCard(seat, name, detail, links = [], officeAddress) {
  const card = element('div', 'seat');
  card.append(element('p', 'seat-label', seat.label), element('strong', 'seat-name', name));
  if (detail) card.append(element('p', 'seat-detail', detail));
  if (officeAddress) card.append(element('p', 'seat-detail', officeAddress));
  const usableLinks = links.filter(Boolean);
  if (usableLinks.length) {
    const row = element('div', 'seat-links');
    row.append(...usableLinks);
    card.append(row);
  }
  return card;
}

function servingCard(seat, office, historical) {
  if (!office?.name || office.vacant) {
    const phone = office?.phone?.replace(/\D/g, '');
    return seatCard(seat, office?.vacant ? 'Vacant seat' : 'Officeholder unavailable',
      office?.vacant ? (historical ? 'Vacant when this roster was recorded.' : 'The district office can still assist constituents.') : '',
      [!historical && phone ? link(office.phone, 'tel:' + phone, 'phone') : null,
        link(seat.chamber === 'house' ? 'House directory' : 'Senate directory',
          seat.chamber === 'house' ? HOUSE_DIRECTORY : SENATE_DIRECTORY)]);
  }
  return seatCard(seat, office.name, office.party, historical ? [] : contactLinks(office, seat.chamber),
    historical ? null : office.address);
}

function upcomingCard(seat, data, termStarted) {
  const race = data.elections[seat.chamber][seat.key];
  const office = data.roster[seat.chamber][seat.key];
  const seated = data.active?.[seat.chamber]?.[seat.key];
  if (seated) return servingCard(seat, seated, false);
  if (!race && office?.name) {
    return seatCard(seat, office.name, [office.party, 'Term continues'].filter(Boolean).join(' · '),
      contactLinks(office, seat.chamber), office.address);
  }
  if (!race || race.status !== 'called') {
    const runoff = race?.status === 'runoff';
    return seatCard(seat, runoff ? 'Runoff election' : 'Race not yet called',
      runoff && race.runoffDate
        ? easternDate.format(new Date(race.runoffDate + 'T12:00:00-05:00'))
        : 'An incoming member will appear once a winner is reported.',
      [link('Election results', race?.source || 'https://civicapi.org/')]);
  }
  const outcome = termStarted ? '2026 race called' : race.sameSeat ? 'Won reelection' : 'Race called';
  return seatCard(seat, race.name, [race.party, outcome].filter(Boolean).join(' · '),
    [...contactLinks(race.office, seat.chamber), link('Campaign website', race.campaign),
      !race.campaign ? link('Candidate profile', race.profile) : null, link('Election results', race.source)],
    race.office?.address);
}

function render(point, current, upcoming, data) {
  const termStarted = Date.now() >= CONGRESS_START.getTime();
  const title = element('h2', '', 'Your congressional delegation');
  title.id = 'results-title';
  title.tabIndex = -1;
  const location = element('p', 'results-location', point.address);
  const panels = element('div', 'results-grid');
  const previousPanel = element('div', 'delegation');
  const upcomingPanel = element('div', 'delegation upcoming');
  previousPanel.append(
    element('p', 'eyebrow', termStarted ? 'PREVIOUS TERM' : 'IN OFFICE NOW'),
    element('h3', '', '119th Congress'),
    ...congressionalSeats(current, data).map(seat =>
      servingCard(seat, data.roster[seat.chamber][seat.key], termStarted)),
  );
  upcomingPanel.append(
    element('p', 'eyebrow', termStarted ? 'TERM BEGAN JANUARY 3, 2027' : 'TERMS BEGIN JANUARY 3, 2027'),
    element('h3', '', '120th Congress'),
    ...congressionalSeats(upcoming, data).map(seat => upcomingCard(seat, data, termStarted)),
  );
  panels.append(previousPanel, upcomingPanel);
  results.replaceChildren(title, location);
  if (current.number !== upcoming.number) {
    results.append(element('p', 'results-note',
      `Your House district changed from the ${districtName(current)} to the ${districtName(upcoming)} in ${stateName(current.state)}.`));
  }
  if (TERRITORIES.has(current.state)) {
    results.append(element('p', 'results-note', `${stateName(current.state)} has a non-voting House member and no U.S. senators.`));
  }
  const source = element('p', 'results-source',
    `Election results checked ${easternDate.format(new Date(data.checkedAt))}. Race calls can precede state certification. `);
  source.append(link('Data sources', 'https://civicapi.org/'));
  results.append(panels, source);
  results.hidden = false;
  title.focus({ preventScroll: true });
  results.scrollIntoView({ block: 'start' });
}

async function lookup() {
  const value = address.value.trim();
  if (!value) return;
  const selection = selected?.text === value ? selected : null;
  closeSuggestions();
  lookupRequest?.abort();
  const request = new AbortController();
  lookupRequest = request;
  submit.disabled = true;
  results.hidden = true;
  showStatus('Looking up your address and congressional districts…');
  try {
    const [point, data] = await Promise.all([geocode(value, selection, request.signal), loadData()]);
    if (request.signal.aborted) return;
    if (point.alternatives) {
      showStatus('Choose the address you meant from the suggestions, then select Find my reps.');
      address.focus();
      openSuggestions(point.alternatives);
      return;
    }
    const current = await districtFor(point, 119, request.signal);
    // Missouri used the 2022 lines for the general election. TIGERweb's 120th layer can show the later plan.
    const upcoming = current.state === 'MO' ? current : await districtFor(point, 120, request.signal);
    if (request.signal.aborted) return;
    if (current.state !== upcoming.state) {
      throw new LookupError('We couldn’t verify the same state in both congressional maps. Double-check the address and try again.');
    }
    showStatus('');
    render(point, current, upcoming, data);
  } catch (error) {
    if (!request.signal.aborted) {
      showStatus(error instanceof LookupError ? error.message :
        'The lookup service is temporarily unavailable. Try again in a moment.', true);
    }
  } finally {
    if (lookupRequest === request) submit.disabled = false;
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  lookup();
});

example.addEventListener('click', () => {
  selected = null;
  address.value = EXAMPLE;
  lookup();
});

document.querySelector('nav a[href="#sources"]').addEventListener('click', () => {
  document.querySelector('#sources details').open = true;
});
