#!/usr/bin/env node
// Generates one video end to end without the dashboard and prints the post package folder.
require('dotenv').config();

const chalk = require('chalk');
const { YouTubeAutomationAgent } = require('../index');
const { isManualPublishMode } = require('../utils/publish-mode');

const USAGE = `Usage: npm run video -- [--topic "Top 10 ..."] [--style list] [--length short|medium|long]

  --topic   What the video is about. Omit to let the strategy agent pick (uses analytics/insights).
  --style   list | explainer | tutorial | review | story (default: DEFAULT_CONTENT_STYLE or list)
  --length  short (2-4 min) | medium (8-12 min) | long (15-20 min) (default: DEFAULT_VIDEO_LENGTH_KEY or medium)`;

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
  if (!isManualPublishMode()) {
    console.log(chalk.yellow('PUBLISH_MODE=youtube is set: this run will also use the YouTube upload workflow.'));
  }

  const agent = new YouTubeAutomationAgent();
  const ready = await agent.initialize({ scheduler: false });
  if (!ready || agent.setupRequired) {
    const missing = agent.credentials?.getMissingCredentials?.() || [];
    console.error(chalk.red(`\nCannot generate yet. Missing: ${missing.join(', ') || 'see the log above'}.`));
    console.error('Add a key to .env (for example GEMINI_API_KEY=...) and run again.');
    return 1;
  }

  const job = await agent.startGenerationJob({
    topic: args.topic || null,
    style: args.style || process.env.DEFAULT_CONTENT_STYLE || 'list',
    length: args.length || process.env.DEFAULT_VIDEO_LENGTH_KEY || 'medium',
    source: 'cli'
  });
  console.log(chalk.cyan(`\nGeneration job ${job.id} started...`));
  const finished = await agent.waitForGenerationJob(job.id);

  if (finished.status !== 'completed') {
    console.error(chalk.red(`\nGeneration ${finished.status}: ${finished.error || 'unknown error'}`));
    console.error(`Resume later from the dashboard (npm start) or rerun this command. Job: ${job.id}`);
    return 1;
  }

  const packageDir = finished.details?.packageDir;
  console.log(chalk.green(`\nDone: "${finished.title}" (review status: ${finished.details?.reviewStatus || 'n/a'})`));
  if (packageDir) {
    console.log(chalk.green(`Post package: ${packageDir}`));
    console.log('Open CHECKLIST.md in that folder before posting.');
  }
  return 0;
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
  });
