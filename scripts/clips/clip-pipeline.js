#!/usr/bin/env node
// Free Shorts clipping pipeline: fetch a source (Kick VOD or YouTube via yt-dlp), transcribe locally
// with faster-whisper, pick 30-60s moments (Gemini free-tier text or a heuristic), and render
// 1080x1920 split-screen clips with a hook box and word-by-word captions. Nothing is uploaded.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const FONT_DIR = path.join(os.homedir(), '.cache', 'clips-fonts');
const FONT_URL = 'https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-ExtraBold.ttf';
const W = 1080;
const H = 1920;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value.startsWith('--')) {
      const key = value.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(value);
  }
  return args;
}

function run(cmd, cmdArgs, options = {}) {
  return execFileSync(cmd, cmdArgs, { stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', maxBuffer: 1 << 28 })?.toString();
}

async function fetchKick({ channel, index = 0, uuid, start = 0, duration = 1500, out, quality = '1080p60' }) {
  const response = await fetch(`https://kick.com/api/v2/channels/${channel}/videos`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Kick API returned ${response.status}`);
  const videos = await response.json();
  const video = uuid ? videos.find(v => v.video?.uuid === uuid) : videos[Number(index)];
  if (!video) throw new Error('Kick VOD not found');
  const playlist = video.source.replace(/master\.m3u8$/, `${quality}/playlist.m3u8`);
  console.log(`Kick VOD: ${video.session_title} (${video.created_at}), ${(video.duration / 60000).toFixed(0)} min`);
  run('ffmpeg', ['-loglevel', 'error', '-y', '-ss', String(start), '-i', playlist, '-t', String(duration), '-c', 'copy', out]);
  fs.writeFileSync(`${out}.source.json`, JSON.stringify({
    platform: 'kick', channel, uuid: video.video?.uuid, title: video.session_title, createdAt: video.created_at,
    url: `https://kick.com/${channel}/videos/${video.video?.uuid}`, offsetSeconds: Number(start)
  }, null, 2));
  return out;
}

function fetchYouTube({ url, out, cookies }) {
  const ytArgs = ['-f', 'bv*[height<=1080]+ba/b', '--merge-output-format', 'mp4', '-o', out];
  if (cookies) ytArgs.push('--cookies', cookies);
  try {
    run('yt-dlp', [...ytArgs, url]);
  } catch (error) {
    throw new Error('yt-dlp failed. YouTube often blocks cloud IPs ("Sign in to confirm you\'re not a bot"); pass --cookies with a cookies.txt exported from a signed-in browser, or run this on a home connection.');
  }
  fs.writeFileSync(`${out}.source.json`, JSON.stringify({ platform: 'youtube', url, offsetSeconds: 0 }, null, 2));
  return out;
}

function transcribe({ source, out, model = 'small.en' }) {
  run('python3', [path.join(HERE, 'transcribe.py'), source, out, '--model', model]);
  return out;
}

