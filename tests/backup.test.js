// Backup & restore round-trip: download a snapshot, prove it is a real SQLite
// file, restore those exact bytes, and confirm the registry survives intact.
// NOTE: restoring supersedes every logged-in session (single-session policy),
// so browsers signed in at the time will need to log in again afterwards.
const base = 'http://localhost:3000';
const results = [];
function ok(name, cond, detail) {
  results.push(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
}
async function j(method, p, body, token) {
  const res = await fetch(base + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { 'Authorization': 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

(async () => {
  const login = await j('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  ok('admin login', login.status === 200 && !!login.data.token);
  const token = login.data.token;

  // 1. Download snapshot
  const bakRes = await fetch(base + '/api/backup/download', { headers: { 'Authorization': 'Bearer ' + token } });
  const buf = Buffer.from(await bakRes.arrayBuffer());
  ok('backup downloaded', bakRes.status === 200 && buf.length > 1000, buf.length + ' bytes');

  // 2. It must be a genuine SQLite database file
  const magic = buf.slice(0, 15).toString('latin1');
  ok('snapshot is SQLite format', magic === 'SQLite format 3', JSON.stringify(magic));

  // 3. Registry state before restore
  const before = await j('GET', '/api/files', undefined, token);
  ok('files readable before restore', before.status === 200 && Array.isArray(before.data), 'count=' + (before.data && before.data.length));
  const codesBefore = (before.data || []).map(f => f.file_code).sort();

  // 4. Restore the same bytes -> 200
  const restoreRes = await fetch(base + '/api/backup/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Authorization': 'Bearer ' + token },
    body: buf
  });
  const restoreData = await restoreRes.json().catch(() => null);
  ok('restore accepted', restoreRes.status === 200, 'status=' + restoreRes.status + ' ' + JSON.stringify(restoreData));

  // 5. Session was superseded by the restore -> fresh login, state intact
  const login2 = await j('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  ok('fresh login after restore', login2.status === 200 && !!login2.data.token);
  const token2 = login2.data && login2.data.token;
  const after = await j('GET', '/api/files', undefined, token2);
  const codesAfter = (after.data || []).map(f => f.file_code).sort();
  ok('registry identical after round-trip',
    JSON.stringify(codesBefore) === JSON.stringify(codesAfter),
    `${codesBefore.length} -> ${codesAfter.length}`);

  console.log(results.join('\n'));
  const fails = results.filter(r => r.startsWith('FAIL')).length;
  console.log(fails === 0 ? 'ALL TESTS PASSED' : fails + ' TEST(S) FAILED');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('SCRIPT ERROR:', e); process.exit(2); });
