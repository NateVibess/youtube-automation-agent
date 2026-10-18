# Analytics feedback loop

Drop YouTube Studio exports here so new videos learn from what already worked.

1. In YouTube Studio open **Analytics → Advanced mode**, pick the date range, keep the **Content** tab (one row per video), and add these metrics: Views, Impressions, Impressions click-through rate (%), Average view duration, Average percentage viewed (%), Watch time (hours), Subscribers.
2. Click **Export current view → Comma-separated values (.csv)**. Unzip it and copy `Table data.csv` into `analytics/inbox/` (name it with the export date, e.g. `2026-10-18.csv`: files import in name order, so newer numbers win).
3. Run `npm run analytics:import`.

The import archives each file into `analytics/imported/`, keeps the latest numbers per video in `performance.json`, and writes:

- `insights.md`: a readable table plus the exact brief that will be fed to the AI.
- `performance-brief.json`: the brief used by the next `npm run video` run (topic choice, title, hook/structure, description, thumbnail text ideas).

## No CSV? Use the template

Copy `template.csv` into `inbox/`, fill one row per video from your screenshots, and import. Only `video_title` (or `youtube_video_id`) is required; leave unknown cells blank. Durations can be `3:12` or seconds. Put anything you noticed in `notes` (e.g. "comments loved #1 pick", "retention cliff at 0:40").

## Matching analytics to generated videos

Rows are matched to packages in `output/` by title. If you changed the title when posting, add a row to `video-map.csv` with the package ID (in the package's `CHECKLIST.md`) and the YouTube video ID (the part after `watch?v=`, also the "Content" column in Studio exports).