function transcriptLines(transcript) {
  return transcript.segments.map(s => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join('\n');
}

function snapToSegments(transcript, start, end) {
  const segments = transcript.segments;
  const first = segments.reduce((best, s) => Math.abs(s.start - start) < Math.abs(best.start - start) ? s : best, segments[0]);
  const last = segments.reduce((best, s) => Math.abs(s.end - end) < Math.abs(best.end - end) ? s : best, segments[0]);
  return { start: Math.max(0, first.start - 0.15), end: last.end + 0.35 };
}

async function selectWithGemini(transcript, { count, creator, minSeconds, maxSeconds }) {
  const { GoogleGenAI } = require('@google/genai');
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = process.env.CLIPS_TEXT_MODEL || 'gemini-3.8-flash';
  const prompt = `You are an expert short-form video editor for a ${creator} clips channel on YouTube Shorts.
From this timestamped livestream transcript, pick the ${count} strongest standalone moments for Shorts.
Rules:
- Each clip is ${minSeconds}-${maxSeconds} seconds, starts at the beginning of a sentence with an instant hook (no setup, no "so", no greetings), and ends on a punchline, reveal or complete thought.
- Prefer: big wins or losses, strong opinions, funny reactions, a clear trading lesson or mindset quote, money/lifestyle flexes.
- Avoid: segments that depend on unseen context, sponsor reads, chat housekeeping, anything that portrays ${creator} negatively.
- Clips must not overlap.
Return JSON: {"clips": [{"start": number, "end": number, "hook": string (on-screen hook, max 32 chars, punchy, sentence case, may end with one emoji), "title": string (YouTube Shorts title, max 70 chars, include #${creator.toLowerCase()} #shorts), "description": string (1-2 sentences), "why": string (one sentence), "score": number 1-10}]}
Transcript:
${transcriptLines(transcript)}`;
  const response = await client.models.generateContent({ model, contents: prompt, config: { responseMimeType: 'application/json', temperature: 0.4 } });
  return JSON.parse(response.text).clips;
}

// Fallback when no Gemini key: rank windows by speech density, exclamations, money and trading keywords.
function selectHeuristic(transcript, { count, minSeconds, maxSeconds }) {
  const keywords = /\$|\bk\b|thousand|million|profit|loss|lost|win|cooked|crazy|insane|bro|never|always|secret|rule|stop|trade|liquidity|bias/gi;
  const candidates = [];
  const segments = transcript.segments;
  for (let i = 0; i < segments.length; i++) {
    let j = i;
    while (j < segments.length && segments[j].end - segments[i].start < minSeconds) j++;
    if (j >= segments.length || segments[j].end - segments[i].start > maxSeconds) continue;
    const text = segments.slice(i, j + 1).map(s => s.text).join(' ');
    const words = text.split(/\s+/).length;
    const span = segments[j].end - segments[i].start;
    const score = words / span + (text.match(keywords) || []).length * 0.6 + (text.match(/!/g) || []).length * 0.4;
    candidates.push({ start: segments[i].start, end: segments[j].end, score, hook: segments[i].text.slice(0, 32), title: segments[i].text.slice(0, 60), description: text.slice(0, 150), why: 'heuristic' });
  }
  candidates.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const candidate of candidates) {
    if (picked.every(p => candidate.end <= p.start || candidate.start >= p.end)) picked.push(candidate);
    if (picked.length === count) break;
  }
  return picked;
}

async function select({ transcriptPath, out, count = 2, creator = 'TJR', minSeconds = 30, maxSeconds = 60 }) {
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
  const options = { count: Number(count), creator, minSeconds: Number(minSeconds), maxSeconds: Number(maxSeconds) };
  let clips;
  let method = 'gemini';
  try {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
    clips = await selectWithGemini(transcript, options);
  } catch (error) {
    console.warn(`Gemini selection unavailable (${error.message}); using the heuristic selector.`);
    clips = selectHeuristic(transcript, options);
    method = 'heuristic';
  }
  clips = clips.map(clip => ({ ...clip, ...snapToSegments(transcript, clip.start, clip.end), method }))
    .filter(clip => clip.end - clip.start >= options.minSeconds - 3 && clip.end - clip.start <= options.maxSeconds + 5);
  fs.writeFileSync(out, JSON.stringify(clips, null, 2));
  for (const clip of clips) console.log(`${clip.start.toFixed(1)}-${clip.end.toFixed(1)} (${(clip.end - clip.start).toFixed(0)}s) ${clip.hook} | ${clip.why}`);
  return clips;
}

function ensureFont() {
  const file = path.join(FONT_DIR, 'Montserrat-ExtraBold.ttf');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(FONT_DIR, { recursive: true });
    run('curl', ['-sL', '-o', file, FONT_URL]);
  }
  return FONT_DIR;
}

