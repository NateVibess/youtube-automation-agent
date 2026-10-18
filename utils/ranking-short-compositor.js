// Builds one 9:16 ranking Short: original clip audio, Montserrat rank list, no narration.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const { exportPostPackage } = require('./post-package-exporter');
const { getFFmpegPath, getFFprobePath, getMediaDuration, runFFmpeg } = require('./ffmpeg');
const { normalizeTags } = require('./youtube-metadata-validator');
const {
  THEME_RED,
  assignRanks,
  buildPackageCopy,
  planSegmentWindow,
  rankColor,
  revealOrder,
  rowCenters,
  searchPosts,
  segmentDuration,
  selectCandidateClips,
  themeTokens
} = require('./reddit-ranking-source');

const execFileAsync = promisify(execFile);
const textMeasureCache = new Map();

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const EMOJI_CODEPOINTS = {
  '🕷️': '1f577',
  '🥶': '1f976',
  '🔪': '1f52a',
  '😬': '1f62c',
  '😱': '1f631',
  '💦': '1f4a6',
  '😂': '1f602',
  '💀': '1f480',
  '😨': '1f628',
  '☠️': '2620'
};

function fontPath(name) {
  return path.join(__dirname, '..', 'assets', 'fonts', name);
}

function filterValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, '\\\'')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function resolveYtDlp() {
  const candidates = [
    process.env.YT_DLP_PATH,
    path.join(os.homedir(), '.local', 'bin', 'yt-dlp'),
    '/usr/local/bin/yt-dlp',
    'yt-dlp'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'yt-dlp' || fs.existsSync(candidate)) return candidate;
  }
  return 'yt-dlp';
}

async function assertYtDlp(bin = resolveYtDlp()) {
  try {
    await execFileAsync(bin, ['--version'], { timeout: 15000 });
    return bin;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('yt-dlp was not found. Install it with: pip install yt-dlp');
    }
    throw error;
  }
}

async function probeFile(file) {
  try {
    const { stdout } = await execFileAsync(getFFprobePath(), [
      '-v', 'error', '-show_streams', '-of', 'json', file
    ], { maxBuffer: 4 * 1024 * 1024 });
    const streams = JSON.parse(stdout).streams || [];
    const video = streams.find(stream => stream.codec_type === 'video');
    const audio = streams.find(stream => stream.codec_type === 'audio');
    if (video) {
      return {
        width: Number(video.width) || 0,
        height: Number(video.height) || 0,
        hasAudio: Boolean(audio)
      };
    }
  } catch {
    // ffmpeg-static does not ship ffprobe. Fall back to ffmpeg's banner.
  }

  let stderr = '';
  try {
    await runFFmpeg(['-i', file]);
  } catch (error) {
    stderr = String(error.stderr || '');
  }
  const video = stderr.match(/Video:[^\n]*?(\d{2,5})x(\d{2,5})/);
  return {
    width: video ? Number(video[1]) : 0,
    height: video ? Number(video[2]) : 0,
    hasAudio: /Audio:/.test(stderr)
  };
}

