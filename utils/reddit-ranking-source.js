// Reddit clips for a TOP 6 style ranking Short.
// reddit.com JSON is blocked in some environments, so search goes through Arctic Shift.
const ARCTIC_SHIFT_SEARCH = 'https://arctic-shift.photon-reddit.com/api/posts/search';

const GENERIC_THEME_WORDS = new Set([
  'fail', 'fails', 'failure', 'best', 'ranking', 'rank', 'funny', 'video', 'videos', 'compilation', 'top'
]);

// Titles that are a poor fit for a light fail-compilation (graphic, sexual, or not a swimming-pool fail).
const BLOCKED_TITLE = /\b(pee\w*|piss\w*|nude|naked|nudes|sex|porn|lube|lubing|chemical|acid|peroxide|child|children|kiddie|kid|kids|baby|toddler|nephew|niece|blood|dead|death|died|drown\w*|hospital|seizure|shallow|broken|burn\w*|suicide|kill\w*|alligator|romance|fart\w*|steal\w*|theft|robbery|narcotic\w*|rifle|poop|preschool|rob|robbing|robbed)\b|pool cue|pool table|carpool|billiard|rock pool|reflecting pool|mud pool|passing gas|pool shock/i;

const LABEL_RULES = [
  [/spider[\s-]?man/i, 'Spidey jump', '🕷️'],
  [/england/i, 'England style', '💥'],
  [/festival|mexican/i, 'Festival', '💥'],
  [/each other/i, 'Crossfire', '💥'],
  [/throwing fireworks|running off/i, 'Backwards', '💥'],
  [/multiple/i, 'In a row', '💥'],
  [/firework/i, 'Fireworks', '💥'],
  [/ice skate/i, 'Ice skate', '🥶'],
  [/roller skate/i, 'Roller skate', '😱'],
  [/trike/i, 'Park trike', '😱'],
  [/^dirt bik/i, 'Dirt bike', '🚲'],
  [/skate park/i, 'Skate park', '😱'],
  [/skate/i, 'Skate trick', '😱'],
  [/ice fishing/i, 'Ice fishing', '🥶'],
  [/drone/i, 'Drone cast', '🎣'],
  [/surfing|\bpier\b/i, 'Pier surf', '🐟'],
  [/without a pole|no pole/i, 'No pole', '🐟'],
  [/fishing rod|\brod\b/i, 'Fishing rod', '🎣'],
  [/fish/i, 'Fishing fail', '🐟'],
  [/mud/i, 'Mud pit', '🚲'],
  [/snow bridge|melting snow/i, 'Snow bridge', '❄️'],
  [/(atv|quad).*bridge|bridge.*(atv|quad)/i, 'Bridge run', '😬'],
  [/wheelie/i, 'ATV wheelie', '😬'],
  [/downhill|rolling/i, 'Downhill', '😬'],
  [/desert|slop/i, 'Desert slide', '😬'],
  [/small space/i, 'Tight turn', '😬'],
  [/goofing/i, 'Lot spin', '😬'],
  [/quad|\batv\b/i, 'ATV fail', '😬'],
  [/bike roll/i, 'Bike roll', '🚲'],
  [/bike trick/i, 'Bike trick', '🚲'],
  [/dirt bike/i, 'Dirt bike', '🚲'],
  [/overtake|blind corner/i, 'Blind pass', '🚲'],
  [/not looking|looking in front/i, 'No look', '🚲'],
  [/bike.*\bice\b|\bice\b.*bike/i, 'Ice ride', '🚲'],
  [/\bbike\b/i, 'Bike fail', '🚲'],
  [/overtak.*snow|snow.*overtak/i, 'Hill pass', '❄️'],
  [/doughnut|donut/i, 'Snow donuts', '❄️'],
  [/headfirst|dive.*snow|snow.*dive/i, 'Snow dive', '❄️'],
  [/drift.*snow|snow.*drift/i, 'Snow drift', '❄️'],
  [/jump.*snow|snow.*jump/i, 'Snow jump', '❄️'],
  [/snow/i, 'Snow fail', '❄️'],
  [/horse/i, 'Horse fail', '😂'],
  [/trampoline/i, 'Trampoline', '😱'],
  [/wedding/i, 'Wedding fail', '😂'],
  [/frozen|\bice\b/i, 'Frozen pool', '🥶'],
  [/knife|rubber pool/i, 'Rubber pool', '🔪'],
  [/\brope\b/i, 'Rope jump', '😬'],
  [/back[\s-]?flip/i, 'Backflip', '😱'],
  [/drain/i, 'Pool drain', '💦'],
  [/surfboard/i, 'Surfboard', '😂'],
  [/ladder/i, 'Ladder jump', '💀'],
  [/motor\s?boat/i, 'Motorboat', '😂'],
  [/small pool/i, 'Small pool', '😂'],
  [/inflatable/i, 'Inflatable', '😂'],
  [/uncle/i, 'Uncle push', '😂'],
  [/cycl/i, 'Pool cycle', '😂'],
  [/\bjump/i, 'Pool jump', '😂'],
  [/div(e|ing)/i, 'Diving fail', '😨'],
  [/slip/i, 'Slip', '💀'],
  [/boat/i, 'Pool boat', '😂']
];

