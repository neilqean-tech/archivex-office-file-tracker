// Dev utility: syntax-check every inline <script> block in an HTML file.
// Usage:  node tests/check_scripts.js [path/to/file.html]
// Default: public/index.html (run automatically as part of `npm test`).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const target = process.argv[2] || path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(target, 'utf8');
const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m, i = 0, ok = true;

while ((m = re.exec(html)) !== null) {
  i++;
  const tmp = path.join(os.tmpdir(), 'chk_inline_' + i + '.js');
  fs.writeFileSync(tmp, m[1]);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    console.log('script #' + i + ' OK (' + m[1].length + ' chars)');
  } catch (e) {
    ok = false;
    console.log('script #' + i + ' FAILED:\n' + (e.stderr ? e.stderr.toString() : e.message));
  }
  fs.unlinkSync(tmp);
}
console.log(path.relative(process.cwd(), target) + ': ' + (ok ? 'ALL SCRIPTS SYNTAX OK' : 'SYNTAX ERRORS FOUND'));
process.exit(ok ? 0 : 1);
