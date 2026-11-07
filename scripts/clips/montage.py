#!/usr/bin/env python3
"""Build voiced 1080x1920 game-promo Shorts from short landscape gameplay clips.

Each Short is a list of sentences, each with one or more library clips. The voiceover is made sentence
by sentence with edge-tts and packed tightly; every sentence's time is split evenly across its clips,
so a new shot starts about every 1.5s. Gameplay is fitted over a blurred copy of itself, captions show
one word at a time, and the Roblox game page card plus a "CODE: ..." box appear during the CTA.
Nothing is uploaded.
"""
import argparse, asyncio, json, os, re, subprocess, sys, urllib.request, wave

import numpy as np
import edge_tts

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = os.path.expanduser('~/.cache/clips-fonts')
TIKTOK_SANS = 'https://github.com/google/fonts/raw/main/ofl/tiktoksans/TikTokSans%5Bopsz,slnt,wdth,wght%5D.ttf'
SR = 48000
FPS = 30


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"{' '.join(cmd)[:500]}\n{r.stderr[-2000:]}")
    return r


def ensure_fonts():
    """Static SemiBold/ExtraBold instances of TikTok Sans with distinct family names for libass."""
    os.makedirs(FONT_DIR, exist_ok=True)
    wanted = {'CapSemi.ttf': ('TTS Cap Semi', 600), 'CapXBold.ttf': ('TTS Cap XBold', 800)}
    if all(os.path.exists(os.path.join(FONT_DIR, f)) for f in wanted):
        return
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer
    variable = os.path.join(FONT_DIR, 'TikTokSans-variable.ttf')
    if not os.path.exists(variable):
        urllib.request.urlretrieve(TIKTOK_SANS, variable)
    for filename, (family, weight) in wanted.items():
        font = instancer.instantiateVariableFont(TTFont(variable), {'wght': weight, 'wdth': 100, 'slnt': 0, 'opsz': 12})
        names = font['name']
        names.names = [n for n in names.names if n.nameID not in (1, 2, 4, 6, 16, 17)]
        for name_id, value in [(1, family), (2, 'Regular'), (4, family), (6, family.replace(' ', '')), (16, family), (17, 'Regular')]:
            names.setName(value, name_id, 3, 1, 0x409)
        if 'STAT' in font:
            del font['STAT']
        font['OS/2'].usWeightClass = 400
        font.save(os.path.join(FONT_DIR, filename))


async def tts(text, out, voice, rate):
    communicate = edge_tts.Communicate(text, voice, rate=rate, boundary='WordBoundary')
    words = []
    with open(out, 'wb') as f:
        async for chunk in communicate.stream():
            if chunk['type'] == 'audio':
                f.write(chunk['data'])
            elif chunk['type'] == 'WordBoundary':
                words.append({'w': chunk['text'], 's': chunk['offset'] / 1e7, 'e': (chunk['offset'] + chunk['duration']) / 1e7})
    return words


