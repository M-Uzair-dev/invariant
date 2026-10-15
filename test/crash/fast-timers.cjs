// Preloaded into the crash-test child process only (node -r). The expiry and
// reconciliation workers use a hard-coded @Interval of 10 minutes; this makes
// them tick fast so a test can watch them run, crash and recover.
const realSetInterval = global.setInterval;
const fastMs = Number(process.env.CRASH_FAST_INTERVAL_MS || 300);

global.setInterval = function (fn, ms, ...args) {
  return realSetInterval(fn, ms === 600000 ? fastMs : ms, ...args);
};
