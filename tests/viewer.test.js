// Viewer page tests: layout contract across record states.
// Requires: server running on :3000 + the SAMPLE dataset
// (LEG-2026-042 public/digital, HR-2026-001 classified, DOC-2026-328 physical).
// LEG's digital_path is read live, so user edits to that field are tolerated.
const path = require('path');
const sqlite3 = require('sqlite3');

const ROOT = path.join(__dirname, '..');
const BASE = 'http://localhost:3000';
const results = [];
const record = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`); };

async function waitUp() {
    for (let i = 0; i < 30; i++) { try { if ((await fetch(BASE + '/')).status === 200) return true; } catch (e) {} await new Promise(r => setTimeout(r, 400)); }
    return false;
}

function getLegPath() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(path.join(ROOT, 'file_tracker.db'));
        db.get(`SELECT digital_path FROM files WHERE file_code='LEG-2026-042'`, (e, r) => { db.close(); e ? reject(e) : resolve(r && r.digital_path); });
    });
}

(async () => {
    if (!(await waitUp())) { console.log('SERVER NOT REACHABLE on :3000 - start it first (npm start)'); process.exit(1); }

    // --- State 1: public + openable digital copy (LEG) ---
    let html = await (await fetch(BASE + '/view/LEG-2026-042')).text();
    record('LEG: hero title h1 text-xl', html.includes('text-xl font-bold text-slate-900'));
    record('LEG: single meta line (category · type)', /mt-1\.5">[^<]+ · [A-Z]+/.test(html));
    record('LEG: no standalone type chip', !html.includes('>DIGITAL</span>'));
    record('LEG: details card wrapper', html.includes('rounded-xl border border-slate-200 overflow-hidden divide-y divide-slate-100'));
    record('LEG: icon rows (location + digital)', html.includes('Storage location') && html.includes('Digital copy') && html.includes('📍') && html.includes('💾'));

    const currentPath = await getLegPath();
    if (currentPath && /^https?:\/\//i.test(currentPath)) {
        record('LEG: open button new tab + correct href', html.includes(`href="${currentPath}" target="_blank"`), currentPath.slice(0, 50));
    } else if (currentPath) {
        record('LEG: open button new tab + correct href', html.includes(`href="${currentPath}" target="_blank"`), currentPath.slice(0, 50));
    } else {
        // physical-only path: no button expected
        record('LEG: no button when no digital path', !html.includes('Open Digital Document'));
    }
    record('LEG: old centered boxes gone', !html.includes('Digital Reference') && !html.includes('Physical Location:'));

    // --- State 2: classified (HR) - unlock contract ---
    html = await (await fetch(BASE + '/view/HR-2026-001')).text();
    const ids = ['locBox', 'locVal', 'pinGate', 'gatePin', 'gateBtn', 'gateErr', 'digitalLink'];
    record('HR: all JS contract ids present', ids.every(id => html.includes(`id="${id}"`)), ids.filter(id => !html.includes(`id="${id}"`)).join(',') || 'all');
    record('HR: locBox hidden pre-unlock', /id="locBox" class="hidden /.test(html));
    record('HR: pin gate visible pre-unlock', html.includes('Quick-PIN Required'));
    record('HR: digitalLink hidden + new tab', /id="digitalLink" target="_blank" class="hidden/.test(html));
    record('HR: revealed button has explicit block display', /class="hidden mt-2 block w-full/.test(html));
    record('HR: classified marker in meta line', html.includes('🔒 Classified'));
    record('HR: unlock script still attached', html.includes("getElementById('gateBtn')") && html.includes('/unlock'));

    // --- State 3: physical-only (DOC) ---
    html = await (await fetch(BASE + '/view/DOC-2026-328')).text();
    record('DOC: physical-only note', html.includes('This is a physical-only file. Original copy is in storage.'));
    record('DOC: no open button', !html.includes('Open Digital Document'));
    record('DOC: meta shows type', html.includes('PHYSICAL'));

    // --- Card structure basics ---
    html = await (await fetch(BASE + '/view/LEG-2026-042')).text();
    record('card padding/spacing generous', html.includes('p-7 rounded-2xl') && html.includes('space-y-5'));
    record('rows padded p-4', html.includes('class="p-4"'));
    record('footer unchanged', html.includes('← Open Office File Tracker Dashboard'));

    const fails = results.filter(r => !r.pass);
    console.log(`\n${results.length - fails.length}/${results.length} passed`);
    // Set exitCode and let the process end naturally: forcing process.exit()
    // while sqlite3's libuv handles are still tearing down trips a harmless
    // Windows assertion (async.c) that overrides the exit code with a crash.
    process.exitCode = fails.length ? 1 : 0;
})().catch(e => { console.error('ERROR', e); process.exitCode = 1; });
