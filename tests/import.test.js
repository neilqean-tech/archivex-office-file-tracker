// CSV bulk import endpoint tests. Self-cleaning: downloads a pre-test backup
// and restores it at the end (restore supersedes all login sessions).
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = 'http://localhost:3000';
const BACKUP_FILE = path.join(os.tmpdir(), 'archivex-pre-import.bak');
const results = [];

function ok(name, cond, detail) {
  results.push(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
}

async function j(method, p, body, token) {
  const res = await fetch(base + p, {
    method,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      token ? { 'Authorization': 'Bearer ' + token } : {}
    ),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

(async () => {
  // 1. Login
  const login = await j('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  ok('admin login', login.status === 200 && login.data.token, 'status=' + login.status);
  const token = login.data.token;

  // 2. Staff login (for 403 check)
  const staffLogin = await j('POST', '/api/auth/login', { username: 'officer1', password: 'staff123' });
  const staffToken = staffLogin.data && staffLogin.data.token;
  ok('staff login', !!staffToken);

  // 3. Pre-test backup (used for cleanup via restore) + baseline count
  const bakRes = await fetch(base + '/api/backup/download', { headers: { 'Authorization': 'Bearer ' + token } });
  const bakBuf = Buffer.from(await bakRes.arrayBuffer());
  fs.writeFileSync(BACKUP_FILE, bakBuf);
  ok('pre-test backup downloaded', bakRes.status === 200 && bakBuf.length > 1000, bakBuf.length + ' bytes');
  const preFiles = await j('GET', '/api/files', undefined, token);
  const preCount = preFiles.data.length;

  // 4. No auth -> 401
  const noAuth = await j('POST', '/api/files/import', { csv: 'file_code,title\nX,Y' });
  ok('import requires auth', noAuth.status === 401, 'status=' + noAuth.status);

  // 5. Staff -> 403
  const staff = await j('POST', '/api/files/import', { csv: 'file_code,title\nX,Y' }, staffToken);
  ok('import blocked for staff', staff.status === 403, 'status=' + staff.status);

  // 6. Missing columns -> 400
  const missCols = await j('POST', '/api/files/import', { csv: 'code,title\nDOC-1,Thing' }, token);
  ok('missing columns rejected', missCols.status === 400 && /Missing required column/.test(missCols.data.error || ''), missCols.data && missCols.data.error);

  // 7. Mixed CSV (BOM on header line) -> imported 2, skipped 4
  const BOM = '\uFEFF';
  const csv = BOM + [
    'file_code,title,category,type,physical_location,digital_path',
    'CSV-TEST-001,Bulk Imported Alpha,HR,PHYSICAL,Cabinet Z Shelf 9,',
    'CSV-TEST-002,Bulk Imported Beta,Finance,DIGITAL,,/docs/test/beta.pdf',
    'CSV-TEST-001,Duplicate Code Row,HR,PHYSICAL,,',
    'CSV-TEST-003,,HR,PHYSICAL,,',
    'CSV-TEST-004,Bad Type Row,HR,MEGADRIVE,,',
    'CSV-TEST-005,Missing Category Row,,PHYSICAL,,'
  ].join('\n') + '\n';
  const imp = await j('POST', '/api/files/import', { csv }, token);
  ok('mixed import partial success', imp.status === 200 && imp.data.imported === 2 && imp.data.skipped.length === 4,
    `status=${imp.status} imported=${imp.data && imp.data.imported} skipped=${imp.data && imp.data.skipped.length} msg="${imp.data && imp.data.message}"`);
  const reasons = ((imp.data && imp.data.skipped) || []).map(s => s.reason).join(' | ');
  ok('skip reasons sensible', /duplicate code inside this file/.test(reasons) && /title is required/.test(reasons) && /type must be/.test(reasons) && /category is required/.test(reasons), reasons);

  // 8. Files present in registry
  const files = await j('GET', '/api/files', undefined, token);
  const codes = (files.data || []).map(f => f.file_code);
  ok('imported records in registry', codes.includes('CSV-TEST-001') && codes.includes('CSV-TEST-002'), 'count=' + codes.length);

  // 9. REGISTER audit rows with denormalized file_code
  const logs = await j('GET', '/api/logs?limit=100', undefined, token);
  const reg = (logs.data || []).filter(l => l.action === 'REGISTER' && /^CSV-TEST/.test(l.file_code || '') && /CSV bulk import/.test(l.notes || ''));
  ok('REGISTER audit entries created', reg.length === 2, 'found=' + reg.length);

  // 10. Re-import same CSV -> 400, everything already in registry / invalid
  const again = await j('POST', '/api/files/import', { csv }, token);
  ok('re-import rejected cleanly', again.status === 400 && again.data.skipped.length === 6,
    `status=${again.status} skipped=${again.data && again.data.skipped.length} msg="${again.data && again.data.error}"`);

  // 11. Restore pre-test backup -> imported rows + their logs gone
  const restoreRes = await fetch(base + '/api/backup/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Authorization': 'Bearer ' + token },
    body: bakBuf
  });
  const restoreData = await restoreRes.json().catch(() => null);
  ok('backup restored (cleanup)', restoreRes.status === 200, 'status=' + restoreRes.status + ' ' + JSON.stringify(restoreData));

  // 12. After restore: fresh login (sv bumped), verify clean state
  const login2 = await j('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const token2 = login2.data && login2.data.token;
  const files2 = await j('GET', '/api/files', undefined, token2);
  const codes2 = (files2.data || []).map(f => f.file_code);
  ok('test rows gone after restore', !codes2.some(c => /^CSV-TEST/.test(c)), 'files=' + codes2.length);
  const logs2 = await j('GET', '/api/logs?limit=200', undefined, token2);
  const leftover = (logs2.data || []).filter(l => /^CSV-TEST/.test(l.file_code || ''));
  ok('test audit rows gone after restore', leftover.length === 0, 'leftover=' + leftover.length);
  ok('file count back to pre-test', files2.data.length === preCount, 'files=' + files2.data.length + ' expected=' + preCount);

  try { fs.unlinkSync(BACKUP_FILE); } catch (e) {}
  console.log(results.join('\n'));
  const fails = results.filter(r => r.startsWith('FAIL')).length;
  console.log(fails === 0 ? 'ALL TESTS PASSED' : fails + ' TEST(S) FAILED');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('SCRIPT ERROR:', e); process.exit(2); });
