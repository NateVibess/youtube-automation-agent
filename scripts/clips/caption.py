#!/usr/bin/env python3
"""Burn word-timed captions into finished videos without changing anything else.

Speech is transcribed with faster-whisper, grouped into short phrases (2-4 words, breaking at
punctuation and pauses), and burned in low and centred: white with a dark outline, story words in a
bright colour, each phrase snapping in quickly and then holding. Picture size, frame rate, length and
framing are kept; audio is copied untouched; output is muxed with faststart. Nothing is uploaded.

  python3 scripts/clips/caption.py "<folder or files>" --out-dir <dir>
"""
import argparse, os, re, subprocess, sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from montage import FONT_DIR, ensure_fonts  # noqa: E402

HIGHLIGHT = ['minerscave', 'roblox', 'fortnite', 'minecraft', 'creator', 'wrong', 'huss', 'valley', 'free',
             'dragon', 'dragons', 'gold', 'xp', 'code']
PROFANITY = re.compile(r"\b(fuck|fucking|fucked|fucker|motherfucker|motherfucking|shit|shitty|bitch|bitches|asshole|dick|pussy|cunt)\b", re.I)
REPLACE = [(r"\bmind[- ]?scapes?\b|\bmine[- ]?scapes?\b|\bminer'?s[- ]?caves?\b|\bminer'?s[- ]?scape\b|\bminerscape\b", 'Minerscave'),
           (r'\bhus valley\b', 'Huss Valley'), (r'\bcode,? creator\b', 'code CREATOR')]


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"{' '.join(cmd)[:400]}\n{r.stderr[-2000:]}")
    return r.stdout


_MODELS = {}


def transcribe(path, model_name):
    from faster_whisper import WhisperModel
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', '16000', '-'], capture_output=True).stdout
    audio = np.frombuffer(raw, np.float32)
    model = _MODELS.setdefault(model_name, WhisperModel(model_name, compute_type='float32'))
    segments, _ = model.transcribe(audio, word_timestamps=True, temperature=0.0, condition_on_previous_text=False, language='en')
    words = []
    for w in (w for s in segments for w in s.words):
        if not words or w.start >= words[-1]['s'] + 0.01:
            words.append({'w': w.word.strip(), 's': w.start, 'e': w.end})
    return words


def fill_gaps(primary, secondary, gap=0.6, margin=0.15):
    """Whisper sometimes drops a whole stretch; take a second model's words where the first heard nothing."""
    edges = [(-1.0, -1.0)] + [(w['s'], w['e']) for w in primary] + [(1e9, 1e9)]
    holes = [(a[1] + margin, b[0] - margin) for a, b in zip(edges, edges[1:]) if b[0] - a[1] > gap]
    extra = [w for w in secondary if any(lo <= w['s'] and w['e'] <= hi for lo, hi in holes)]
    return sorted(primary + extra, key=lambda w: w['s'])


def apply_fixes(words, fixes):
    """Phrase corrections 'find=>replace' (case/punctuation-insensitive match); times are spread over the new words."""
    norm = lambda t: re.sub(r"[^a-z0-9']", '', t.lower())
    for fix in fixes:
        find, repl = fix.split('=>', 1)
        target = [norm(t) for t in find.split() if norm(t)]
        i = 0
        while i <= len(words) - len(target):
            if [norm(w['w']) for w in words[i:i + len(target)]] == target:
                span = words[i:i + len(target)]
                new = repl.split()
                if not new:
                    del words[i:i + len(target)]
                    continue
                s0, e0 = span[0]['s'], span[-1]['e']
                step = (e0 - s0) / max(1, len(new))
                words[i:i + len(target)] = [{'w': t, 's': s0 + k * step, 'e': s0 + (k + 1) * step} for k, t in enumerate(new)]
                i += len(new)
            else:
                i += 1
    return words


