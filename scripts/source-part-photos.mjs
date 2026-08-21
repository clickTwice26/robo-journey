/**
 * Find real photographs of the parts, from somewhere it is legal to take them from.
 *
 * Only Wikimedia Commons, and only files whose licence the API reports as a free one. That is not
 * squeamishness: this app gets deployed, and a retailer's product photo bundled into it is a
 * takedown notice addressed to whoever deployed it. Commons is the one large source that publishes
 * machine-readable licence metadata, which means each choice here can be *verified* rather than
 * assumed -- and the attribution the licence requires can be captured at the same time.
 *
 *   node scripts/source-part-photos.mjs            # search and report, download nothing
 *   node scripts/source-part-photos.mjs --write    # download the accepted ones
 *
 * Searches are curated per part rather than derived from its name. A search for "7805 voltage
 * regulator" returns a photograph of a telephone controller board that happens to have one on it,
 * which is worse than no photograph: it is a picture of the wrong thing presented as the right one.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const API = 'https://commons.wikimedia.org/w/api.php';
const OUT_DIR = new URL('../apps/studio/public/parts/', import.meta.url);
const CREDITS = new URL('../apps/studio/src/part-photos.json', import.meta.url);

/**
 * Licences that may be bundled into something that ships.
 *
 * Attribution-required ones are fine -- the app shows the credit -- but anything non-commercial,
 * no-derivatives, or merely "fair use" is not, however good the photograph.
 */
const FREE = [
  /^CC0/i,
  /^Public domain/i,
  /^CC BY \d/i,
  /^CC BY-SA \d/i,
  /^CC SA \d/i,
  /^GFDL/i,
];

const isFree = (licence) => FREE.some((re) => re.test(licence ?? ''));

/**
 * What to look for, per part.
 *
 * Written as the phrase that finds a photograph *of the part on its own*, which is usually the
 * part number rather than what the part is for.
 */
