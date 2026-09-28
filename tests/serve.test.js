// Serve & security tests: docs/ folder file serving, branded not-found page,
// viewer new-tab targets, path-traversal guard, API auth regression.
// Requires: server running on :3000. Creates and deletes docs/_e2e_test.pdf.
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const BASE = 'http://localhost:3000';
const TEST_FILE = path.join(ROOT, 'docs', '_e2e_test.pdf');
const PDF_BYTES = '%PDF-1.4\n%ARCHIVEX e2e test file\n%%EOF\n';

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(BASE + '/');
      if (r.status === 200) return true;
    } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

// Raw http GET (fetch normalizes "../", which would fake the traversal test)
function rawGet(p) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: 'localhost', port: 3000, path: p }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

(async () => {
  if (!(await waitForServer())) { console.log('SERVER NOT REACHABLE on :3000 - start it first (npm start)'); process.exit(1); }

  // 1. Home page served
  let r = await fetch(BASE + '/');
  record('home 200', r.status === 200, `status ${r.status}`);

  // 2. Missing docs/ file -> branded page (404), never white "Cannot GET"
  r = await fetch(BASE + '/docs/legal/patents_2026.pdf');
  let body = await r.text();
  record('missing /docs file -> 404 branded', r.status === 404 && body.includes('Digital copy not found') && !body.includes('Cannot GET'), `status ${r.status}`);

  // 3. Real file placed in docs/ is served with correct type
  fs.mkdirSync(path.dirname(TEST_FILE), { recursive: true });
  fs.writeFileSync(TEST_FILE, PDF_BYTES);
  r = await fetch(BASE + '/docs/_e2e_test.pdf');
  body = await r.text();
  record('real file in docs/ -> 200', r.status === 200 && body.includes('ARCHIVEX e2e test file'), `status ${r.status}, type ${r.headers.get('content-type')}`);
  fs.unlinkSync(TEST_FILE);

  // 4. Deleted file -> branded 404 again
  r = await fetch(BASE + '/docs/_e2e_test.pdf');
  record('deleted file -> 404 branded', r.status === 404 && (await r.text()).includes('Digital copy not found'), `status ${r.status}`);

  // 5. Path traversal cannot escape docs/ (raw path, encoded honestly)
  let tr = await rawGet('/docs/../server.js');
  const leaked = tr.body.includes("require('express')") || tr.body.includes('Office File Tracker server running');
  record('traversal blocked', tr.status === 403 && !leaked, `status ${tr.status}, leaked ${leaked}`);

  // 6. Any other missing file-like path -> branded page
  r = await fetch(BASE + '/random/whatever.pdf');
  body = await r.text();
  record('random missing file -> branded (no Cannot GET)', r.status === 404 && body.includes('Digital copy not found') && !body.includes('Cannot GET'), `status ${r.status}`);

  // 7. Viewer public + digital button opens in a new tab
  r = await fetch(BASE + '/view/LEG-2026-042');
  body = await r.text();
  record('/view public + new tab button', r.status === 200 && /target="_blank"/.test(body), `status ${r.status}`);

  // 8. Classified viewer unlock link also target=_blank
  r = await fetch(BASE + '/view/HR-2026-001');
  body = await r.text();
  record('classified viewer new tab', body.includes('id="digitalLink" target="_blank"'), `status ${r.status}`);

  // 9. API guarded without token
  r = await fetch(BASE + '/api/files');
  record('api without token -> 401', r.status === 401, `status ${r.status}`);

  // 10. Login + authenticated reads (regression)
  r = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const login = await r.json();
  record('admin login works', !!login.token, String(r.status));
  if (login.token) {
    const hdr = { Authorization: 'Bearer ' + login.token };
    r = await fetch(BASE + '/api/dashboard/stats', { headers: hdr });
    record('dashboard stats 200', r.status === 200, `status ${r.status}`);
    r = await fetch(BASE + '/api/files', { headers: hdr });
    const files = await r.json();
    record('files list readable', Array.isArray(files) && files.length > 0, `count ${Array.isArray(files) ? files.length : 'n/a'}`);
  }

  // 11. Unknown viewer code -> its own friendly not-found
  r = await fetch(BASE + '/view/NOPE-000');
  record('unknown view code -> Document Not Found', r.status === 404 && (await r.text()).includes('Document Not Found'), `status ${r.status}`);

  const fails = results.filter(x => !x.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('SCRIPT ERROR', e); process.exit(1); });
