const fs = require('fs');
const path = require('path');

const source = './file_tracker.db';
const backupDir = './backups';

if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);

const filename = `backup-${new Date().toISOString().slice(0,10)}.db`;
fs.copyFileSync(source, path.join(backupDir, filename));
console.log(`Backup completed: ${filename}`);