const fs = require('fs').promises;
const path = require('path');
const { listPostPackages, normalizeTitle } = require('./post-package-exporter');

const DEFAULT_ANALYTICS_ROOT = path.join(__dirname, '..', 'analytics');
const MIN_IMPRESSIONS_FOR_CTR = 100;

// Header aliases cover YouTube Studio "Advanced mode" CSV exports (Table data.csv)
// and the hand-filled analytics/template.csv.
const COLUMN_ALIASES = {
  videoId: ['content', 'video id', 'video_id', 'youtube_video_id', 'youtube id'],
  title: ['video title', 'title', 'video_title'],
  packageId: ['package id', 'package_id'],
  publishedAt: ['video publish time', 'publish time', 'published', 'published_at', 'publish_date', 'date published'],
  durationSec: ['duration', 'duration_seconds', 'video length'],
  views: ['views'],
  watchHours: ['watch time (hours)', 'watch_hours', 'watch time hours'],
  subscribers: ['subscribers', 'subscribers gained', 'net subscribers', 'subs'],
  impressions: ['impressions'],
  ctr: ['impressions click-through rate (%)', 'impressions click-through rate', 'ctr', 'ctr_percent', 'click-through rate (%)'],
  avgViewDurationSec: ['average view duration', 'avg_view_duration', 'avg view duration'],
  avgPercentViewed: ['average percentage viewed (%)', 'average percentage viewed', 'avg_percent_viewed', 'retention_percent', 'avg % viewed'],
  likes: ['likes'],
  comments: ['comments', 'comments added'],
  shares: ['shares'],
  notes: ['notes', 'note']
};

function analyticsRoot() {
  return process.env.ANALYTICS_DIR ? path.resolve(process.env.ANALYTICS_DIR) : DEFAULT_ANALYTICS_ROOT;
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field); field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some(cell => cell.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some(cell => cell.trim() !== '')) rows.push(row);
  return rows;
}

function toNumber(value) {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).replace(/[,%\s]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '—') return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function toSeconds(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (text.includes(':')) {
    return text.split(':').map(Number).reduce((total, part) => total * 60 + (Number.isFinite(part) ? part : 0), 0);
  }
  return toNumber(text);
}

function mapHeaders(headers) {
  const lookup = {};
  headers.forEach((header, index) => {
    const key = String(header).trim().toLowerCase();
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (lookup[field] === undefined && aliases.includes(key)) lookup[field] = index;
    }
  });
  return lookup;
}

function parseAnalyticsCSV(text, sourceFile = 'inline.csv') {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const columns = mapHeaders(rows[0]);
  if (columns.title === undefined && columns.videoId === undefined && columns.packageId === undefined) {
    throw new Error(`${sourceFile}: no "Video title", "Content" (video ID), or "package_id" column found`);
  }
  const cell = (row, field) => (columns[field] === undefined ? undefined : row[columns[field]]);
  const records = [];
  for (const row of rows.slice(1)) {
    const videoId = String(cell(row, 'videoId') || '').trim();
    const title = String(cell(row, 'title') || '').trim();
    const packageId = String(cell(row, 'packageId') || '').trim();
    if (/^total$/i.test(videoId) || /^total$/i.test(title)) continue;
    if (!videoId && !title && !packageId) continue;
    records.push({
      videoId: videoId || null,
      title: title || null,
      packageId: packageId || null,
      publishedAt: String(cell(row, 'publishedAt') || '').trim() || null,
      durationSec: toSeconds(cell(row, 'durationSec')),
      views: toNumber(cell(row, 'views')),
      watchHours: toNumber(cell(row, 'watchHours')),
      subscribers: toNumber(cell(row, 'subscribers')),
      impressions: toNumber(cell(row, 'impressions')),
      ctr: toNumber(cell(row, 'ctr')),
      avgViewDurationSec: toSeconds(cell(row, 'avgViewDurationSec')),
      avgPercentViewed: toNumber(cell(row, 'avgPercentViewed')),
      likes: toNumber(cell(row, 'likes')),
      comments: toNumber(cell(row, 'comments')),
      shares: toNumber(cell(row, 'shares')),
      notes: String(cell(row, 'notes') || '').trim() || null,
      sourceFile
    });
  }
  return records;
}