def clean(words):
    """Undo Whisper tokenising glitches: '7 -elevens' -> '7-elevens', "y 'all" -> "y'all", 'what?.' -> 'what?'."""
    out = []
    for w in words:
        if out and (w['w'][:1] in "-'" and len(w['w']) > 1):
            out[-1] = {'w': out[-1]['w'].rstrip() + w['w'], 's': out[-1]['s'], 'e': w['e']}
            continue
        w = dict(w, w=re.sub(r'([?!])[.,]+$', r'\1', w['w']))
        if re.fullmatch(r'[-.,!?]+', w['w']):
            continue
        out.append(w)
    return out


def mask(text):
    return PROFANITY.sub(lambda m: m.group(0)[0] + '*' * (len(m.group(0)) - 1), text)


def is_story_word(word, hi):
    core = re.sub(r"[^A-Za-z0-9']", '', word)
    if not core:
        return False
    if any(part in hi for part in re.sub("[^a-z' ]", '', word.lower()).replace("'s", '').split()):
        return True
    acronym = re.fullmatch(r'[A-Z0-9]{2,4}s?', core) is not None and core not in ('OK', 'OH', 'NO', 'YO', 'MY', 'GOD', 'WHAT', 'THE', 'HOLY')
    return bool(re.search(r'\d', core)) or acronym


def apply_replacements(words, replace):
    """Fix misheard names across word boundaries (e.g. "Miner's Cave" becomes one word, "Minerscave")."""
    for pattern, repl in replace:
        i = 0
        while i < len(words):
            for n in range(min(3, len(words) - i), 0, -1):
                span = words[i:i + n]
                text = ' '.join(w['w'] for w in span)
                core = re.sub(r'[.,!?;:]+$', '', text)
                if not re.fullmatch(pattern, core, flags=re.I):
                    continue
                parts = re.sub(pattern, repl, core, flags=re.I).split()
                tail = text[len(core):]
                if len(parts) == 1:
                    words[i:i + n] = [{'w': parts[0] + tail, 's': span[0]['s'], 'e': span[-1]['e']}]
                elif len(parts) == n:
                    for w, part in zip(span, parts):
                        w['w'] = part
                    span[-1]['w'] += tail
                break
            i += 1
    return words


def phrases(words, max_words, max_chars, pause):
    out, cur = [], []
    for j, w in enumerate(words):
        cur.append(w)
        nxt = words[j + 1] if j + 1 < len(words) else None
        text = ' '.join(x['w'] for x in cur)
        if (nxt is None or re.search(r'[.,!?;:]$', w['w']) or len(cur) >= max_words
                or len(text) + 1 + len(nxt['w']) > max_chars or nxt['s'] - w['e'] > pause):
            out.append(cur)
            cur = []
    return out


def ass_time(t):
    t = max(0, t)
    return f'{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}'


def build_ass(groups, width, height, duration, args):
    size = round(width * args.size)
    margin = round(height * args.margin)
    hi = {h.lower() for h in args.highlight + args.also_highlight}
    colour = '&H00' + args.color[4:6] + args.color[2:4] + args.color[0:2] + '&'
    lines = ['[Script Info]', 'ScriptType: v4.00+', f'PlayResX: {width}', f'PlayResY: {height}', 'WrapStyle: 0', '',
             '[V4+ Styles]',
             'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
             f"Style: Sub,TTS Cap XBold,{size},&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,{max(2, round(size / 15))},2,2,{round(width * 0.08)},{round(width * 0.08)},{margin},1",
             '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text']
    for k, g in enumerate(groups):
        start = g[0]['s']
        nxt = groups[k + 1][0]['s'] if k + 1 < len(groups) else duration
        end = nxt if nxt - g[-1]['e'] <= args.hold else g[-1]['e'] + 0.4
        shown = [w['w'] if args.keep_profanity else mask(w['w']) for w in g]
        text = ' '.join('{\\c' + colour + '}' + t + '{\\c&H00FFFFFF&}' if is_story_word(w['w'], hi) else t
                        for w, t in zip(g, shown))
        lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(min(end, duration))},Sub,,0,0,0,,{{\\fscx75\\fscy75\\t(0,80,\\fscx100\\fscy100)}}{text}")
    return '\n'.join(lines) + '\n'