const RANK_COLORS = {
  1: '0xF7C531',
  2: '0xFFFFFF',
  3: '0xE8923C',
  4: '0xC8C8C8',
  5: '0xFFFFFF',
  6: '0xE8364F',
  7: '0x7EC8FF',
  8: '0xC9A0FF'
};

const THEME_RED = '0xE5141B';

function themeTokens(theme) {
  return String(theme || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token && !GENERIC_THEME_WORDS.has(token));
}

function titleMatchesTheme(title, theme) {
  const tokens = themeTokens(theme);
  if (!tokens.length) return false;
  const haystack = String(title || '').toLowerCase();
  return tokens.every(token => haystack.includes(token));
}

function redditVideoOf(post) {
  const sources = [post?.secure_media, post?.media];
  const crosspost = post?.crosspost_parent_list;
  if (Array.isArray(crosspost)) {
    for (const parent of crosspost) sources.push(parent?.secure_media, parent?.media);
  }
  for (const source of sources) {
    const video = source && source.reddit_video;
    if (video && video.hls_url) return video;
  }
  return null;
}

function permalinkOf(post) {
  const raw = String(post?.permalink || '');
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return `https://www.reddit.com${raw}`;
  return `https://www.reddit.com/comments/${post?.id || ''}`;
}

function vredditId(post, video) {
  const candidates = [post?.url, video?.fallback_url, video?.hls_url, video?.dash_url];
  for (const candidate of candidates) {
    const match = String(candidate || '').match(/v\.redd\.it\/([a-z0-9]+)/i);
    if (match) return match[1];
  }
  return null;
}

function toClip(post, video) {
  const width = Number(video.width) || 0;
  const height = Number(video.height) || 0;
  const id = vredditId(post, video);
  return {
    id: String(post.id || id || ''),
    title: String(post.title || '').replace(/\s+/g, ' ').trim(),
    score: Number(post.score) || 0,
    author: String(post.author || '[deleted]').replace(/\s+/g, ''),
    subreddit: String(post.subreddit || 'Whatcouldgowrong'),
    permalink: permalinkOf(post),
    hlsUrl: video.hls_url,
    plainHlsUrl: id ? `https://v.redd.it/${id}/HLSPlaylist.m3u8` : null,
    pageUrl: id ? `https://v.redd.it/${id}` : (post.url || null),
    duration: Number(video.duration) || 0,
    width,
    height,
    vertical: height > 0 && height >= width
  };
}

