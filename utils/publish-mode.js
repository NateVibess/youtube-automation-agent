// PUBLISH_MODE=manual (default): the pipeline ends at a ready-to-post package in
// output/ and never needs YouTube OAuth. PUBLISH_MODE=youtube restores direct upload.
function getPublishMode() {
  return String(process.env.PUBLISH_MODE || 'manual').trim().toLowerCase() === 'youtube'
    ? 'youtube'
    : 'manual';
}

function isManualPublishMode() {
  return getPublishMode() === 'manual';
}

module.exports = { getPublishMode, isManualPublishMode };