def decode(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'], capture_output=True).stdout
    return np.frombuffer(raw, np.float32).copy()


def ass_time(t):
    t = max(0, t)
    return f'{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}'


def check_rules(cfg, preset, total):
    text = ' '.join(s['text'] for s in cfg['sentences'])
    problems = []
    if preset.get('creator') and preset['creator'].lower() not in text.lower():
        problems.append(f"script never says {preset['creator']}")
    if preset.get('code') and preset['code'] not in text:
        problems.append(f"script never says code {preset['code']}")
    if not preset.get('minSeconds', 0) <= total <= preset.get('maxSeconds', 1e9):
        problems.append(f"duration {total}s is outside {preset.get('minSeconds')}-{preset.get('maxSeconds')}s")
    for p in problems:
        print(f"WARNING {cfg['name']}: {p}")


def build(cfg, opts, preset, manifest):
    files = {f['id']: f for f in manifest['files']}
    name = cfg['name']
    work = os.path.join(opts.work, name)
    os.makedirs(work, exist_ok=True)
    code = preset.get('code', 'CREATOR')

    voice = np.zeros(SR * 120, np.float32)
    t, words, spans, gap = 0.0, [], [], 0.07
    for i, sentence in enumerate(cfg['sentences']):
        mp3 = os.path.join(work, f's{i}.mp3')
        ws = asyncio.run(tts(sentence['text'], mp3, opts.voice, opts.rate))
        audio = decode(mp3)
        lead, end = ws[0]['s'], ws[-1]['e']
        seg = audio[int(lead * SR): int((end + 0.06) * SR)]
        voice[int(t * SR): int(t * SR) + len(seg)] += seg
        words += [{'w': w['w'], 's': t + w['s'] - lead, 'e': t + w['e'] - lead} for w in ws]
        spans.append(t)
        gap = sentence.get('gap', 0.07)
        t += end - lead + gap
    total = round(t - gap + cfg.get('tail', 0.8), 2)
    voice = voice[: int(total * SR)]
    voice *= 0.89 / max(1e-6, np.abs(voice).max())
    with wave.open(os.path.join(work, 'voice.wav'), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(voice, -1, 1) * 32767).astype(np.int16).tobytes())

    bounds = [0.0] + spans[1:] + [total]
    shots = []
    for i, sentence in enumerate(cfg['sentences']):
        step = (bounds[i + 1] - bounds[i]) / len(sentence['clips'])
        for k, clip in enumerate(sentence['clips']):
            f0 = round((bounds[i] + k * step) * FPS)
            f1 = round((bounds[i] + (k + 1) * step) * FPS)
            shots.append({**clip, 't0': f0 / FPS, 'frames': f1 - f0})

    segments = []
    for k, shot in enumerate(shots):
        meta = files[shot['id']]
        source = os.path.join(opts.library, os.path.basename(meta['url']))
        dur = shot['frames'] / FPS
        offset = min(shot.get('at', 0), max(0, meta.get('dur', 0) - dur - 0.1))
        zoom = shot.get('zoom', 0.07)
        post = []
        if shot.get('lift'): post.append(f"eq=gamma={shot['lift']}:saturation=1.15")
        if shot.get('bw'): post.append('hue=s=0,eq=contrast=1.15')
        if shot.get('flash'): post.append('fade=in:st=0:d=0.18:color=white')
        graph = (f"[0:v]fps={FPS},setpts=PTS-STARTPTS,split[a][b];"
                 "[a]scale=-2:480,crop=270:480,boxblur=12:2,scale=1080:1920,eq=brightness=-0.10:saturation=1.1[bg];"
                 f"[b]crop=ih*1.1:ih,scale=1080:-2,scale=w='trunc(1080*(1+{zoom}*t/{dur:.3f})/2)*2':h=-2:eval=frame,crop=1080:982[fg];"
                 "[bg][fg]overlay=(W-w)/2:(H-h)/2" + ''.join(',' + p for p in post) + ',format=yuv420p[out]')
        out = os.path.join(work, f'shot{k:02d}.mp4')
        run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{offset:.3f}', '-i', source, '-t', f'{dur:.4f}', '-filter_complex', graph,
             '-map', '[out]', '-map', '0:a', '-af', f'aresample={SR},aformat=channel_layouts=stereo,apad', '-frames:v', str(shot['frames']),
             '-t', f'{dur:.4f}', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-r', str(FPS), '-c:a', 'aac', '-b:a', '160k', out])
        segments.append(out)
    concat = os.path.join(work, 'concat.txt')
    with open(concat, 'w') as f:
        f.writelines(f"file '{p}'\n" for p in segments)
    run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concat, '-c', 'copy', os.path.join(work, 'base.mp4')])

    highlight = {h.lower() for h in cfg.get('highlight', [])}
    cta_t = spans[cfg['cta_sentence']]
    code_word = next(w for w in words if w['w'].strip('.,!?').upper() == code.upper())
    lines = ['[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1080', 'PlayResY: 1920', 'WrapStyle: 2', '', '[V4+ Styles]',
             'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
             'Style: Cap,TTS Cap Semi,92,&H00FFFFFF,&H00FFFFFF,&H00141414,&H64000000,0,0,0,0,100,100,0,0,1,4.5,2,5,40,40,0,1',
             'Style: Code,TTS Cap XBold,70,&H00000000,&H00000000,&H0000D4FF,&H0000D4FF,0,0,0,0,100,100,1,0,3,22,0,5,40,40,0,1',
             '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text']
    for j, w in enumerate(words):
        text = re.sub(r'[.,!?:;]+$', '', w['w'])
        end = min(words[j + 1]['s'], w['s'] + 0.9) if j + 1 < len(words) else min(total, w['e'] + 0.6)
        colour = r'{\c&H003C3CF0&}' if text.lower() in highlight else ''
        lines.append(f"Dialogue: 2,{ass_time(w['s'])},{ass_time(end)},Cap,,0,0,0,,{{\\pos(540,1190)\\fscx88\\fscy88\\t(0,70,\\fscx100\\fscy100)}}{colour}{text}")
    lines.append(f"Dialogue: 1,{ass_time(code_word['s'])},{ass_time(total)},Code,,0,0,0,,{{\\pos(540,1540)\\fad(120,0)\\fscx80\\fscy80\\t(0,120,\\fscx100\\fscy100)}}CODE: {code}")
    captions = os.path.join(work, 'captions.ass')
    with open(captions, 'w') as f:
        f.write('\n'.join(lines) + '\n')

    sfx = []
    for ev in cfg.get('sfx', []):
        at = shots[ev['shot']]['t0'] if 'shot' in ev else cta_t - ev['before'] if 'before' in ev else cta_t if ev.get('t') in ('cta', 'card') else ev.get('t', 0)
        sfx.append((os.path.join(opts.assets, ev['f']), max(0, at), ev.get('v', 0.6)))
    inputs = ['-i', os.path.join(work, 'base.mp4'), '-i', os.path.join(work, 'voice.wav'),
              '-ss', str(cfg.get('music_at', 0)), '-i', os.path.join(opts.assets, cfg['music']), '-loop', '1', '-t', str(total), '-i', opts.card]
    for path, _, _ in sfx:
        inputs += ['-i', path]
    graph = [f"[3:v]format=rgba,fade=in:st={cta_t:.2f}:d=0.25:alpha=1[card]",
             f"[0:v][card]overlay=(W-w)/2:330:enable='gte(t,{cta_t:.2f})',subtitles={captions}:fontsdir={FONT_DIR}[vout]",
             f"[0:a]volume={cfg.get('game_vol', 0.3)}[ga]",
             "[1:a]aresample=48000,aformat=channel_layouts=stereo,highpass=f=90,acompressor=threshold=0.1:ratio=3:attack=5:release=80:makeup=1.4,asplit[vo][vsc]",
             f"[2:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:{total},volume={cfg.get('music_vol', 0.16)},afade=t=out:st={total - 0.6:.2f}:d=0.6[mraw]",
             "[mraw][vsc]sidechaincompress=threshold=0.02:ratio=6:attack=10:release=300[mu]"]
    mix = ['[ga]', '[vo]', '[mu]']
    for k, (_, at, vol) in enumerate(sfx):
        ms = int(at * 1000)
        graph.append(f"[{4 + k}:a]aresample=48000,aformat=channel_layouts=stereo,volume={vol},adelay={ms}|{ms}[s{k}]")
        mix.append(f'[s{k}]')
    graph.append(f"{''.join(mix)}amix=inputs={len(mix)}:normalize=0:duration=first,alimiter=limit=0.95,loudnorm=I=-14:TP=-1.5:LRA=11[aout]")
    out = os.path.join(opts.out, f'{name}.mp4')
    run(['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', ';'.join(graph), '-map', '[vout]', '-map', '[aout]',
         '-t', str(total), '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', str(FPS),
         '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', out])
    check_rules(cfg, preset, total)
    print(f'{out}: {total}s, {len(shots)} shots, CTA at {cta_t:.1f}s')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('config', help='JSON list of Shorts, e.g. scripts/clips/minerscave-shorts.json')
    parser.add_argument('names', nargs='*', help='only build these Shorts')
    parser.add_argument('--library', required=True, help='folder from fetch-bloxclips.js with manifest.json and the clips')
    parser.add_argument('--assets', required=True, help='folder with the music and sound effect files named in the config')
    parser.add_argument('--card', help='Roblox game page card PNG (default: <library>/roblox-card.png)')
    parser.add_argument('--preset', default='minerscave')
    parser.add_argument('--work', default='/tmp/montage')
    parser.add_argument('--out', default='/tmp/montage/out')
    parser.add_argument('--voice', default='en-US-AndrewNeural')
    parser.add_argument('--rate', default='+14%')
    opts = parser.parse_args()
    opts.card = opts.card or os.path.join(opts.library, 'roblox-card.png')
    os.makedirs(opts.out, exist_ok=True)
    ensure_fonts()
    with open(os.path.join(HERE, 'presets.json')) as f:
        preset = json.load(f).get(opts.preset, {})
    with open(os.path.join(opts.library, 'manifest.json')) as f:
        manifest = json.load(f)
    with open(opts.config) as f:
        configs = json.load(f)
    for cfg in configs:
        if not opts.names or cfg['name'] in opts.names:
            build(cfg, opts, preset, manifest)


if __name__ == '__main__':
    main()
