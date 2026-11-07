#!/usr/bin/env node
// Download files from a BloxClips footage library (footage.bloxclips.com/<campaign>). Both the site and
// files.bloxclips.com sit behind a Cloudflare challenge that rejects curl and Playwright's request API,
// so every file is fetched with fetch() inside a real, headed Chrome page on the library site.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[value.slice(2)] = true;
      else { args[value.slice(2)] = next; i++; }
    } else args._.push(value);
  }
  return args;
}

async function openBrowser(profile) {
  const options = { headless: false, viewport: { width: 1280, height: 860 }, args: ['--disable-blink-features=AutomationControlled'] };
  if (process.env.CHROME_PATH) options.executablePath = process.env.CHROME_PATH;
  else options.channel = 'chrome';
  return chromium.launchPersistentContext(profile, options);
}

async function fetchInPage(page, url) {
  const result = await page.evaluate(async u => {
    const response = await fetch(u);
    if (!response.ok) return { status: response.status };
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { status: response.status, data: globalThis.btoa(binary) };
  }, url);
  if (!result.data) throw new Error(`HTTP ${result.status} for ${url}`);
  return Buffer.from(result.data, 'base64');
}

async function captureRobloxCard(context, gameUrl, out) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1024, height: 688 });
  await page.goto(gameUrl, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const shot = out.replace(/\.png$/, '-page.png');
  await page.screenshot({ path: shot });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', shot, '-vf',
    'crop=iw*0.775:ih*0.45:iw*0.103:ih*0.06,scale=900:-2,pad=iw+16:ih+16:8:8:white', out]);
  console.log(`saved Roblox page card ${out}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [campaign, outDir] = args._;
  if (!campaign || !outDir) {
    console.log(`Usage: node scripts/clips/fetch-bloxclips.js <campaign-slug> <out-dir> [--ids ID,ID] [--folders "Music,Sound effects"] [--manifest-only] [--card ROBLOX_GAME_URL]
  Writes <out-dir>/manifest.json and the selected files, flat, under <out-dir>.
  Set CHROME_PATH if Google Chrome is not installed in the default location.`);
    process.exitCode = campaign ? 1 : 0;
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const context = await openBrowser(path.join(outDir, '.chrome-profile'));
  try {
    const page = context.pages()[0] || await context.newPage();
    const manifestPromise = page.waitForResponse(r => r.url().includes(`/camp/${campaign}.json`), { timeout: 60000 });
    await page.goto(`https://footage.bloxclips.com/${campaign}#/footage`, { waitUntil: 'domcontentloaded' });
    const manifest = await (await manifestPromise).json();
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
    const folders = Object.fromEntries(manifest.folders.map(f => [f.id, f.name]));
    console.log(`${manifest.files.length} files in ${campaign}`);

    if (args.card) await captureRobloxCard(context, args.card, path.join(outDir, 'roblox-card.png'));
    if (args['manifest-only']) return;

    const ids = args.ids ? new Set(String(args.ids).split(',')) : null;
    const wantedFolders = args.folders ? new Set(String(args.folders).split(',').map(s => s.trim())) : null;
    const files = manifest.files.filter(f => (ids && ids.has(f.id)) || (wantedFolders && wantedFolders.has(folders[f.folder])) || (!ids && !wantedFolders));
    for (const file of files) {
      const out = path.join(outDir, path.basename(file.url));
      if (fs.existsSync(out)) continue;
      fs.writeFileSync(out, await fetchInPage(page, `https://files.bloxclips.com/${encodeURI(file.url)}`));
      console.log(`saved ${out}`);
    }
  } finally {
    await context.close();
  }
}

main().catch(error => { console.error(error.message); process.exit(1); });
