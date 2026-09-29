// Retention schedule + formal disposal tests. Self-cleaning: downloads a
// pre-test backup and restores it at the end (the DISPOSED test record can
// never be deleted through the API, so restore is the only clean exit).
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = 'http://localhost:3000';
const BACKUP_FILE = path.join(os.tmpdir(), 'archivex-pre-disposal.bak');
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
  const staff = await j('POST', '/api/auth/login', { username: 'officer1', password: 'staff123' });
  const staffToken = staff.data && staff.data.token;

  // Pre-test backup + baseline (also proves the backup endpoint itself works)
  const bakRes = await fetch(base + '/api/backup/download', { headers: { 'Authorization': 'Bearer ' + token } });
  const bakBuf = Buffer.from(await bakRes.arrayBuffer());
  fs.writeFileSync(BACKUP_FILE, bakBuf);
  ok('pre-test backup downloaded', bakRes.status === 200 && bakBuf.length > 1000, bakBuf.length + ' bytes');
  const pre = await j('GET', '/api/files', undefined, token);
  const preCount = pre.data.length;
  // Baseline of already-disposed records (demo data may legitimately ship
  // with one, e.g. LEG-2026-042) so later checks compare against it.
  const preDisposed = await j('GET', '/api/files?status=DISPOSED', undefined, token);
  const baseDisposed = preDisposed.data.length;

  // --- 1. Create with retention dates ---
  const r1 = await j('POST', '/api/files', { file_code: 'RET-TEST-001', title: 'Past Retention Record', category: 'HR', type: 'PHYSICAL', physical_location: 'Cabinet T 1', retention_due: '2020-01-01' }, token);
  ok('create with past retention', r1.status === 200 && r1.data.success, JSON.stringify(r1.data));
  const r2 = await j('POST', '/api/files', { file_code: 'RET-TEST-002', title: 'Future Retention Record', category: 'Finance', type: 'DIGITAL', retention_due: '2099-12-31' }, token);
  ok('create with future retention', r2.status === 200 && r2.data.success);
  const r3 = await j('POST', '/api/files', { file_code: 'RET-TEST-003', title: 'Bad Retention Record', category: 'Legal', type: 'PHYSICAL', retention_due: 'soonish' }, token);
  ok('bad retention date rejected', r3.status === 400, 'status=' + r3.status);

  // --- 2. Stats + disposal filter ---
  const st1 = await j('GET', '/api/dashboard/stats', undefined, token);
  ok('stats: 1 disposal due', st1.data.disposal_due_files === 1, 'due=' + st1.data.disposal_due_files + ' disposed=' + st1.data.disposed_files);
  const dueList = await j('GET', '/api/files?disposal=1', undefined, token);
  ok('disposal filter returns only past-due', Array.isArray(dueList.data) && dueList.data.length === 1 && dueList.data[0].file_code === 'RET-TEST-001', 'n=' + (dueList.data && dueList.data.length));

  // --- 3. Update semantics: '' clears, absent leaves alone ---
  const u1 = await j('PUT', `/api/files/${r2.data.id}`, { title: 'Future Retention Record', category: 'Finance', type: 'DIGITAL', is_classified: 0, retention_due: '' }, token);
  const filesA = await j('GET', '/api/files?search=RET-TEST-002', undefined, token);
  ok('PUT empty clears retention', u1.status === 200 && (filesA.data[0].retention_due === null || filesA.data[0].retention_due === ''), 'val=' + filesA.data[0].retention_due);
  const u2 = await j('PUT', `/api/files/${r1.data.id}`, { title: 'Past Retention Record', category: 'HR', type: 'PHYSICAL', is_classified: 0 }, token);
  const filesB = await j('GET', '/api/files?search=RET-TEST-001', undefined, token);
  ok('PUT absent retention leaves value', u2.status === 200 && filesB.data[0].retention_due === '2020-01-01', 'val=' + filesB.data[0].retention_due);

  // --- 4. Disposal: staff forbidden, PIN two-step, then DISPOSED ---
  const staffTry = await j('POST', `/api/files/${r1.data.id}/dispose`, { pin_code: '1234' }, staffToken);
  ok('dispose blocked for staff', staffTry.status === 403, 'status=' + staffTry.status);

  const noPin = await j('POST', `/api/files/${r1.data.id}/dispose`, {}, token);
  ok('dispose without PIN -> PIN_REQUIRED', noPin.status === 403 && noPin.data.code === 'PIN_REQUIRED', JSON.stringify(noPin.data));

  const badPin = await j('POST', `/api/files/${r1.data.id}/dispose`, { pin_code: '0000' }, token);
  ok('wrong PIN -> PIN_INVALID', badPin.status === 403 && badPin.data.code === 'PIN_INVALID', JSON.stringify(badPin.data));

  const goodPin = await j('POST', `/api/files/${r1.data.id}/dispose`, { pin_code: '1234' }, token);
  ok('correct PIN disposes', goodPin.status === 200 && goodPin.data.status === 'DISPOSED', JSON.stringify(goodPin.data));

  // --- 5. Post-disposal state ---
  const st2 = await j('GET', '/api/dashboard/stats', undefined, token);
  ok('stats after dispose', st2.data.disposal_due_files === 0 && st2.data.disposed_files === baseDisposed + 1, 'due=' + st2.data.disposal_due_files + ' disposed=' + st2.data.disposed_files);
  const due2 = await j('GET', '/api/files?disposal=1', undefined, token);
  ok('disposed record leaves due list', due2.data.length === 0, 'n=' + due2.data.length);
  const disList = await j('GET', '/api/files?status=DISPOSED', undefined, token);
  ok('disposed filter finds it', disList.data.length === baseDisposed + 1 && disList.data.some(f => f.file_code === 'RET-TEST-001'), 'n=' + disList.data.length);

  const again = await j('POST', `/api/files/${r1.data.id}/dispose`, { pin_code: '1234' }, token);
  ok('double dispose -> 409', again.status === 409 && again.data.code === 'ALREADY_DISPOSED', JSON.stringify(again.data));

  const out = await j('POST', '/api/files/action', { file_code: 'RET-TEST-001', action: 'CHECK_OUT' }, token);
  ok('disposed record cannot be checked out', out.status === 400 && out.data.code === 'DISPOSED', JSON.stringify(out.data));

  // --- 6. Checked-out guard on disposal (pick an available non-classified file) ---
  const all = await j('GET', '/api/files', undefined, token);
  const candidate = all.data.find(f => f.status === 'AVAILABLE' && f.is_classified === 0);
  const co = await j('POST', '/api/files/action', { file_code: candidate.file_code, action: 'CHECK_OUT' }, token);
  ok('check out candidate', co.status === 200, candidate.file_code + ' status=' + co.status);
  const disBlocked = await j('POST', `/api/files/${candidate.id}/dispose`, { pin_code: '1234' }, token);
  ok('checked-out record cannot be disposed', disBlocked.status === 409 && disBlocked.data.code === 'CHECKED_OUT', JSON.stringify(disBlocked.data));

  // --- 7. Audit: DISPOSE log row survives with denormalized code + PIN confirmer ---
  const logs = await j('GET', '/api/logs?limit=50', undefined, token);
  const disLog = (logs.data || []).find(l => l.action === 'DISPOSE' && l.file_code === 'RET-TEST-001');
  ok('DISPOSE audit row written', !!disLog && /Quick-PIN confirmed by/.test(disLog.notes || ''), disLog ? disLog.notes.slice(0, 90) : 'missing');

  // --- 8. CSV import with retention column ---
  const csv = [
    'file_code,title,category,type,retention_due,physical_location,digital_path',
    'RET-CSV-001,Bulk Retention Alpha,HR,PHYSICAL,2021-05-05,Cabinet R 1,',
    'RET-CSV-002,Bulk Retention Beta,Finance,DIGITAL,soon,Cabinet R 2,'
  ].join('\n');
  const imp = await j('POST', '/api/files/import', { csv }, token);
  ok('CSV import with retention', imp.status === 200 && imp.data.imported === 1 && imp.data.skipped.length === 1, JSON.stringify(imp.data));
  const csvSkipReason = imp.data.skipped[0] ? imp.data.skipped[0].reason : '';
  ok('bad CSV retention skipped with reason', /retention_due must be YYYY-MM-DD/.test(csvSkipReason), csvSkipReason);
  const csvFile = await j('GET', '/api/files?search=RET-CSV-001', undefined, token);
  ok('imported retention stored', csvFile.data.length === 1 && csvFile.data[0].retention_due === '2021-05-05', 'val=' + (csvFile.data[0] && csvFile.data[0].retention_due));
  const st3 = await j('GET', '/api/dashboard/stats', undefined, token);
  ok('stats: due now = RET-CSV-001 only', st3.data.disposal_due_files === 1, 'due=' + st3.data.disposal_due_files);

  // --- 9. Cleanup: restore pre-test backup (removes DISPOSED + checked-out test rows) ---
  const restoreRes = await fetch(base + '/api/backup/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Authorization': 'Bearer ' + token },
    body: bakBuf
  });
  ok('backup restored (cleanup)', restoreRes.status === 200, 'status=' + restoreRes.status);

  const login2 = await j('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const token2 = login2.data && login2.data.token;
  const after = await j('GET', '/api/files', undefined, token2);
  const codes2 = (after.data || []).map(f => f.file_code);
  ok('test rows gone after restore', !codes2.some(c => /^(RET-TEST|RET-CSV)/.test(c)), 'files=' + codes2.length);
  ok('file count back to pre-test', after.data.length === preCount, 'files=' + after.data.length + ' expected=' + preCount);
  const disAfter = await j('GET', '/api/files?status=DISPOSED', undefined, token2);
  ok('no disposed leftovers', disAfter.data.length === baseDisposed, 'n=' + disAfter.data.length + ' expected=' + baseDisposed);

  try { fs.unlinkSync(BACKUP_FILE); } catch (e) {}
  console.log(results.join('\n'));
  const fails = results.filter(r => r.startsWith('FAIL')).length;
  console.log(fails === 0 ? 'ALL TESTS PASSED' : fails + ' TEST(S) FAILED');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('SCRIPT ERROR:', e); process.exit(2); });