const QUERIES = {
  resistor: 'through hole resistor carbon film',
  led: 'LED 5mm',
  pushbutton: 'tactile switch momentary',
  'photoresistor': 'photoresistor light dependent resistor',
  'thermistor-10k': 'NTC thermistor',
  'cap-100nf': 'ceramic capacitor disc',
  'cap-100uf': 'electrolytic capacitor',
  'potentiometer-10k': 'trimmer potentiometer',
  '2n2222': '2N2222 transistor',
  bc547: 'BC547 transistor',
  '2n3904': '2N3904 transistor',
  '2n7000': '2N7000 MOSFET',
  irlz44n: 'TO-220 MOSFET transistor package',
  lm358: 'DIP-8 integrated circuit package',
  '1n4148': '1N4148 diode',
  '1n4007': '1N4007 rectifier diode',
  lm7805: 'L7805CV TO-220 regulator',
  lm7809: '7809 voltage regulator',
  'ams1117-33': 'AMS1117 regulator SOT-223',
  sn74hc595: '74HC595 shift register',
  'hc-sr04': 'HC-SR04 ultrasonic sensor',
  'hc-sr501': 'HC-SR501 PIR motion sensor',
  sg90: 'SG90 servo motor',
  'buzzer-active': 'piezo buzzer electronic',
  'buzzer-passive': 'piezoelectric buzzer disc',
  'relay-5v': 'relay module arduino',
  'dc-motor': 'small DC motor toy',
  'vibration-motor': 'vibration motor coin',
  'seven-segment': 'seven segment display single digit',
  'rgb-led': 'RGB LED 5mm',
  mpu6050: 'MPU-6050 module',
  ds3231: 'DS3231 real time clock module',
  ssd1306: 'SSD1306 OLED display module',
  'lcd1602-i2c': 'LCD 1602 character display',
  max7219: 'MAX7219 LED matrix module',
  adxl345: 'ADXL345 accelerometer module',
  bmp280: 'BMP280 sensor module',
  ads1115: 'ADS1115 module',
  'a3144': 'hall effect sensor TO-92',
  'reed-switch': 'reed switch',
  'soil-moisture': 'soil moisture sensor',
  mq2: 'MQ-2 gas sensor',
  'flame-sensor': 'flame sensor module infrared',
  'sound-sensor': 'electret microphone module',
  'vibration-sensor': 'SW-420 vibration sensor',
  tmp36: 'TMP36 temperature sensor',
  lm35: 'LM35 temperature sensor',
  'battery-9v': '9 volt battery PP3',
  'battery-aa-4': 'AA battery holder four',
  'lipo-1s': 'lithium polymer battery cell',
  'usb-5v': 'USB power adapter charger',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One request, politely.
 *
 * Commons rate-limits scripts and is right to. A 429 is answered by waiting as long as it asks
 * rather than by retrying immediately, and there is a floor between every request regardless --
 * being throttled is the API saying the script is behaving badly, not an error to route around.
 */
async function api(params, attempt = 0) {
  const url = new URL(API);
  for (const [k, v] of Object.entries({ format: 'json', origin: '*', ...params })) {
    url.searchParams.set(k, String(v));
  }
  const response = await fetch(url, {
    headers: { 'User-Agent': 'robo-journey/0.1 (part photo sourcing; contact via repository)' },
  });

  if (response.status === 429 && attempt < 4) {
    const wait = Number(response.headers.get('retry-after')) || (attempt + 1) * 8;
    console.log(`  (throttled — waiting ${wait}s)`);
    await sleep(wait * 1000);
    return api(params, attempt + 1);
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

/** Strip the HTML Commons puts in attribution fields. */
const plain = (html) =>
  (html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Titles that are not a photograph of the part as you would meet it.
 *
 * Commons has a beautiful series of cross-sections and die shots, and they are exactly wrong here:
 * somebody looking at this panel wants to recognise the thing in a drawer, not see inside it.
 */
const NOT_A_PORTRAIT =
  /cross.?section|\bdie\b|internal|decap|x-?ray|schematic|diagram|symbol|circuit board|motherboard|pinout|graph|chart|logo/i;

async function candidates(query) {
  const data = await api({
    action: 'query',
    generator: 'search',
    gsrnamespace: 6,
    gsrlimit: 8,
    gsrsearch: `${query} filetype:bitmap`,
    prop: 'imageinfo',
    iiprop: 'url|extmetadata|size',
    iiurlwidth: 480,
  });

  const pages = Object.values(data?.query?.pages ?? {});
  // Search order is relevance; within that, prefer what Commons has assessed as a quality image.
  pages.sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
  const scored = pages.map((p) => ({
    page: p,
    quality: /quality|featured/i.test(p.imageinfo?.[0]?.extmetadata?.Assessments?.value ?? ''),
    // A weak signal that turns out to be a strong one: on Commons a photograph is almost always a
    // JPEG and a labelled diagram is almost always a PNG. It is not a rule, which is why the
    // candidates are still read by a person before any of them is chosen.
    photo: /\.jpe?g$/i.test(p.title),
  }));
  scored.sort(
    (a, b) => Number(b.photo) - Number(a.photo) || Number(b.quality) - Number(a.quality),
  );

  const out = [];
  for (const { page, quality } of scored) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    const meta = info.extmetadata ?? {};
    const licence = plain(meta.LicenseShortName?.value);
    if (!isFree(licence)) continue;
    if (/\.svg$/i.test(page.title)) continue;
    if (NOT_A_PORTRAIT.test(page.title)) continue;

    out.push({
      title: page.title.replace(/^File:/, ''),
      licence,
      licenceUrl: plain(meta.LicenseUrl?.value) || null,
      artist: plain(meta.Artist?.value) || 'Unknown',
      descriptionUrl: info.descriptionurl,
      thumbUrl: info.thumburl,
      quality,
    });
  }
  return out;
}

/** One named file, for a choice already made. */
async function byTitle(title) {
  const data = await api({
    action: 'query',
    titles: `File:${title}`,
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: 480,
  });
  const page = Object.values(data?.query?.pages ?? {})[0];
  const info = page?.imageinfo?.[0];
  if (!info) return null;
  const meta = info.extmetadata ?? {};
  const licence = plain(meta.LicenseShortName?.value);
  if (!isFree(licence)) return null;
  return {
    title,
    licence,
    licenceUrl: plain(meta.LicenseUrl?.value) || null,
    artist: plain(meta.Artist?.value) || 'Unknown',
    descriptionUrl: info.descriptionurl,
    thumbUrl: info.thumburl,
  };
}

const write = process.argv.includes('--write');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const from = Number(process.argv.find((a) => a.startsWith('--from='))?.slice(7) ?? 0);
const count = Number(process.argv.find((a) => a.startsWith('--count='))?.slice(8) ?? 999);

/**
 * The choices, once made.
 *
 * A part appears here only when a human has looked at the candidate list and confirmed the file is
 * a photograph of that part. Everything not listed falls back to the drawn illustration, which is
 * a better outcome than a confident picture of the wrong component.
 */
const PICKS = JSON.parse(
  await import('node:fs/promises')
    .then((fs) => fs.readFile(new URL('./part-photo-picks.json', import.meta.url), 'utf8'))
    .catch(() => '{}'),
);

if (!write) {
  // Report mode: show what is available so the picks can be made by looking.
  const entries = Object.entries(QUERIES)
    .filter(([id]) => !only || id === only)
    .slice(from, from + count);

  for (const [id, query] of entries) {
    console.log(`\n${id}  ${PICKS[id] ? '(picked: ' + PICKS[id] + ')' : ''}`);
    let list = [];
    try {
      list = await candidates(query);
    } catch (error) {
      console.log(`  error: ${error.message}`);
      continue;
    }
    if (list.length === 0) console.log('  — nothing freely licensed');
    for (const c of list.slice(0, 4)) {
      console.log(`  ${c.quality ? '★' : ' '} ${c.licence.padEnd(13)} ${c.title}`);
    }
    await sleep(1200);
  }
  process.exit(0);
}

// Write mode: fetch exactly what was picked. No searching, no guessing.
const found = {};
for (const [id, title] of Object.entries(PICKS)) {
  process.stdout.write(`${id.padEnd(20)}`);
  let photo;
  try {
    photo = await byTitle(title);
  } catch (error) {
    console.log(`error: ${error.message}`);
    continue;
  }
  if (!photo) {
    console.log(`— "${title}" is missing or not freely licensed`);
    continue;
  }

  await mkdir(OUT_DIR, { recursive: true });
  const file = new URL(`${id}.jpg`, OUT_DIR);
  const response = await fetch(photo.thumbUrl, {
    headers: { 'User-Agent': 'robo-journey/0.1 (part photo sourcing)' },
  });
  if (!response.ok) {
    console.log(`download failed: ${response.status}`);
    continue;
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  found[id] = { ...photo, file: `/parts/${id}.jpg` };
  console.log(`${photo.licence.padEnd(14)} ${title.slice(0, 50)}`);
  await sleep(900);
}

const credits = Object.fromEntries(
  Object.entries(found).map(([id, p]) => [
    id,
    {
      file: p.file,
      title: p.title,
      artist: p.artist,
      licence: p.licence,
      licenceUrl: p.licenceUrl,
      source: p.descriptionUrl,
    },
  ]),
);
await writeFile(CREDITS, `${JSON.stringify(credits, null, 2)}\n`);
console.log(`\n${Object.keys(found).length} photographs, credits written to ${CREDITS.pathname}`);