function recordKey(record) {
  if (record.videoId) return `yt:${record.videoId}`;
  if (record.packageId) return `pkg:${record.packageId}`;
  return `title:${normalizeTitle(record.title)}`;
}

function findExistingKey(videos, record) {
  const title = normalizeTitle(record.title);
  for (const [key, existing] of Object.entries(videos)) {
    if (record.videoId && existing.videoId === record.videoId) return key;
    if (record.packageId && existing.packageId === record.packageId) return key;
    if (title && normalizeTitle(existing.title) === title
      && !(record.videoId && existing.videoId && record.videoId !== existing.videoId)) return key;
  }
  return null;
}

function mergeRecord(existing, incoming) {
  const merged = { ...(existing || {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== null && value !== undefined && value !== '') merged[key] = value;
  }
  return merged;
}

async function readJSON(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function readVideoMap(root) {
  try {
    const records = parseCSV(await fs.readFile(path.join(root, 'video-map.csv'), 'utf8'));
    const headers = records[0].map(header => header.trim().toLowerCase());
    const pkgIndex = headers.indexOf('package_id');
    const ytIndex = headers.indexOf('youtube_video_id');
    if (pkgIndex < 0 || ytIndex < 0) return {};
    const map = {};
    for (const row of records.slice(1)) {
      const packageId = String(row[pkgIndex] || '').trim();
      const videoId = String(row[ytIndex] || '').trim();
      if (packageId && videoId) map[videoId] = packageId;
    }
    return map;
  } catch {
    return {};
  }
}

function linkPackages(records, packages, videoMap) {
  const byId = new Map(packages.map(pkg => [String(pkg.packageId), pkg]));
  const byTitle = new Map(packages.map(pkg => [normalizeTitle(pkg.title), pkg]));
  return records.map(record => {
    const pkg = (record.packageId && byId.get(record.packageId))
      || (record.videoId && videoMap[record.videoId] && byId.get(videoMap[record.videoId]))
      || (record.title && byTitle.get(normalizeTitle(record.title)))
      || null;
    return {
      ...record,
      packageId: pkg ? String(pkg.packageId) : record.packageId || null,
      topic: pkg?.topic || record.topic || null,
      contentType: pkg?.contentType || record.contentType || null
    };
  });
}

function median(values) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value, digits = 1) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

const TITLE_FEATURES = [
  { id: 'number', label: 'a number in the title (e.g. "Top 10")', test: title => /\d/.test(title) },
  { id: 'question', label: 'a question in the title', test: title => /\?/.test(title) },
  { id: 'superlative', label: 'a superlative (best/worst/most/greatest)', test: title => /\b(best|worst|most|least|greatest|biggest|deadliest|strongest)\b/i.test(title) },
  { id: 'ranked', label: 'ranking words (ranked/ranking/tier list)', test: title => /\b(rank(ed|ing)?|tier list|tier)\b/i.test(title) },
  { id: 'short', label: 'short titles (under 50 characters)', test: title => title.length < 50 }
];

function compareFeature(records, feature, metric) {
  const withFeature = records.filter(record => feature.test(record.title || '') && Number.isFinite(record[metric]));
  const without = records.filter(record => !feature.test(record.title || '') && Number.isFinite(record[metric]));
  if (withFeature.length < 2 || without.length < 2) return null;
  const a = median(withFeature.map(record => record[metric]));
  const b = median(without.map(record => record[metric]));
  if (!a || !b || Math.abs(a - b) / Math.max(a, b) < 0.15) return null;
  return { feature: feature.id, label: feature.label, metric, with: round(a), without: round(b), nWith: withFeature.length, nWithout: without.length };
}

function describe(record) {
  return `"${record.title || record.videoId}"`;
}

function buildPerformanceBrief(records, packages = []) {
  const videos = records.filter(record => record.title || record.videoId);
  const ctrEligible = videos.filter(record => Number.isFinite(record.ctr) && (record.impressions ?? MIN_IMPRESSIONS_FOR_CTR) >= MIN_IMPRESSIONS_FOR_CTR);
  const retentionEligible = videos.filter(record => Number.isFinite(record.avgPercentViewed));
  const byViews = videos.filter(record => Number.isFinite(record.views)).sort((a, b) => b.views - a.views);
  const byCtr = [...ctrEligible].sort((a, b) => b.ctr - a.ctr);
  const byRetention = [...retentionEligible].sort((a, b) => b.avgPercentViewed - a.avgPercentViewed);
  const pick = (list, count, fromEnd = false) => (list.length < 2 ? [] : (fromEnd ? list.slice(-count).reverse() : list.slice(0, count)));

  const titlePatterns = TITLE_FEATURES
    .flatMap(feature => [compareFeature(videos, feature, 'ctr'), compareFeature(videos, feature, 'avgPercentViewed')])
    .filter(Boolean);

  const brief = {
    generatedAt: new Date().toISOString(),
    videoCount: videos.length,
    medians: {
      views: median(videos.map(record => record.views)),
      ctr: round(median(ctrEligible.map(record => record.ctr))),
      avgPercentViewed: round(median(retentionEligible.map(record => record.avgPercentViewed))),
      avgViewDurationSec: round(median(videos.map(record => record.avgViewDurationSec)), 0)
    },
    topByViews: pick(byViews, 3),
    topByCtr: pick(byCtr, 3),
    bottomByCtr: pick(byCtr, 2, true),
    topByRetention: pick(byRetention, 3),
    bottomByRetention: pick(byRetention, 2, true),
    titlePatterns,
    operatorNotes: videos.filter(record => record.notes).map(record => ({ title: record.title, notes: record.notes })).slice(0, 8),
    producedTopics: packages.map(pkg => pkg.topic || pkg.title).filter(Boolean).slice(0, 30)
  };
  brief.promptText = formatBriefForPrompt(brief);
  return brief;
}

function formatBriefForPrompt(brief) {
  const lines = [];
  if (brief.videoCount > 0) {
    const m = brief.medians;
    lines.push(`Real YouTube Studio results for ${brief.videoCount} published video(s) on this channel. Channel medians: ${[
      m.views !== null ? `${m.views} views` : null,
      m.ctr !== null ? `${m.ctr}% CTR` : null,
      m.avgPercentViewed !== null ? `${m.avgPercentViewed}% average viewed` : null
    ].filter(Boolean).join(', ') || 'n/a'}.`);
    const list = (label, items, metric, unit) => {
      if (items.length) lines.push(`${label}: ${items.map(item => `${describe(item)} (${item[metric]}${unit})`).join('; ')}.`);
    };
    list('Most viewed', brief.topByViews, 'views', ' views');
    list('Highest CTR (titles/thumbnails that earned clicks)', brief.topByCtr, 'ctr', '%');
    list('Lowest CTR (avoid these packaging patterns)', brief.bottomByCtr, 'ctr', '%');
    list('Best retention (structure/pacing worth repeating)', brief.topByRetention, 'avgPercentViewed', '% viewed');
    list('Weakest retention (avoid this structure)', brief.bottomByRetention, 'avgPercentViewed', '% viewed');
    for (const pattern of brief.titlePatterns) {
      const metric = pattern.metric === 'ctr' ? 'CTR' : 'average % viewed';
      lines.push(`Titles with ${pattern.label}: median ${metric} ${pattern.with} vs ${pattern.without} without (n=${pattern.nWith} vs ${pattern.nWithout}).`);
    }
    for (const note of brief.operatorNotes) lines.push(`Creator note on "${note.title}": ${note.notes}`);
    lines.push('Lean toward topics, title styles, and structures of the strongest videos; avoid patterns of the weakest. Small samples are directional, not proof.');
  }
  if (brief.producedTopics?.length) {
    lines.push(`Already produced (do not repeat the same topic): ${brief.producedTopics.join('; ')}.`);
  }
  return lines.join('\n');
}

function formatInsightsMarkdown(brief, records) {
  const lines = [
    '# Channel performance insights',
    '',
    `Generated ${brief.generatedAt} from ${brief.videoCount} video(s). The pipeline adds the "Prompt brief" section below to every new video's strategy, script, and title/SEO prompts.`,
    '',
    '## Videos',
    '',
    '| Title | Views | Impressions | CTR % | Avg % viewed | Avg view duration (s) | Subs | Package |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...records.map(record => `| ${String(record.title || record.videoId).replace(/\|/g, '/')} | ${record.views ?? ''} | ${record.impressions ?? ''} | ${record.ctr ?? ''} | ${record.avgPercentViewed ?? ''} | ${record.avgViewDurationSec ?? ''} | ${record.subscribers ?? ''} | ${record.packageId ? 'linked' : 'not linked'} |`),
    '',
    '## Prompt brief',
    '',
    brief.promptText || '_No analytics imported yet._',
    ''
  ];
  return lines.join('\n');
}

async function importAnalytics(options = {}) {
  const root = options.root || analyticsRoot();
  const inbox = path.join(root, 'inbox');
  const imported = path.join(root, 'imported');
  await fs.mkdir(inbox, { recursive: true });
  await fs.mkdir(imported, { recursive: true });

  const store = await readJSON(path.join(root, 'performance.json'), { videos: {} });
  // Name order decides which numbers win, so date-prefixed names import oldest first.
  const files = (await fs.readdir(inbox)).filter(name => name.toLowerCase().endsWith('.csv')).sort();
  const results = [];
  for (const name of files) {
    const filePath = path.join(inbox, name);
    const records = parseAnalyticsCSV(await fs.readFile(filePath, 'utf8'), name);
    for (const record of records) {
      const key = findExistingKey(store.videos, record) || recordKey(record);
      const merged = mergeRecord(store.videos[key], { ...record, importedAt: new Date().toISOString() });
      delete store.videos[key];
      store.videos[recordKey(merged)] = merged;
    }
    results.push({ file: name, records: records.length });
    if (options.archive !== false) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await fs.rename(filePath, path.join(imported, `${stamp}_${name}`));
    }
  }

  const packages = await listPostPackages(options.outputRoot);
  const videoMap = await readVideoMap(root);
  const linked = linkPackages(Object.values(store.videos), packages, videoMap);
  const brief = buildPerformanceBrief(linked, packages);
  store.videos = Object.fromEntries(linked.map(record => [recordKey(record), record]));
  store.updatedAt = new Date().toISOString();

  await fs.writeFile(path.join(root, 'performance.json'), JSON.stringify(store, null, 2));
  await fs.writeFile(path.join(root, 'performance-brief.json'), JSON.stringify(brief, null, 2));
  await fs.writeFile(path.join(root, 'insights.md'), formatInsightsMarkdown(brief, linked));
  return { files: results, videoCount: linked.length, linkedCount: linked.filter(record => record.packageId).length, brief };
}

/** Returns prompt text built from imported analytics plus already-produced topics, or null. */
async function loadPerformanceBrief(options = {}) {
  const root = options.root || analyticsRoot();
  const stored = await readJSON(path.join(root, 'performance-brief.json'), null);
  const packages = await listPostPackages(options.outputRoot);
  if (!stored && !packages.length) return null;
  const brief = { ...(stored || { videoCount: 0, medians: {}, topByViews: [], topByCtr: [], bottomByCtr: [], topByRetention: [], bottomByRetention: [], titlePatterns: [], operatorNotes: [] }) };
  brief.producedTopics = packages.map(pkg => pkg.topic || pkg.title).filter(Boolean).slice(0, 30);
  const text = formatBriefForPrompt(brief);
  return text || null;
}

module.exports = {
  parseCSV,
  parseAnalyticsCSV,
  buildPerformanceBrief,
  formatBriefForPrompt,
  importAnalytics,
  loadPerformanceBrief,
  analyticsRoot
};
