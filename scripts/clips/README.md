# Clips pipeline

A free pipeline that turns a creator's long stream into vertical Shorts. It needs no paid APIs. Gemini free-tier text is optional and has a heuristic fallback. It never uploads anything; review the output and publish through the dashboard's approval flow.

Only clip creators who allow it. TJR, for example, runs an official clipping campaign at <https://reachclipping.com/TJR>.

## Requirements

- Node 18+, FFmpeg, Python 3.10+.
- `pip install faster-whisper "opencv-python-headless<5"`
- `pip install yt-dlp`, only needed for YouTube sources.
- Optional: `GEMINI_API_KEY` in `.env` for moment selection.

## Usage

```bash
W=/tmp/clips/run1
npm run clips -- fetch-kick --work $W --channel tjr --index 0 --start 480 --duration 1500
npm run clips -- transcribe --work $W
npm run clips -- select --work $W --count 4 --creator TJR
npm run clips -- render --work $W          # writes $W/out/clip-N.mp4 and rendered.json
```

You can edit `$W/clips.json` before rendering to change the timings or the on-screen `hook`.

`fetch-youtube --url URL [--cookies cookies.txt]` uses yt-dlp. Cloud IPs are usually blocked by YouTube's bot check, so export cookies from a signed-in browser, or run it on a home connection.

`fetch-drive --id FILE_ID` downloads one public Google Drive file with `gdown` (`pip install gdown`). List a shared folder with `gdown --folder URL`.

`--preset pbinvesting` selects 15–30s clips, adds `#PBInvesting` and `@PBinvesting` to the metadata, and burns in "NOT FINANCIAL ADVICE" when the clip is about trading. `--preset tjr` keeps the 30–60s default.

## Game promo Shorts (BloxClips campaigns)

`montage.py` builds voiced 15–30s Shorts from a library of short landscape gameplay clips, such as the BloxClips Minerscave campaign. It follows the BloxClips "formats to copy":

- the voice starts on the first frame;
- a new shot comes about every 1.5s;
- captions show one word at a time;
- sound effects play on cuts;
- music runs under the whole video;
- the Roblox game page is on screen for "go play it".

Gameplay is fitted over a blurred copy of itself, and a `CODE: CREATOR` box appears when the code is spoken.

```bash
pip install edge-tts fonttools numpy
L=/tmp/bloxclips/minerscave
node scripts/clips/fetch-bloxclips.js minerscave-campaign $L --card https://www.roblox.com/games/85709371593349/Minerscave --ids 73648165ef2b,16e12caa3938
node scripts/clips/fetch-bloxclips.js first-person-boxing-campaign /tmp/bloxclips/assets --folders "Music,Sound effects"
python3 scripts/clips/montage.py scripts/clips/minerscave-shorts.json --library $L --assets /tmp/bloxclips/assets --out /tmp/montage/out
```

Run `fetch-bloxclips.js` without `--ids` to download the whole library, which is about 3 GB for Minerscave. Cloudflare blocks curl, so files are fetched inside a headed Chrome window. On a server, run it under a display such as Xvfb, and set `CHROME_PATH` if Chrome is not in the default location.

To use your own voiceover for a Short instead of text-to-speech, add `--voice-file minerscave-1=recording.m4a`. This needs faster-whisper.
- **Timing:** Whisper (`small.en`) times each word, and pauses longer than 0.22s are shortened. Each new sentence starts the next group of shots, and the sentence that matches the script's CTA brings in the end card.
- **Captions:** they show what you actually said. Misheard words close to a script word take the script's spelling, so a misheard "mindscape" still shows as Minerscave.
- **Rewording:** extra or missing sentences are reconciled with the script automatically.

### High-energy Shorts (Huss Valley)

`huss-valley-shorts.json` with `--preset huss-valley` makes Shorts where something happens on nearly every beat. These are the options it uses:

| Option | Where it goes | What it does |
|---|---|---|
| `"layout": "fill"` | Short | Crops gameplay to fill 9:16. The per-clip `cx` setting (0–1) moves the crop sideways. |
| `pops` | sentence | A list of beats. Each one is tied to the first spoken word starting with `word`, and can show a `text` badge (`color`/`textcolor` in ASS BGR) and an `img` from the library. It can add a `flash`, a zoom punch (on by default) and a sound effect (`sfx`). |
| `word` | clip | Cuts to that clip on that spoken word instead of splitting the sentence evenly. |
| `cut_sfx` | Short | Plays a sound on every cut. |
| `captions` | Short | Caption font, size, y position, outline and highlight colour. |
| `pop_size` | Short | Popup text size. |
| `card` | Short | The CTA image. `bounce` makes it pop in large, for example the island code card. |

Sound effects can be library files or `gen:whoosh`, `gen:ding`, `gen:impact` or `gen:tick`, which are synthesized with FFmpeg. The build prints the longest gap without a cut, popup or sound effect, so dead air is easy to spot.

```bash
node scripts/clips/fetch-bloxclips.js huss-valley-campaign /tmp/hv/lib
python3 scripts/clips/montage.py scripts/clips/huss-valley-shorts.json --preset huss-valley --library /tmp/hv/lib --assets /tmp/hv/lib --rate +18%
```

Each Short in `minerscave-shorts.json` lists its sentences, the clip ids and start offsets under each sentence, and the music and sound effects. The Minerscave library has no music or sound effects, so the example uses the ones from the BloxClips boxing campaign. `--preset minerscave` is the default and warns when a Short falls outside 15–30s or never says "Minerscave" or the code.

## Layout

- **Corner webcam detected:** a split screen. The chart crop goes on top, above the webcam and left of the TradingView watchlist. Set `CLIPS_CHART_RIGHT=0.745` to change that edge. The face goes on the bottom, with a hook box on the seam and word-by-word captions above the face.
- **Otherwise:** a single 9:16 crop centred on the face.
- **Captions:** profanity is masked in captions only, and the audio is untouched. Set `CLIPS_KEEP_PROFANITY=1` to disable masking.
