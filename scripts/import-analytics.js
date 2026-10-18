#!/usr/bin/env node
// Imports YouTube Studio CSV exports from analytics/inbox/ and rebuilds the performance brief.
require('dotenv').config();

const path = require('path');
const chalk = require('chalk');
const { importAnalytics, analyticsRoot } = require('../utils/manual-analytics');

async function main() {
  const root = analyticsRoot();
  const result = await importAnalytics({ root });
  if (!result.files.length) {
    console.log(chalk.yellow(`No CSV files in ${path.join(root, 'inbox')}. Rebuilt insights from previously imported data.`));
  }
  for (const file of result.files) console.log(chalk.green(`Imported ${file.records} row(s) from ${file.file}`));
  console.log(`Tracking ${result.videoCount} video(s); ${result.linkedCount} linked to a generated package.`);
  console.log(`Insights: ${path.join(root, 'insights.md')}`);
  if (result.brief.promptText) {
    console.log(chalk.cyan('\nBrief used for the next videos:\n') + result.brief.promptText);
  }
}

main().catch(error => {
  console.error(chalk.red('Analytics import failed:'), error.message);
  process.exit(1);
});