function listEligibleClips(posts, options = {}) {
  const theme = options.theme || '';
  const minDuration = options.minDuration ?? 5;
  const maxDuration = options.maxDuration ?? 80;
  const clips = [];
  for (const post of posts || []) {
    if (!post || post.over_18) continue;
    const video = redditVideoOf(post);
    if (!video) continue;
    const clip = toClip(post, video);
    if (!clip.hlsUrl || clip.duration < minDuration || clip.duration > maxDuration) continue;
    if (BLOCKED_TITLE.test(clip.title)) continue;
    if (!titleMatchesTheme(clip.title, theme)) continue;
    clips.push(clip);
  }
  return clips;
}

function selectCandidateClips(posts, options = {}) {
  const count = options.count ?? 6;
  const extras = options.extras ?? 12;
  const eligible = listEligibleClips(posts, options);
  const vertical = eligible.filter(clip => clip.vertical);
  const pool = vertical.length >= count ? vertical : eligible;
  return pool
    .slice()
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
    .slice(0, count + extras);
}

function assignRanks(clips) {
  const used = new Set();
  return clips.map((clip, index) => {
    const label = labelFromTitle(clip.title);
    let text = label.text;
    if (used.has(text)) {
      const weak = new Set(['wcgw', 'wcgr', 'wgcw', 'lets', 'doing', 'trying', 'while', 'when', 'this', 'that', 'with', 'your', 'from', 'into', 'onto', 'just', 'really', 'very', 'good', 'idea', 'actual', 'static', 'what', 'could', 'wrong', 'there', 'then', 'them', 'they', 'have', 'been', 'will', 'same', 'time']);
      const extra = String(clip.title || '')
        .replace(/wcgw|wcgr|wgcw/ig, ' ')
        .replace(/[^A-Za-z0-9\s]/g, ' ')
        .split(/\s+/)
        .find(word => word.length > 3 && !text.toLowerCase().includes(word.toLowerCase()) && !GENERIC_THEME_WORDS.has(word.toLowerCase()) && !weak.has(word.toLowerCase()));
      if (extra) text = `${text.split(' ')[0]} ${extra.toLowerCase()}`;
    }
    used.add(text);
    return { ...clip, rank: index + 1, label: text, emoji: label.emoji };
  });
}

