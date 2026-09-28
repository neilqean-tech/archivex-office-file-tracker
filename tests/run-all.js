// Runs the whole test suite in order. Requires the server on :3000 first
// (start-server.bat or `npm start`). Total runtime: ~30 seconds.
//
// Order matters: serve/viewer are read-only checks; import/disposal create
// test records and restore a pre-test backup afterwards; backup round-trips
// the database. Each suite logs in fresh, so an open browser session will be
// signed out when the suite finishes (single-session policy) - log in again.
const { spawnSync } = require('child_process');
const path = require('path');

const BASE = 'http://localhost:3000';
const SUITES = [
  'check_scripts.js',  // inline <script> syntax in public/index.html (no server needed)
  'serve.test.js',     // file serving, 404s, traversal guard, API auth
  'viewer.test.js',    // /view/:code layout contract (all record states)
  'import.test.js',    // CSV bulk import + audit rows (self-restoring)
  'disposal.test.js',  // retention + disposal + PIN gate (self-restoring)
  'backup.test.js',    // backup download / restore round-trip
];

async function serverUp() {
  for (let i = 0; i < 15; i++) {
    try { if ((await fetch(BASE + '/')).status === 200) return true; } catch (e) { /* not yet */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

(async () => {
  if (!(await serverUp())) {
    console.log('Server is not running on ' + BASE);
    console.log('Start it first:  start-server.bat   (or  npm start )');
    process.exit(1);
  }

  const failed = [];
  for (const suite of SUITES) {
    console.log('\n=== ' + suite + ' ===');
    const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
    if (r.status !== 0) failed.push(suite);
  }

  console.log('\n========================================');
  console.log('Suites passed: ' + (SUITES.length - failed.length) + '/' + SUITES.length);
  if (failed.length) {
    console.log('Failed: ' + failed.join(', '));
    process.exit(1);
  }
  console.log('ALL SUITES PASSED');
  process.exit(0);
})().catch(e => { console.error('RUNNER ERROR', e); process.exit(1); });
