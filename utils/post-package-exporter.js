const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const DEFAULT_OUTPUT_ROOT = path.join(__dirname, '..', 'output');

function outputRoot() {
  return process.env.OUTPUT_DIR ? path.resolve(process.env.OUTPUT_DIR) : DEFAULT_OUTPUT_ROOT;
}

function slugify(value, max = 60) {
  return String(value || 'video')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, max)
    .replace(/-+$/, '') || 'video';
}

function normalizeTitle(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function fileExists(filePath) {
  return Boolean(filePath) && fsSync.existsSync(filePath) && fsSync.statSync(filePath).isFile();
}

async function copyIfPresent(source, destination) {
  if (!fileExists(source)) return null;
  await fs.copyFile(source, destination);
  return path.basename(destination);
}

function asTagList(tags) {
  if (Array.isArray(tags)) return tags.map(tag => String(tag).trim()).filter(Boolean);
  if (typeof tags === 'string') return tags.split(',').map(tag => tag.trim()).filter(Boolean);
  return [];
}

function buildChecklist(pkg) {
  const lines = [
    `# ${pkg.title}`,
    '',
    `Package ID: \`${pkg.packageId}\``,
    `Status: **${pkg.readyToPost ? 'Ready to post after your review' : 'NOT ready: fix the blocking issues below first'}**`,
    '',
    '## Files',
    `- Video: ${pkg.files.video || 'missing (no real MP4 was produced; see blocking issues)'}`,
    `- Thumbnail: ${pkg.files.thumbnail || 'missing'}`,
    `- Captions: ${pkg.files.captions || 'none'}`,
    '- Title: title.txt',
    '- Description: description.txt',
    '- Tags: tags.txt (comma-separated, paste into YouTube Studio)',
    ''
  ];

  if (pkg.thumbnailTextOptions.length) {
    lines.push('## Thumbnail text ideas', ...pkg.thumbnailTextOptions.map(text => `- ${text}`), '');
  }

  const blocking = pkg.qualityChecks.filter(check => check.blocking && !check.passed);
  const warnings = pkg.qualityChecks.filter(check => !check.blocking && !check.passed);
  if (blocking.length) {
    lines.push('## Blocking issues', ...blocking.map(check => `- ${check.label || check.id}: ${check.message || ''}`.trim()), '');
  }
  if (warnings.length) {
    lines.push('## Warnings', ...warnings.map(check => `- ${check.label || check.id}: ${check.message || ''}`.trim()), '');
  }

  if (pkg.claimsToVerify.length) {
    lines.push(
      '## Facts to double-check before posting',
      ...pkg.claimsToVerify.map(claim => `- ${claim.text}${claim.riskLevel === 'high' ? ' (high risk)' : ''}`),
      ''
    );
  }

  lines.push(
    '## Before you post',
    '- Watch the whole video once.',
    pkg.claimsToVerify.length ? '- Check the facts listed above.' : '- Spot-check any rankings, numbers, or records stated in the video.',
    '- Set YouTube "Altered or synthetic content" if the video shows realistic AI-generated people, places, or events.',
    '',
    '## After you post',
    `- Keep the title as-is, or add \`${pkg.packageId}\` with the YouTube video ID to analytics/video-map.csv so imported analytics match this package.`,
    ''
  );
  return lines.join('\n');
}

/**
 * Writes a self-contained, ready-to-post folder for one production.
 * `production` accepts either a pipeline productionData object or a db production bundle.
 */
async function exportPostPackage(production, options = {}) {
  const editor = options.editorData || production.editorData || {};
  const seo = production.seo || {};
  const script = production.script || {};
  const strategy = production.strategy || {};
  const assets = production.assets || {};
  const qualityChecks = Array.isArray(options.qualityChecks) ? options.qualityChecks : (production.qualityChecks || []);

  const title = String(editor.title || seo.title || script.title || strategy.topic || 'Untitled video').trim();
  const description = String(editor.description || seo.description || '').trim();
  const tags = asTagList(editor.tags || seo.tags);

  const createdAt = production.created_at || production.createdAt || new Date().toISOString();
  const datePart = new Date(createdAt).toISOString().slice(0, 10);
  const packageId = String(production.id);
  const dirName = `${datePart}_${slugify(title)}_${packageId.slice(-6)}`;
  const root = options.outputRoot || outputRoot();
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });

  const thumbnailVariant = editor.packagingExperiment?.thumbnailVariants?.[editor.selectedThumbnailVariant];
  // A failed AI thumbnail leaves a non-image placeholder; fall back to the designer's template image.
  const thumbnailSource = [thumbnailVariant?.path, assets.thumbnail?.path, production.thumbnail?.path]
    .find(candidate => fileExists(candidate) && IMAGE_EXTENSIONS.has(path.extname(candidate).toLowerCase()));
  const finalVideo = assets.finalVideo || {};
  const realVideo = !finalVideo.simulated && path.extname(finalVideo.path || '').toLowerCase() === '.mp4';

  const files = {
    video: realVideo ? await copyIfPresent(finalVideo.path, path.join(dir, 'video.mp4')) : null,
    thumbnail: thumbnailSource
      ? await copyIfPresent(thumbnailSource, path.join(dir, `thumbnail${path.extname(thumbnailSource).toLowerCase()}`))
      : null,
    captions: await copyIfPresent(assets.captions?.path, path.join(dir, 'captions.srt'))
  };

  const claimsToVerify = (production.provenance?.claims || script.claims || [])
    .filter(claim => claim && claim.text && !['supported', 'waived'].includes(claim.status))
    .map(claim => ({ text: claim.text, riskLevel: claim.riskLevel || claim.risk_level || 'standard' }));

  const blockingFailed = qualityChecks.some(check => check.blocking && !check.passed);
  const pkg = {
    packageId,
    title,
    description,
    tags,
    thumbnailTextOptions: asTagList(seo.thumbnailTextOptions),
    topic: strategy.topic || null,
    angle: strategy.angle || null,
    contentType: strategy.contentType || null,
    targetAudience: strategy.targetAudience || null,
    durationSeconds: finalVideo.duration || production.estimated_duration || production.estimatedDuration || null,
    reviewStatus: options.reviewStatus || production.review_status || null,
    readyToPost: Boolean(files.video) && !blockingFailed,
    qualityChecks: qualityChecks.map(check => ({
      id: check.id, label: check.label, passed: Boolean(check.passed), blocking: Boolean(check.blocking), message: check.message || null
    })),
    claimsToVerify,
    containsSyntheticMedia: production.provenance?.containsSyntheticMedia === true,
    performanceBriefUsed: Boolean(strategy.performanceBrief),
    files,
    createdAt,
    exportedAt: new Date().toISOString()
  };

  await fs.writeFile(path.join(dir, 'title.txt'), `${title}\n`);
  await fs.writeFile(path.join(dir, 'description.txt'), `${description}\n`);
  await fs.writeFile(path.join(dir, 'tags.txt'), `${tags.join(', ')}\n`);
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify(pkg, null, 2));
  await fs.writeFile(path.join(dir, 'CHECKLIST.md'), buildChecklist(pkg));

  return { dir, ...pkg };
}

async function listPostPackages(root = outputRoot()) {
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(root, entry.name, 'metadata.json'), 'utf8'));
      packages.push({ ...meta, dir: path.join(root, entry.name) });
    } catch {
      // Not a package folder.
    }
  }
  return packages.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

module.exports = { exportPostPackage, listPostPackages, normalizeTitle, slugify, outputRoot };