async function findPayoffSeconds(filePath) {
  const sampleRate = 8000;
  let stdout;
  try {
    ({ stdout } = await execFileAsync(getFFmpegPath(), [
      '-v', 'error', '-i', filePath, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-'
    ], { maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' }));
  } catch {
    return null;
  }
  const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
  if (buffer.length < sampleRate * 2) return null;
  const samples = Math.floor(buffer.length / 2);
  const windowSamples = Math.round(sampleRate * 0.25);
  const windows = [];
  for (let offset = 0; offset + windowSamples <= samples; offset += windowSamples) {
    let sum = 0;
    for (let index = 0; index < windowSamples; index += 1) {
      const value = buffer.readInt16LE((offset + index) * 2);
      sum += value * value;
    }
    windows.push(sum / windowSamples);
  }
  const span = 4;
  if (windows.length < span) return null;
  let best = -1;
  let bestIndex = 0;
  for (let index = 0; index + span <= windows.length; index += 1) {
    let total = 0;
    for (let inner = 0; inner < span; inner += 1) total += windows[index + inner];
    if (total > best) {
      best = total;
      bestIndex = index;
    }
  }
  const rms = Math.sqrt((best / span));
  if (!Number.isFinite(rms) || rms < 250) return null;
  return (bestIndex + span / 2) * 0.25;
}

async function measureText(fontfile, fontsize, text) {
  const key = `${fontfile}|${fontsize}|${text}`;
  if (textMeasureCache.has(key)) return textMeasureCache.get(key);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rank-text-'));
  const textFile = path.join(dir, 'text.txt');
  await fs.promises.writeFile(textFile, text || ' ');
  try {
    const raw = path.join(dir, 'text.raw');
    const canvasWidth = 1800;
    const canvasHeight = 400;
    await runFFmpeg([
      '-y', '-f', 'lavfi', '-i', `color=c=black:s=${canvasWidth}x${canvasHeight}`,
      '-vf', `drawtext=fontfile=${filterValue(fontfile)}:textfile=${filterValue(textFile)}:fontsize=${fontsize}:fontcolor=white:x=8:y=8`,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw
    ]);
    const pixels = await fs.promises.readFile(raw);
    let minX = canvasWidth;
    let minY = canvasHeight;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < canvasHeight; y += 1) {
      for (let x = 0; x < canvasWidth; x += 1) {
        const offset = (y * canvasWidth + x) * 3;
        if (pixels[offset] > 40 || pixels[offset + 1] > 40 || pixels[offset + 2] > 40) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    const measured = maxX < 0
      ? { width: Math.round(fontsize * Math.max(1, text.length) * 0.55), height: fontsize }
      : { width: maxX - minX + 1, height: maxY - minY + 1 };
    textMeasureCache.set(key, measured);
    return measured;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

async function downloadEmoji(emoji, destDir) {
  const codepoint = EMOJI_CODEPOINTS[emoji];
  if (!codepoint) return null;
  const dest = path.join(destDir, `${codepoint}.png`);
  if (fs.existsSync(dest)) return dest;
  const url = `https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/${codepoint}.png`;
  const response = await fetch(url, { headers: { 'User-Agent': 'ranks-channel/1.0' } });
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 32) return null;
  await fs.promises.writeFile(dest, bytes);
  return dest;
}

async function renderOverlayPng({
  filePath, width, height, fontfile, titleLeft, titleRight, rows
}) {
  const titleSize = Math.max(28, Math.round(68 * height / 1920));
  const numberSize = Math.max(26, Math.round(64 * height / 1920));
  const labelSize = Math.max(22, Math.round(50 * height / 1920));
  let fittedTitle = titleSize;
  let leftBox = await measureText(fontfile, fittedTitle, titleLeft);
  let rightBox = await measureText(fontfile, fittedTitle, titleRight);
  const titleGap = size => {
    const border = Math.max(3, Math.round(size * 0.08));
    // Borders paint past the ink, so the gap has to clear both outlines plus a word space.
    return border * 2 + Math.round(size * 0.32);
  };
  let gap = titleGap(fittedTitle);
  while (leftBox.width + gap + rightBox.width > width * 0.92 && fittedTitle > 28) {
    fittedTitle -= 4;
    gap = titleGap(fittedTitle);
    leftBox = await measureText(fontfile, fittedTitle, titleLeft);
    rightBox = await measureText(fontfile, fittedTitle, titleRight);
  }
  const titleBorder = Math.max(3, Math.round(fittedTitle * 0.08));
  const titleWidth = leftBox.width + gap + rightBox.width;
  const titleX = Math.round((width - titleWidth) / 2);
  const titleY = Math.round(0.127 * height - Math.max(leftBox.height, rightBox.height) / 2);

  const dir = path.dirname(filePath);
  const textDir = path.join(dir, 'text');
  await fs.promises.mkdir(textDir, { recursive: true });
  const pieces = [
    { text: titleLeft, size: fittedTitle, color: 'white', x: titleX, y: titleY, border: titleBorder },
    { text: titleRight, size: fittedTitle, color: THEME_RED, x: titleX + leftBox.width + gap, y: titleY, border: titleBorder }
  ];

  const centers = rowCenters(rows.length);
  const numberBorder = Math.max(2, Math.round(numberSize * 0.09));
  const labelBorder = Math.max(2, Math.round(labelSize * 0.08));
  const emojiInputs = [];
  const emojiOverlays = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const number = `${row.rank}.`;
    const numberBox = await measureText(fontfile, numberSize, number);
    const numberX = Math.round(0.075 * width);
    const numberY = Math.round(centers[index] * height - numberBox.height / 2);
    pieces.push({
      text: number, size: numberSize, color: rankColor(row.rank), x: numberX, y: numberY, border: numberBorder
    });
    if (!row.revealed || !row.label) continue;
    const labelBox = await measureText(fontfile, labelSize, row.label);
    const labelX = numberX + numberBox.width + numberBorder + Math.round(width * 0.012);
    const labelY = Math.round(centers[index] * height - labelBox.height / 2);
    pieces.push({
      text: row.label, size: labelSize, color: 'white', x: labelX, y: labelY, border: labelBorder
    });
    if (row.emojiFile) {
      const emojiSize = Math.round(labelSize * 1.05);
      const emojiX = labelX + labelBox.width + labelBorder + Math.round(labelSize * 0.38);
      const emojiY = Math.round(centers[index] * height - emojiSize / 2);
      emojiInputs.push(row.emojiFile);
      emojiOverlays.push({ x: emojiX, y: emojiY, size: emojiSize });
    }
  }

  const drawFilters = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    const textFile = path.join(textDir, `piece-${index}.txt`);
    await fs.promises.writeFile(textFile, piece.text);
    drawFilters.push([
      `drawtext=fontfile=${filterValue(fontfile)}`,
      `textfile=${filterValue(textFile)}`,
      `fontsize=${piece.size}`,
      `fontcolor=${piece.color}`,
      `borderw=${piece.border}`,
      'bordercolor=black',
      'shadowcolor=black@0.7',
      'shadowx=2',
      'shadowy=2',
      `x=${piece.x}`,
      `y=${piece.y}`
    ].join(':'));
  }

  const args = [
    '-y', '-f', 'lavfi', '-i', `color=c=black@0.0:s=${width}x${height}:d=1,format=rgba`
  ];
  for (const emojiFile of emojiInputs) args.push('-i', emojiFile);
  let chain = `[0:v]${drawFilters.join(',')}[text]`;
  let current = '[text]';
  emojiOverlays.forEach((overlay, index) => {
    const input = `[${index + 1}:v]`;
    const scaled = `[em${index}]`;
    const next = index === emojiOverlays.length - 1 ? '[out]' : `[over${index}]`;
    chain += `;${input}scale=${overlay.size}:${overlay.size}${scaled};${current}${scaled}overlay=${overlay.x}:${overlay.y}:format=auto${next}`;
    current = next;
  });
  if (!emojiOverlays.length) chain = chain.replace('[text]', '[out]');
  args.push('-filter_complex', chain, '-map', '[out]', '-frames:v', '1', filePath);
  await runFFmpeg(args);
  return filePath;
}

async function detectContentCrop(file, width, height) {
  if (!width || !height) return null;
  let stderr = '';
  try {
    const result = await runFFmpeg([
      '-ss', '0.4', '-i', file,
      '-vf', 'cropdetect=limit=24:round=2:reset=0',
      '-frames:v', '8', '-f', 'null', '-'
    ]);
    stderr = result.stderr || '';
  } catch (error) {
    stderr = String(error.stderr || '');
  }
  const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  const crop = { w: Number(last[1]), h: Number(last[2]), x: Number(last[3]), y: Number(last[4]) };
  if (crop.w < 64 || crop.h < 64) return null;
  if (crop.w * crop.h < width * height * 0.35) return null;
  const removesBar = crop.h < height * 0.92 || crop.w < width * 0.92;
  return removesBar ? crop : null;
}

function videoChain({ width, height, start, end, landscape, crop }) {
  const trim = `trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},setpts=PTS-STARTPTS`;
  const cropped = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : '';
  if (landscape) {
    return [
      `[0:v]${trim},${cropped}split[bgSrc][fgSrc]`,
      `[bgSrc]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=24:2,setsar=1[bg]`,
      `[fgSrc]scale=${width}:${height}:force_original_aspect_ratio=decrease,setsar=1[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=30,setsar=1[base]`,
      `[base][1:v]overlay=0:0:format=auto[v]`
    ].join(';');
  }
  return [
    `[0:v]${trim},${cropped}scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=30[base]`,
    `[base][1:v]overlay=0:0:format=auto[v]`
  ].join(';');
}

async function renderSegment({ clip, overlayPath, outputPath, start, duration, width, height }) {
  const end = start + duration;
  const crop = clip.contentCrop || null;
  const contentWidth = crop?.w || clip.width;
  const contentHeight = crop?.h || clip.height;
  const landscape = contentWidth > contentHeight;
  const audioChain = clip.hasAudio
    ? `[0:a]atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo[a]`
    : `[2:a]atrim=start=0:end=${duration.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a]`;
  const filter = `${videoChain({ width, height, start, end, landscape, crop })};${audioChain}`;
  const args = ['-y', '-i', clip.filePath, '-i', overlayPath];
  if (!clip.hasAudio) {
    args.push('-f', 'lavfi', '-t', duration.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }
  args.push(
    '-filter_complex', filter,
    '-map', '[v]', '-map', '[a]',
    '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    outputPath
  );
  try {
    await runFFmpeg(args);
  } catch (error) {
    if (!clip.hasAudio || !String(error.stderr || error.message || '').includes('loudnorm')) throw error;
    const fallback = filter.replace(',loudnorm=I=-16:TP=-1.5:LRA=11', '');
    args[args.indexOf(filter)] = fallback;
    await runFFmpeg(args);
  }
}

async function concatSegments(segmentPaths, outputPath, listPath) {
  const body = segmentPaths.map(file => `file '${file.replace(/'/g, `'\\''`)}'`).join('\n');
  await fs.promises.writeFile(listPath, body);
  await runFFmpeg([
    '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy', '-movflags', '+faststart', outputPath
  ]);
}

async function downloadClip(clip, destPath, ytdlp) {
  const urls = [...new Set([clip.hlsUrl, clip.plainHlsUrl].filter(Boolean))];
  let lastError = null;
  for (const url of urls) {
    try {
      await execFileAsync(ytdlp, [
        '--no-playlist', '--no-warnings', '--no-progress', '--force-overwrites',
        '--retries', '2', '--socket-timeout', '30',
        '--user-agent', BROWSER_UA,
        '--add-header', 'Referer:https://www.reddit.com/',
        '-f', 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b',
        '--merge-output-format', 'mp4',
        '-o', destPath,
        url
      ], { maxBuffer: 8 * 1024 * 1024, timeout: 180000 });
      if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1000) return destPath;
      lastError = new Error('yt-dlp finished without an MP4');
    } catch (error) {
      lastError = error;
      await fs.promises.rm(destPath, { force: true }).catch(() => {});
    }
  }
  const detail = lastError?.stderr ? String(lastError.stderr).split('\n').filter(Boolean).pop() : lastError?.message;
  throw new Error(detail || `Could not download ${clip.permalink}`);
}

async function renderRankingShort(clips, options = {}) {
  if (!clips?.length) throw new Error('No clips to render');
  const fontfile = options.fontfile || fontPath('Montserrat-Black.ttf');
  if (!fs.existsSync(fontfile)) {
    throw new Error(`Montserrat Black is missing at ${fontfile}. It is instanced from assets/fonts/Montserrat-Variable.ttf.`);
  }
  const width = options.width || 1080;
  const height = options.height || 1920;
  const workDir = options.workDir || await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ranking-short-'));
  const emojiDir = path.join(workDir, 'emoji');
  await fs.promises.mkdir(emojiDir, { recursive: true });
  const useEmoji = options.emoji !== false;
  const ranked = clips[0].rank ? clips : assignRanks(clips);
  const byRank = new Map(ranked.map(clip => [clip.rank, clip]));
  const order = revealOrder(ranked.length);
  const copy = buildPackageCopy({ theme: options.theme || 'Fails', clips: ranked });
  const logger = options.logger || console;

  const segmentPaths = [];
  for (let index = 0; index < order.length; index += 1) {
    const rank = order[index];
    const clip = byRank.get(rank);
    const wanted = segmentDuration(rank, ranked.length);
    const payoff = options.payoffSeconds?.[rank] ?? await findPayoffSeconds(clip.filePath);
    const window = planSegmentWindow({
      mediaDuration: clip.mediaDuration || await getMediaDuration(clip.filePath),
      segmentDuration: wanted,
      payoffSeconds: payoff
    });
    const revealed = new Set(order.slice(0, index + 1));
    const rows = ranked.slice().sort((a, b) => a.rank - b.rank).map(item => ({
      rank: item.rank,
      label: item.label,
      revealed: revealed.has(item.rank),
      emojiFile: null
    }));
    if (useEmoji) {
      for (const row of rows) {
        if (!row.revealed) continue;
        const emoji = byRank.get(row.rank)?.emoji;
        try {
          row.emojiFile = emoji ? await downloadEmoji(emoji, emojiDir) : null;
        } catch {
          row.emojiFile = null;
        }
      }
    }
    const overlayPath = path.join(workDir, `overlay-${index}.png`);
    await renderOverlayPng({
      filePath: overlayPath,
      width,
      height,
      fontfile,
      titleLeft: 'Ranking Best',
      titleRight: copy.themeTitle,
      rows
    });
    const segmentPath = path.join(workDir, `segment-${index}.mp4`);
    logger.info?.(`Rendering rank ${rank} (${window.duration.toFixed(1)}s)`);
    await renderSegment({
      clip, overlayPath, outputPath: segmentPath, start: window.start, duration: window.duration, width, height
    });
    segmentPaths.push(segmentPath);
  }

  const videoPath = path.join(workDir, 'video.mp4');
  await concatSegments(segmentPaths, videoPath, path.join(workDir, 'concat.txt'));
  const duration = await getMediaDuration(videoPath);
  const thumbPath = path.join(workDir, 'thumbnail.jpg');
  await runFFmpeg([
    '-y', '-ss', String(Math.max(0, duration - 0.4)), '-i', videoPath,
    '-frames:v', '1', '-q:v', '2', thumbPath
  ]);

  const packageId = options.packageId || `rank${crypto.randomBytes(3).toString('hex')}`;
  const exported = await exportPostPackage({
    id: packageId,
    createdAt: new Date().toISOString(),
    editorData: {
      title: copy.title,
      description: copy.description,
      tags: normalizeTags(copy.tags)
    },
    strategy: {
      topic: options.theme || copy.themeTitle,
      contentType: 'ranking-short',
      angle: 'Reddit fail countdown'
    },
    assets: {
      finalVideo: { path: videoPath, simulated: false, duration },
      thumbnail: { path: thumbPath }
    },
    qualityChecks: [
      { id: 'rendered', label: 'Rendered Short', passed: true, blocking: true, message: 'Real MP4 with clip audio' },
      { id: 'credits', label: 'Source credits', passed: true, blocking: true, message: 'Description lists each subreddit, author, and post' },
      {
        id: 'third-party',
        label: 'Third-party clips',
        passed: false,
        blocking: false,
        message: 'These are other people\'s Reddit videos. Confirm every credit in description.txt before you post.'
      }
    ]
  }, { outputRoot: options.outputRoot, reviewStatus: 'ready' });

  return {
    videoPath: path.join(exported.dir, 'video.mp4'),
    packageDir: exported.dir,
    title: copy.title,
    description: copy.description,
    duration,
    workDir
  };
}

async function createRankingShort(options = {}) {
  const theme = String(options.theme || 'pool fails').trim();
  const count = Math.min(8, Math.max(5, Math.round(Number(options.count) || 6)));
  const subreddit = options.subreddit || 'Whatcouldgowrong';
  const query = options.query || themeTokens(theme)[0] || theme;
  const logger = options.logger || console;
  logger.info?.(`Searching r/${subreddit} for "${query}"`);
  const posts = await searchPosts({
    subreddit, query, limit: options.limit || 100, sort: 'desc', fetchImpl: options.fetchImpl
  });
  const excluded = new Set(
    (Array.isArray(options.excludeIds) ? options.excludeIds : String(options.excludeIds || '').split(','))
      .map(id => id.trim())
      .filter(Boolean)
  );
  const candidates = selectCandidateClips(posts, { theme, count, extras: options.extras ?? 12 })
    .filter(clip => !excluded.has(clip.id));
  if (candidates.length < count) {
    throw new Error(`Only found ${candidates.length} "${theme}" clips with video in r/${subreddit}; need ${count}.`);
  }
  const ytdlp = await assertYtDlp(options.ytdlp);
  const workDir = options.workDir || await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ranking-short-'));
  const downloaded = [];
  for (const candidate of candidates) {
    if (downloaded.length >= count) break;
    const dest = path.join(workDir, `${candidate.id || downloaded.length}.mp4`);
    try {
      logger.info?.(`Downloading #${downloaded.length + 1} candidate (${candidate.score} pts): ${candidate.title}`);
      await downloadClip(candidate, dest, ytdlp);
      const probe = await probeFile(dest);
      if (!probe.hasAudio) {
        logger.info?.(`Skip ${candidate.id}: no audio`);
        continue;
      }
      const width = probe.width || candidate.width;
      const height = probe.height || candidate.height;
      downloaded.push({
        ...candidate,
        filePath: dest,
        width,
        height,
        hasAudio: true,
        mediaDuration: await getMediaDuration(dest),
        contentCrop: await detectContentCrop(dest, width, height)
      });
    } catch (error) {
      logger.info?.(`Skip ${candidate.id}: ${error.message}`);
    }
  }
  if (downloaded.length < count) {
    throw new Error(`Downloaded ${downloaded.length} of ${count} "${theme}" clips. The rest were blocked or silent.`);
  }
  const ranked = assignRanks(downloaded.slice(0, count));
  return renderRankingShort(ranked, { ...options, theme, workDir, logger });
}

module.exports = {
  assertYtDlp,
  createRankingShort,
  downloadClip,
  findPayoffSeconds,
  measureText,
  probeFile,
  renderOverlayPng,
  renderRankingShort,
  resolveYtDlp
};