def caption(path, args):
    name = os.path.splitext(os.path.basename(path))[0]
    out = os.path.join(args.out_dir, f"{re.sub(r'[^A-Za-z0-9]+', '-', name).strip('-').lower()}{args.suffix}.mp4")
    width, height = map(int, run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path]).split(',')[:2])
    duration = float(run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]))
    words = transcribe(path, args.model)
    if args.fill_model and args.fill_model != args.model:
        words = fill_gaps(words, transcribe(path, args.fill_model))
    words = apply_replacements(clean(words), REPLACE + [tuple(r.split('=', 1)) for r in args.replace])
    words = apply_fixes(words, args.fix)
    groups = phrases(words, args.max_words, args.max_chars, args.pause)
    ass = os.path.join(args.work, f'{name}.ass')
    with open(ass, 'w') as f:
        f.write(build_ass(groups, width, height, duration, args))
    print(f"{os.path.basename(path)} -> {out}\n  {' | '.join(' '.join(w['w'] if args.keep_profanity else mask(w['w']) for w in g) for g in groups)}")
    if args.dry_run:
        return
    sub = ass.replace('\\', '/').replace(':', '\\:').replace("'", "\\'")
    run(['ffmpeg', '-v', 'error', '-y', '-i', path, '-map', '0:v:0', '-map', '0:a?', '-vf', f"subtitles='{sub}':fontsdir={FONT_DIR}",
         '-fps_mode', 'passthrough', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'copy',
         '-map_metadata', '0', '-movflags', '+faststart', out])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('inputs', nargs='+', help='video files or folders of videos')
    parser.add_argument('--out-dir', required=True)
    parser.add_argument('--suffix', default='-captioned')
    parser.add_argument('--work', default='/tmp/caption-work')
    parser.add_argument('--model', default='medium.en')
    parser.add_argument('--fill-model', default='small.en', help="fill the primary model's dropouts with this model ('' to skip)")
    parser.add_argument('--fix', action='append', default=[], metavar='FIND=>REPLACE', help='correct a misheard phrase; an empty REPLACE deletes it (e.g. background lyrics)')
    parser.add_argument('--max-words', type=int, default=4)
    parser.add_argument('--max-chars', type=int, default=22)
    parser.add_argument('--pause', type=float, default=0.5, help='start a new phrase after a pause this long')
    parser.add_argument('--hold', type=float, default=1.0, help='keep a phrase up through pauses shorter than this')
    parser.add_argument('--size', type=float, default=0.081, help='font size as a fraction of video width')
    parser.add_argument('--margin', type=float, default=0.255, help='bottom margin as a fraction of video height')
    parser.add_argument('--color', default='FFE100', help='highlight colour, RRGGBB')
    parser.add_argument('--highlight', nargs='*', default=HIGHLIGHT, help='words shown in the highlight colour')
    parser.add_argument('--also-highlight', nargs='*', default=[], help='extra story words for this batch')
    parser.add_argument('--keep-profanity', action='store_true', help='show swear words in full (masked by default; audio is never changed)')
    parser.add_argument('--replace', action='append', default=[], metavar='REGEX=TEXT', help='extra caption spelling fixes')
    parser.add_argument('--dry-run', action='store_true', help='print the phrases and write the .ass only')
    args = parser.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    os.makedirs(args.work, exist_ok=True)
    ensure_fonts()
    files = []
    for p in args.inputs:
        files += sorted(os.path.join(p, f) for f in os.listdir(p) if f.lower().endswith(('.mp4', '.mov', '.m4v'))) if os.path.isdir(p) else [p]
    for f in files:
        caption(f, args)


if __name__ == '__main__':
    main()