function assTime(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${sec}`;
}

// libass cannot draw colour emoji with the caption font, so they would render as empty boxes.
const stripEmoji = text => text.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();
const assEscape = text => text.replace(/[{}]/g, '').replace(/\\/g, '');
// Audio is untouched; on-screen captions mask profanity so the first frames stay advertiser-friendly.
const maskProfanity = text => process.env.CLIPS_KEEP_PROFANITY ? text
  : text.replace(/\b(f)(u)(ck\w*)/gi, (m, a, b, c) => a + '*'.repeat(b.length + c.length - 1) + c.slice(-1))
    .replace(/\b(s)(hi)(t\w*)/gi, (m, a) => a + '**' + m.slice(-1))
    .replace(/\b(b)(itch\w*)/gi, (m, a) => a + '****' + m.slice(-1));

function buildAss({ words, hook, hookY, captionY, duration }) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,Montserrat ExtraBold,74,&H00111111,&H00111111,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,3,18,0,5,60,60,0,1
Style: Cap,Montserrat ExtraBold,84,&H00FFFFFF,&H0000E5FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,7,3,5,40,40,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = [`Dialogue: 1,${assTime(0)},${assTime(duration)},Hook,,0,0,0,,{\\pos(${W / 2},${hookY})}${assEscape(stripEmoji(hook))}`];
  // Two or three words per caption, with the spoken word highlighted in yellow.
  const groups = [];
  let current = [];
  for (const word of words) {
    current.push(word);
    const text = current.map(w => w.word).join(' ');
    if (current.length >= 3 || text.length > 14 || /[.!?,]$/.test(word.word)) { groups.push(current); current = []; }
  }
  if (current.length) groups.push(current);
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    const groupEnd = g + 1 < groups.length ? Math.min(groups[g + 1][0].start, group.at(-1).end + 0.6) : group.at(-1).end + 0.4;
    for (let k = 0; k < group.length; k++) {
      const start = group[k].start;
      const end = k + 1 < group.length ? group[k + 1].start : groupEnd;
      if (end <= start) continue;
      const text = group.map((w, idx) => {
        const clean = assEscape(maskProfanity(w.word).toUpperCase().replace(/[.,!?]+$/, ''));
        return idx === k ? `{\\c&H0000E5FF&}${clean}{\\c&H00FFFFFF&}` : clean;
      }).join(' ');
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,{\\pos(${W / 2},${captionY})}${text}`);
    }
  }
  return header + events.join('\n') + '\n';
}

function detectFace(source, start, end) {
  return JSON.parse(run('python3', [path.join(HERE, 'detect_face.py'), source, String(start), String(end)], { capture: true }));
}

const even = n => Math.max(2, Math.round(n / 2) * 2);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Split layout when the face sits in a corner webcam (chart on top, face below); otherwise one tall crop on the face.
function layoutFilter(info) {
  const { width: sw, height: sh, face } = info;
  if (face && face.y > sh * 0.45 && face.x + face.w / 2 < sw * 0.5) {
    // Keep the chart crop above the webcam and left of TradingView's watchlist (about 74.5% of the width).
    const chartRight = sw * (Number(process.env.CLIPS_CHART_RIGHT) || 0.745);
    const camTop = clamp(face.y - face.h * 1.0, 0, sh);
    const chartPanelH = 840;
    const chartH = even(Math.min(camTop, chartRight * chartPanelH / W));
    const chartCropW = even(chartH * W / chartPanelH);
    const chartX = even(clamp(chartRight - chartCropW, 0, sw - chartCropW));
    const facePanelH = H - chartPanelH;
    const faceCropH = even(clamp(face.h * 2.6, 200, sh));
    const faceCropW = even(faceCropH * W / facePanelH);
    const faceX = even(clamp(face.x + face.w / 2 - faceCropW / 2, 0, sw - faceCropW));
    const faceY = even(clamp(face.y + face.h * 0.55 - faceCropH / 2, 0, sh - faceCropH));
    return {
      mode: 'split', hookY: chartPanelH, captionY: chartPanelH + 175,
      filter: `[0:v]split[a][b];[a]crop=${chartCropW}:${chartH}:${chartX}:0,scale=${W}:${chartPanelH}:flags=lanczos[top];` +
        `[b]crop=${faceCropW}:${faceCropH}:${faceX}:${faceY},scale=${W}:${facePanelH}:flags=lanczos[bottom];[top][bottom]vstack`
    };
  }
  const cropW = even(sh * W / H);
  const centerX = face ? face.x + face.w / 2 : sw / 2;
  const x = even(clamp(centerX - cropW / 2, 0, sw - cropW));
  return { mode: 'center', hookY: 380, captionY: 1380, filter: `[0:v]crop=${cropW}:${sh}:${x}:0,scale=${W}:${H}:flags=lanczos` };
}

