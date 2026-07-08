// scripts/fetch-roblox-stats.mjs
//
// Fetches visits / active players / creation date for every game listed in
// data/games.json, and writes the results to data/game-stats.json.
//
// This is meant to run OFFLINE (your machine, or a GitHub Actions runner),
// NOT in the browser — that's what avoids the CORS block and (mostly)
// avoids Roblox's anti-bot IP blocking that hits persistent cloud proxies
// like Cloudflare Workers.
//
// Run locally with:   node scripts/fetch-roblox-stats.mjs
// Requires Node 18+ (for built-in fetch).

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAMES_PATH = path.join(__dirname, '..', 'data', 'games.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'game-stats.json');

const BROWSER_HEADERS = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Referer: 'https://www.roblox.com/',
  Origin: 'https://www.roblox.com'
};

function extractPlaceId(url) {
  const match = url.match(/\/games\/(\d+)/);
  return match ? match[1] : null;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function main() {
  const games = JSON.parse(await readFile(GAMES_PATH, 'utf-8'));
  const placeIds = games.map(g => extractPlaceId(g.url)).filter(Boolean);

  console.log(`Fetching stats for ${placeIds.length} games...`);

  // Step 1: resolve universeId for every placeId, batched.
  const placeIdToUniverse = {};
  for (const batch of chunkArray(placeIds, 50)) {
    try {
      const data = await fetchJSON(
        `https://games.roblox.com/v1/games/multiget-place-details?placeIds=${batch.join(',')}`
      );
      if (!Array.isArray(data)) throw new Error('unexpected shape: ' + JSON.stringify(data).slice(0, 200));
      data.forEach(p => {
        placeIdToUniverse[p.placeId] = p.universeId;
      });
    } catch (err) {
      console.error('Failed to resolve a batch of universe IDs:', err.message);
    }
    // Be polite / avoid rate limits between batches.
    await new Promise(r => setTimeout(r, 300));
  }

  // Step 2: fetch visits/actives/created for every universeId, batched.
  const universeIds = Object.values(placeIdToUniverse).filter(Boolean);
  const universeToStats = {};
  for (const batch of chunkArray(universeIds, 50)) {
    try {
      const data = await fetchJSON(`https://games.roblox.com/v1/games?universeIds=${batch.join(',')}`);
      if (!data || !Array.isArray(data.data)) throw new Error('unexpected shape: ' + JSON.stringify(data).slice(0, 200));
      data.data.forEach(g => {
        universeToStats[g.id] = g;
      });
    } catch (err) {
      console.error('Failed to fetch a batch of game stats:', err.message);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Step 3: map back onto placeId keys.
  const stats = {};
  placeIds.forEach(pid => {
    const uid = placeIdToUniverse[pid];
    const s = uid ? universeToStats[uid] : null;
    if (s) {
      stats[pid] = { visits: s.visits, playing: s.playing, created: s.created };
    }
  });

  const gotCount = Object.keys(stats).length;
  console.log(`Got stats for ${gotCount} / ${placeIds.length} games.`);

  if (gotCount === 0) {
    console.error('Got zero results — Roblox likely blocked this run. Keeping the previous game-stats.json untouched.');
    process.exitCode = 1;
    return;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    stats
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log('Wrote', OUTPUT_PATH);
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exitCode = 1;
});
