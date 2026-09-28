const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const csv = require('csv-parser');

const db = new sqlite3.Database('./file_tracker.db');

let importedCount = 0;

fs.createReadStream('legacy_files.csv')
  .pipe(csv())
  .on('data', (row) => {
    const query = `INSERT OR IGNORE INTO files (file_code, title, category, type, physical_location, digital_path) 
                   VALUES (?, ?, ?, ?, ?, ?)`;
    db.run(query, [row.file_code, row.title, row.category, row.type, row.physical_location, row.digital_path], (err) => {
      if (err) console.error('Error importing row:', err.message);
      else importedCount++;
    });
  })
  .on('end', () => {
    console.log(`Successfully imported legacy files into SQLite!`);
  });