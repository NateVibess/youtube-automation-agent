#!/usr/bin/env node
// One ranking Short from Reddit clips. Does not upload and does not use a voiceover.
require('dotenv').config();

const chalk = require('chalk');
const { createRankingShort } = require('../utils/ranking-short-compositor');

const USAGE = `Usage: npm run ranking-short -- --theme "pool fails" [--count 6] [--subreddit Whatcouldgowrong]

  --theme      What to rank. Searches Reddit titles for the theme words (default: pool fails).
  --count      How many clips, from 5 to 8 (default: 6, about 20 seconds, matching the example).
  --subreddit  Subreddit to search (default: Whatcouldgowrong).
  --exclude    Comma-separated post ids to skip.

Needs ffmpeg and yt-dlp (pip install yt-dlp). Does not need an AI key.
Writes a ready-to-post folder under output/ with video.mp4, title.txt, description.txt, tags.txt, and CHECKLIST.md.
The description credits every clip (subreddit, author, permalink).`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      args[key] = inline !== undefined ? inline : argv[i + 1];
      if (inline === undefined) i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const result = await createRankingShort({
    theme: args.theme || 'pool fails',
    count: args.count,
    subreddit: args.subreddit,
    excludeIds: args.exclude,
    logger: {
      info: message => console.log(chalk.cyan(message))
    }
  });
  console.log(chalk.green(`\nDone: "${result.title}" (${Math.round(result.duration)}s)`));
  console.log(chalk.green(`Post package: ${result.packageDir}`));
  console.log('Open CHECKLIST.md in that folder, then confirm the credits in description.txt before posting.');
  return 0;
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    console.error(chalk.red(error.message || error));
    process.exit(1);
  });