function labelFromTitle(title) {
  const source = String(title || '');
  for (const [pattern, text, emoji] of LABEL_RULES) {
    if (pattern.test(source)) return { text, emoji };
  }
  const stripped = source
    .replace(/wcgw/ig, ' ')
    .replace(/[^A-Za-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(word => word && !GENERIC_THEME_WORDS.has(word.toLowerCase()) && !/^(when|you|your|the|a|an|to|of|and|with|while|into|onto|this|that|from|for)$/i.test(word));
  const words = stripped.slice(0, 2);
  const text = words.length
    ? `${words[0].charAt(0).toUpperCase()}${words[0].slice(1).toLowerCase()}${words[1] ? ` ${words[1].toLowerCase()}` : ''}`
    : 'Pool fail';
  return { text, emoji: '😂' };
}

function revealOrder(count) {
  const total = Math.round(Number(count) || 0);
  if (total <= 0) return [];
  if (total <= 2) return Array.from({ length: total }, (_, index) => total - index);
  const order = [];
  for (let rank = 3; rank <= total; rank += 1) order.push(rank);
  order.push(2, 1);
  return order;
}

// Reference Short cuts every 2–3s (20s total). Holds are longer so each fail can land:
// middle ranks 4.5s, the last rank 4s, #2 is 6.5s, #1 is 6s. Six clips run 30s.
function segmentDuration(rank, count) {
  if (rank === 1) return 6;
  if (rank === 2) return 6.5;
  if (rank === count && count > 2) return 4;
  return 4.5;
}

function rowCenters(count) {
  if (count === 6) return [0.28, 0.36, 0.435, 0.51, 0.59, 0.67];
  const total = Math.max(1, count);
  const start = 0.28;
  const end = total <= 6 ? start + (total - 1) * 0.078 : 0.74;
  if (total === 1) return [start];
  const step = (end - start) / (total - 1);
  return Array.from({ length: total }, (_, index) => start + index * step);
}

function planSegmentWindow({ mediaDuration, segmentDuration: wanted, payoffSeconds }) {
  const media = Math.max(0, Number(mediaDuration) || 0);
  const length = Math.min(Math.max(0.5, Number(wanted) || 0.5), media || 0.5);
  const payoff = payoffSeconds == null ? media * 0.85 : Number(payoffSeconds);
  let start = payoff - length * 0.65;
  if (start < 0) start = 0;
  if (start + length > media) start = Math.max(0, media - length);
  const duration = Math.min(length, Math.max(0.3, media - start));
  return { start, duration };
}

function titleCase(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).map(word => (
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  )).join(' ');
}

function themeHashtags(themeTitle) {
  const words = themeTitle.toLowerCase().split(/\s+/).filter(Boolean);
  const tags = ['#funny', '#shorts', '#viral', '#ranking', '#fails', '#fyp', '#funnyshorts'];
  for (const word of words) tags.push(`#${word}`);
  if (words.length > 1) tags.push(`#${words.join('')}`);
  return [...new Set(tags)].join(' ');
}

function buildPackageCopy({ theme, clips }) {
  const themeTitle = titleCase(theme || 'Fails');
  const title = `Ranking Best ${themeTitle}`.slice(0, 100);
  const sources = clips
    .slice()
    .sort((a, b) => b.rank - a.rank)
    .map(clip => `${clip.rank}. r/${clip.subreddit} — u/${clip.author} — ${clip.permalink}`);
  const description = [
    `Ranking The Best ${themeTitle}`,
    '',
    'This video is meant only for educational and entertainment purposes and is not intended to deceive or cause any harm. All credit to the creators.',
    '',
    'Sources (rank, subreddit, author, post):',
    ...sources,
    '',
    themeHashtags(themeTitle)
  ].join('\n');
  const tags = [
    'funny', 'shorts', 'viral', 'ranking', 'fails', 'funny shorts',
    themeTitle.toLowerCase(),
    ...themeTitle.toLowerCase().split(/\s+/)
  ];
  return { title, themeTitle, description, tags };
}

async function searchPosts({ subreddit, query, limit = 100, sort = 'desc', fetchImpl = fetch } = {}) {
  if (!subreddit) throw new Error('A subreddit is required');
  const params = new URLSearchParams({
    subreddit: String(subreddit),
    limit: String(limit),
    sort: String(sort)
  });
  if (query) params.set('query', String(query));
  const url = `${ARCTIC_SHIFT_SEARCH}?${params}`;
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': 'ranks-channel/1.0', Accept: 'application/json' }
    });
    if (response.ok) {
      const body = await response.json();
      const posts = Array.isArray(body) ? body : body?.data;
      if (!Array.isArray(posts)) throw new Error('Arctic Shift returned no post list');
      return posts;
    }
    lastError = new Error(`Arctic Shift search failed (${response.status}) for r/${subreddit}`);
    if (![422, 429, 500, 502, 503].includes(response.status)) throw lastError;
    await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
  }
  throw lastError;
}

function rankColor(rank) {
  return RANK_COLORS[rank] || '0xFFFFFF';
}

module.exports = {
  ARCTIC_SHIFT_SEARCH,
  BLOCKED_TITLE,
  GENERIC_THEME_WORDS,
  RANK_COLORS,
  THEME_RED,
  assignRanks,
  buildPackageCopy,
  labelFromTitle,
  listEligibleClips,
  permalinkOf,
  planSegmentWindow,
  rankColor,
  redditVideoOf,
  revealOrder,
  rowCenters,
  searchPosts,
  segmentDuration,
  selectCandidateClips,
  themeTokens,
  titleCase,
  titleMatchesTheme
};
