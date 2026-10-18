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

## Layout

- **Corner webcam detected:** a split screen. The chart crop goes on top, above the webcam and left of the TradingView watchlist. Set `CLIPS_CHART_RIGHT=0.745` to change that edge. The face goes on the bottom, with a hook box on the seam and word-by-word captions above the face.
- **Otherwise:** a single 9:16 crop centred on the face.
- **Captions:** profanity is masked in captions only, and the audio is untouched. Set `CLIPS_KEEP_PROFANITY=1` to disable masking.
