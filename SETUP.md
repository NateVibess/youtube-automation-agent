# Setup

How to run this fork locally, which secrets it needs, and the security notes from our review of upstream v2.11.0 (commit `6f76e1c`).

## Run it

Requires Node.js 18 or newer (tested on 22). FFmpeg comes bundled through `ffmpeg-static`. Set `FFMPEG_PATH` to override it.

```bash
npm ci
cp .env.example .env
npm test              # 48 offline tests, no keys needed
npm run lint
npm start             # dashboard at http://127.0.0.1:3456
npm run walkthrough   # guided credential + YouTube OAuth setup
```

With no keys, `npm start` runs the dashboard in **setup mode**. The UI, `/health`, and the read APIs work, and generation and publishing stay disabled until credentials are configured. You can check this with `curl http://127.0.0.1:3456/health`, which returns `"status":"setup_required"`.

Other entry points:

- `npm run scheduler` runs the daily cron automation.
- `npm run agent:<name>` runs a single pipeline stage: `strategy`, `script`, `thumbnail`, `seo`, `production`, `publishing`, or `analytics`.
- `npm run credentials:setup` is the non-guided credential prompt.

## Secrets

Put these in `.env`, or enter them through `npm run walkthrough`, which stores them in `config/credentials.json` and `config/tokens.json` with `0600` permissions. All three files are gitignored. Never commit them.

### Required to generate and publish

- **YouTube OAuth client ID and secret.** Create them in Google Cloud as an OAuth client of type **Desktop app**, and enable **YouTube Data API v3** and **YouTube Analytics API**. The walkthrough runs the OAuth consent flow on a loopback URL.
- **One AI text provider key**, any one of these:
  - `OPENAI_API_KEY`
  - `GEMINI_API_KEY`
  - `OPENROUTER_API_KEY`
  - `MOONSHOT_API_KEY` (Kimi)
  - `MIMO_API_KEY`
  - `GLM_API_KEY`

  OpenAI or Gemini also covers image generation and TTS. With any other provider you need a separate TTS key below.

### Optional

- **TTS:** `ELEVENLABS_API_KEY` with `ELEVENLABS_VOICE_ID`, or `AZURE_SPEECH_KEY` with `AZURE_SPEECH_REGION`.
- **AI video clips:** `REPLICATE_API_TOKEN` (Seedance), `MINIMAX_API_KEY`, `KLING_ACCESS_KEY` with `KLING_SECRET_KEY`, or `DASHSCOPE_API_KEY` (Wan). Gemini video uses `GEMINI_API_KEY`. The default `VIDEO_PROVIDER=slideshow` is local and free.
- **Other:** `NOTIFICATION_WEBHOOK_URL`, and `API_KEY` for dashboard auth (see below).

## Security notes

- **Set `API_KEY`.** Without it, the generation, approval, and publishing routes are unauthenticated, and the app logs `API_KEY is not set; mutating API routes are unprotected`. When it is set, clients must send it in the `x-api-key` header.
- **Keep the dashboard on localhost.** It binds to `127.0.0.1` by default. Don't set `HOST=0.0.0.0`, or expose port 3456 through a tunnel or reverse proxy, unless `API_KEY` is set. Even then, prefer an SSH tunnel.
- **YouTube scopes are broad.** The OAuth flow requests `youtube.upload`, `youtube`, `youtube.readonly`, `yt-analytics.readonly`, and `youtube.force-ssl`. Together these let the app upload videos, edit channel content, and post comment replies. Uploads and replies go through a human approval gate. Keep `DEFAULT_PRIVACY_STATUS=private` while you evaluate, and consider using a test channel. You can revoke access at <https://myaccount.google.com/permissions>.
- **Dependency advisories.** `npm audit --omit=dev` reports 30 advisories at the current lockfile: 2 low, 9 moderate, 17 high, and 2 critical. The critical ones are `tar` (via `sqlite3`) and `proxy-addr`. Including dev dependencies, the total is 35. Most have non-breaking fixes through `npm audit fix`. `sqlite3` and `sharp` need major version bumps. These are not patched in this fork yet.
- **Other findings.** We found no install hooks and no credential exfiltration. Network calls only go to the providers you configure. Telemetry is opt-in and needs both an enable flag and an HTTPS endpoint. Child processes are expected: FFmpeg runs through `execFile`, browser-open helpers open the OAuth or local URL, and the optional DarkzSEO adapter spawns Python only when `DARKZSEO_PATH` is set.