function render({ source, transcriptPath, clipsPath, outDir, only }) {
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
  const clips = JSON.parse(fs.readFileSync(clipsPath, 'utf8'));
  const fontsDir = ensureFont();
  fs.mkdirSync(outDir, { recursive: true });
  const outputs = [];
  clips.forEach((clip, i) => {
    if (only !== undefined && Number(only) !== i + 1) return;
    const duration = clip.end - clip.start;
    const words = transcript.segments.flatMap(s => s.words)
      .filter(w => w.start >= clip.start && w.end <= clip.end + 0.1)
      .map(w => ({ ...w, start: w.start - clip.start, end: w.end - clip.start }));
    const info = detectFace(source, clip.start, clip.end);
    const layout = layoutFilter(info);
    const assPath = path.join(outDir, `clip-${i + 1}.ass`);
    fs.writeFileSync(assPath, buildAss({ words, hook: clip.hook, hookY: layout.hookY, captionY: layout.captionY, duration }));
    const out = path.join(outDir, `clip-${i + 1}.mp4`);
    run('ffmpeg', ['-loglevel', 'error', '-y', '-ss', clip.start.toFixed(2), '-t', duration.toFixed(2), '-i', source,
      '-filter_complex', `${layout.filter},fps=30,subtitles=${assPath}:fontsdir=${fontsDir},format=yuv420p[v]`,
      '-map', '[v]', '-map', '0:a:0', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
    console.log(`rendered ${out} (${layout.mode}, ${duration.toFixed(1)}s)`);
    outputs.push({ ...clip, file: out, layout: layout.mode, duration });
  });
  fs.writeFileSync(path.join(outDir, 'rendered.json'), JSON.stringify(outputs, null, 2));
  return outputs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const work = args.work || path.join(os.tmpdir(), 'clips');
  fs.mkdirSync(work, { recursive: true });
  const source = args.source || path.join(work, 'source.mp4');
  const transcriptPath = args.transcript || path.join(work, 'transcript.json');
  const clipsPath = args.clips || path.join(work, 'clips.json');
  const outDir = args.out || path.join(work, 'out');

  if (command === 'fetch-kick') await fetchKick({ channel: args.channel || 'tjr', index: args.index, uuid: args.uuid, start: args.start, duration: args.duration, out: source });
  else if (command === 'fetch-youtube') fetchYouTube({ url: args.url, out: source, cookies: args.cookies });
  else if (command === 'transcribe') transcribe({ source, out: transcriptPath, model: args.model });
  else if (command === 'select') await select({ transcriptPath, out: clipsPath, count: args.count, creator: args.creator, minSeconds: args.min, maxSeconds: args.max });
  else if (command === 'render') render({ source, transcriptPath, clipsPath, outDir, only: args.only });
  else {
    console.log(`Usage: node scripts/clips/clip-pipeline.js <command> [--work DIR]
  fetch-kick     --channel tjr [--index 0 | --uuid UUID] --start SECONDS --duration SECONDS
  fetch-youtube  --url URL [--cookies cookies.txt]
  transcribe     [--model small.en]
  select         [--count 2] [--creator TJR] [--min 30] [--max 60]
  render         [--only N]`);
    process.exitCode = command ? 1 : 0;
  }
}

main().catch(error => { console.error(error.message); process.exit(1); });
