const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Readable } = require('stream');
const csv = require('csv-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'archivex-super-secret-key-2026';

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' })); // roomy enough for CSV bulk imports
app.use(express.static(path.join(__dirname, 'public')));

const dbPath = path.join(__dirname, 'file_tracker.db');
// `let`: a successful backup restore swaps in a fresh connection
let db = new sqlite3.Database(dbPath);

// Initialize Database Schema & Indices.
// Runs at boot AND after a backup restore (restored files may be older),
// so every statement must be idempotent (IF NOT EXISTS / non-fatal ALTERs).
function initializeSchema(handle, done) {
    done = done || function () {};
    handle.serialize(() => {
        // 1. Files Table
        handle.run(`CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_code TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        type TEXT CHECK(type IN ('PHYSICAL', 'DIGITAL', 'HYBRID')) NOT NULL,
        physical_location TEXT,
        digital_path TEXT,
        status TEXT DEFAULT 'AVAILABLE',
        is_classified INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

        // Column migrations for backward compatibility
        handle.run(`ALTER TABLE files ADD COLUMN is_classified INTEGER DEFAULT 0`, () => {});
        handle.run(`ALTER TABLE files ADD COLUMN updated_at DATETIME`, () => {});
        // Circulation custody: who currently holds the file and when it is due back
        handle.run(`ALTER TABLE files ADD COLUMN borrower_name TEXT`, () => {});
        handle.run(`ALTER TABLE files ADD COLUMN due_date TEXT`, () => {});
        // Retention schedule: when this record's legal retention period ends
        handle.run(`ALTER TABLE files ADD COLUMN retention_due TEXT`, () => {});

        // 2. Logs Table (Circulation & Audit Trail)
        handle.run(`CREATE TABLE IF NOT EXISTS file_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL,
        user_name TEXT NOT NULL,
        action TEXT NOT NULL,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(file_id) REFERENCES files(id)
    )`);

        handle.run(`ALTER TABLE file_logs ADD COLUMN notes TEXT`, () => {});
        // Denormalized code so audit rows stay readable after their file is deleted
        handle.run(`ALTER TABLE file_logs ADD COLUMN file_code TEXT`, () => {});
        // Session versioning: bumped on every password login, invalidating older tokens
        handle.run(`ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0`, () => {});

        // 3. Performance Indexes
        handle.run(`CREATE INDEX IF NOT EXISTS idx_files_code ON files(file_code)`);
        handle.run(`CREATE INDEX IF NOT EXISTS idx_files_status ON files(status)`);
        handle.run(`CREATE INDEX IF NOT EXISTS idx_files_category ON files(category)`);
        handle.run(`CREATE INDEX IF NOT EXISTS idx_logs_file_id ON file_logs(file_id)`);
        handle.run(`CREATE INDEX IF NOT EXISTS idx_logs_created ON file_logs(created_at)`);

        // 4. Users Table (Hybrid Authentication & Quick-PIN)
        handle.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        pin_code_hash TEXT,
        full_name TEXT NOT NULL,
        role TEXT CHECK(role IN ('ADMIN', 'STAFF')) NOT NULL DEFAULT 'STAFF',
        session_version INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
            if (err) return done();
            handle.get(`SELECT COUNT(*) AS count FROM users`, [], (err2, row) => {
                if (!err2 && row && row.count === 0) {
                    const adminPw = bcrypt.hashSync('admin123', 10);
                    const adminPin = bcrypt.hashSync('1234', 10);
                    const staffPw = bcrypt.hashSync('staff123', 10);
                    const staffPin = bcrypt.hashSync('5678', 10);

                    handle.run(
                        `INSERT INTO users (username, password_hash, pin_code_hash, full_name, role) VALUES (?, ?, ?, ?, ?)`,
                        ['admin', adminPw, adminPin, 'System Administrator', 'ADMIN']
                    );
                    handle.run(
                        `INSERT INTO users (username, password_hash, pin_code_hash, full_name, role) VALUES (?, ?, ?, ?, ?)`,
                        ['officer1', staffPw, staffPin, 'Records Officer Jane', 'STAFF']
                    );
                    console.log('Seeded default users: admin (admin123 / PIN 1234), officer1 (staff123 / PIN 5678)');
                }
                done();
            });
        });
    });
}

initializeSchema(db);

// ==========================================
// AUTHENTICATION MIDDLEWARE
// ==========================================
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        req.user = null;
        return next();
    }

    jwt.verify(token, JWT_SECRET, (err, payload) => {
        if (err) {
            req.user = null;
            return next();
        }

        // Single active session: the token's version must match the user's current
        // session_version (each password login bumps it, killing older tokens).
        // Loading from DB also means role changes / deletions apply immediately.
        db.get('SELECT id, username, full_name, role, session_version FROM users WHERE id = ?', [payload.id], (dbErr, user) => {
            if (dbErr || !user) {
                req.user = null;
                return next();
            }
            if (payload.sv !== user.session_version) {
                req.user = null;
                req.sessionSuperseded = true;
                return next();
            }
            req.user = { id: user.id, username: user.username, full_name: user.full_name, role: user.role };
            next();
        });
    });
}

function requireAuth(req, res, next) {
    if (!req.user) {
        if (req.sessionSuperseded) {
            return res.status(401).json({ error: 'Session expired or signed in elsewhere. Please log in again.', code: 'SESSION_SUPERSEDED' });
        }
        return res.status(401).json({ error: 'Authentication required. Please log in.' });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.user) {
        if (req.sessionSuperseded) {
            return res.status(401).json({ error: 'Session expired or signed in elsewhere. Please log in again.', code: 'SESSION_SUPERSEDED' });
        }
        return res.status(401).json({ error: 'Authentication required. Please log in.' });
    }
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Access denied: Administrator privileges required.' });
    }
    next();
}

app.use(authenticateToken);

// ==========================================
// AUTHENTICATION & USER MANAGEMENT API
// ==========================================

// POST /api/auth/login - Full username + password login (Admins & Staff)
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
    }

    // 🛡️ Brute-force guard: 5 failed attempts per IP -> 60s lockout (same policy as PINs)
    const loginRate = rateCheck('login', req);
    if (!loginRate.allowed) {
        return res.status(429).json({ error: `Too many failed login attempts. Try again in ${loginRate.retryAfter} second(s).`, code: 'LOGIN_LOCKED' });
    }

    db.get('SELECT * FROM users WHERE username = ?', [username.trim().toLowerCase()], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user || !user.password_hash) {
            rateFail('login', req);
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        const isValid = bcrypt.compareSync(password, user.password_hash);
        if (!isValid) {
            rateFail('login', req);
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        rateReset('login', req);

        // Single active session: bump the version so every previously issued
        // token for this account stops working immediately (latest login wins)
        const nextSv = (user.session_version || 0) + 1;
        db.run('UPDATE users SET session_version = ? WHERE id = ?', [nextSv, user.id], (updErr) => {
            if (updErr) return res.status(500).json({ error: updErr.message });

            const payload = {
                id: user.id,
                username: user.username,
                full_name: user.full_name,
                role: user.role,
                sv: nextSv
            };
            const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

            res.json({
                success: true,
                token,
                user: payload,
                message: `Welcome back, ${user.full_name}!`
            });
        });
    });
});

// ==========================================
// Quick-PIN brute-force protection (shared)
// ==========================================
// 5 failed attempts within 5 minutes -> 60-second lockout per IP.
// Bucketed by kind ('pin' for Quick-PIN endpoints, 'login' for password login)
// so a lockout in one channel doesn't block the other.
const AUTH_MAX_FAILS = 5;
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const AUTH_LOCKOUT_MS = 60 * 1000;
const attemptStore = new Map();

function rateCheck(kind, req) {
    const key = kind + '|' + (req.ip || 'unknown');
    const now = Date.now();
    const s = attemptStore.get(key);
    if (!s) return { allowed: true };
    if (s.lockedUntil) {
        if (now < s.lockedUntil) {
            return { allowed: false, retryAfter: Math.max(1, Math.ceil((s.lockedUntil - now) / 1000)) };
        }
        attemptStore.delete(key); // lockout expired -> fresh start
        return { allowed: true };
    }
    if (now - s.windowStart > AUTH_WINDOW_MS) attemptStore.delete(key); // window expired
    return { allowed: true };
}

function rateFail(kind, req) {
    const key = kind + '|' + (req.ip || 'unknown');
    const now = Date.now();
    let s = attemptStore.get(key);
    if (!s || now - s.windowStart > AUTH_WINDOW_MS) {
        s = { fails: 0, windowStart: now, lockedUntil: 0 };
        attemptStore.set(key, s);
    }
    s.fails += 1;
    if (s.fails >= AUTH_MAX_FAILS) s.lockedUntil = now + AUTH_LOCKOUT_MS;
}

function rateReset(kind, req) {
    attemptStore.delete(kind + '|' + (req.ip || 'unknown'));
}

// Quick-PIN aliases — used by every PIN-verified endpoint below
const pinRateCheck = req => rateCheck('pin', req);
const pinRateFail = req => rateFail('pin', req);
const pinRateReset = req => rateReset('pin', req);

// 🔒 Two-step Quick-PIN verification for sensitive destructive changes
// (declassification, classified record deletion). Any active account's
// Quick-PIN authorizes it; brute-force protected by the shared PIN rate
// limiter. Calls cb(confirmerName) on success, or responds 4xx.
// actionLabel customizes the user-facing messages for the caller's action.
function requireDeclassifyPin(req, res, pin_code, cb, actionLabel) {
    const label = actionLabel || 'Declassifying a document';
    if (!pin_code || typeof pin_code !== 'string' || !pin_code.trim()) {
        return res.status(403).json({
            error: `${label} requires Quick-PIN confirmation (two-step verification).`,
            code: 'PIN_REQUIRED'
        });
    }

    const rate = pinRateCheck(req);
    if (!rate.allowed) {
        return res.status(429).json({ error: `Too many failed PIN attempts. Try again in ${rate.retryAfter} second(s).`, code: 'PIN_LOCKED' });
    }

    db.all('SELECT id, username, pin_code_hash, full_name FROM users WHERE pin_code_hash IS NOT NULL', [], (err, users) => {
        if (err) return res.status(500).json({ error: err.message });

        const matched = (users || []).find(u => bcrypt.compareSync(pin_code.trim(), u.pin_code_hash));
        if (!matched) {
            pinRateFail(req);
            return res.status(403).json({ error: `Invalid Quick-PIN code. ${label} denied.`, code: 'PIN_INVALID' });
        }

        pinRateReset(req);
        cb(`${matched.full_name} (${matched.username})`);
    });
}

// POST /api/auth/verify-pin - Quick PIN authentication (Circulation Desk Kiosk)
app.post('/api/auth/verify-pin', (req, res) => {
    const { pin_code } = req.body;
    if (!pin_code || typeof pin_code !== 'string') {
        return res.status(400).json({ error: 'PIN code is required.' });
    }

    const rate = pinRateCheck(req);
    if (!rate.allowed) {
        return res.status(429).json({ error: `Too many failed PIN attempts. Try again in ${rate.retryAfter} second(s).`, code: 'PIN_LOCKED' });
    }

    db.all('SELECT id, username, pin_code_hash, full_name, role FROM users WHERE pin_code_hash IS NOT NULL', [], (err, users) => {
        if (err) return res.status(500).json({ error: err.message });

        const matched = users.find(u => bcrypt.compareSync(pin_code.trim(), u.pin_code_hash));
        if (!matched) {
            pinRateFail(req);
            return res.status(401).json({ error: 'Invalid Quick-PIN code. Access denied.' });
        }

        pinRateReset(req);

        res.json({
            success: true,
            user: {
                id: matched.id,
                username: matched.username,
                full_name: matched.full_name,
                role: matched.role
            }
        });
    });
});

// GET /api/auth/me - Validate current session token
app.get('/api/auth/me', (req, res) => {
    if (!req.user) {
        if (req.sessionSuperseded) {
            return res.status(401).json({ error: 'Session expired or signed in elsewhere. Please log in again.', code: 'SESSION_SUPERSEDED' });
        }
        return res.status(401).json({ error: 'No active session' });
    }
    res.json({ user: req.user });
});

// POST /api/auth/change-password - Self-service password change (any signed-in user)
// Verifies the current password, then bumps session_version so every other
// token for this account dies. A fresh token is returned for a seamless switch.
app.post('/api/auth/change-password', requireAuth, (req, res) => {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) {
        return res.status(400).json({ error: 'Current and new password are required.' });
    }
    if (String(new_password).length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }
    if (String(new_password) === String(current_password)) {
        return res.status(400).json({ error: 'New password must be different from the current one.' });
    }

    db.get('SELECT id, username, full_name, role, password_hash, session_version FROM users WHERE id = ?', [req.user.id], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user || !user.password_hash || !bcrypt.compareSync(String(current_password), user.password_hash)) {
            return res.status(403).json({ error: 'Current password is incorrect.' });
        }

        const nextSv = (user.session_version || 0) + 1;
        const newHash = bcrypt.hashSync(String(new_password), 10);

        db.run('UPDATE users SET password_hash = ?, session_version = ? WHERE id = ?', [newHash, nextSv, user.id], (updErr) => {
            if (updErr) return res.status(500).json({ error: updErr.message });
            const token = jwt.sign({ id: user.id, username: user.username, full_name: user.full_name, role: user.role, sv: nextSv }, JWT_SECRET, { expiresIn: '7d' });
            res.json({ success: true, token, message: 'Password changed. Any other sessions were signed out.' });
        });
    });
});

// GET /api/users - List staff members & administrators (Admin Only)
app.get('/api/users', requireAdmin, (req, res) => {
    db.all('SELECT id, username, full_name, role, created_at, (pin_code_hash IS NOT NULL) AS has_pin FROM users ORDER BY role ASC, full_name ASC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// POST /api/users - Create new staff or admin user (Admin Only)
app.post('/api/users', requireAdmin, (req, res) => {
    const { username, password, pin_code, full_name, role = 'STAFF' } = req.body;
    if (!username || !full_name) {
        return res.status(400).json({ error: 'Username and Full Name are required.' });
    }
    if (!password && !pin_code) {
        return res.status(400).json({ error: 'Either a password or a Quick-PIN must be provided.' });
    }

    const password_hash = password ? bcrypt.hashSync(password, 10) : null;
    const pin_code_hash = pin_code ? bcrypt.hashSync(pin_code.toString().trim(), 10) : null;
    const assignedRole = role === 'ADMIN' ? 'ADMIN' : 'STAFF';

    db.run(
        `INSERT INTO users (username, password_hash, pin_code_hash, full_name, role) VALUES (?, ?, ?, ?, ?)`,
        [username.trim().toLowerCase(), password_hash, pin_code_hash, full_name.trim(), assignedRole],
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: 'Username is already taken.' });
                }
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true, id: this.lastID, message: `User "${full_name}" registered successfully.` });
        }
    );
});

// DELETE /api/users/:id - Delete staff member (Admin Only)
app.delete('/api/users/:id', requireAdmin, (req, res) => {
    const targetId = parseInt(req.params.id, 10);
    if (req.user && req.user.id === targetId) {
        return res.status(400).json({ error: 'You cannot delete your own active administrator account.' });
    }

    db.run('DELETE FROM users WHERE id = ?', [targetId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'User not found.' });
        res.json({ success: true, message: 'User account removed.' });
    });
});

// PUT /api/users/:id/credentials - Reset a user's password and/or Quick-PIN (Admin Only)
// Bumps the target's session_version so their active sessions are signed out.
app.put('/api/users/:id/credentials', requireAdmin, (req, res) => {
    const targetId = parseInt(req.params.id, 10);
    const { password, pin_code } = req.body || {};
    const hasPassword = password !== undefined && password !== null && String(password).length > 0;
    const hasPin = pin_code !== undefined && pin_code !== null && String(pin_code).length > 0;

    if (!hasPassword && !hasPin) {
        return res.status(400).json({ error: 'Provide a new password and/or Quick-PIN.' });
    }
    if (hasPassword && String(password).length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    if (hasPin && !/^\d{4,6}$/.test(String(pin_code).trim())) {
        return res.status(400).json({ error: 'Quick-PIN must be 4 to 6 digits.' });
    }

    db.get('SELECT id, session_version FROM users WHERE id = ?', [targetId], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(404).json({ error: 'User not found.' });

        const nextSv = (user.session_version || 0) + 1;
        const sets = ['session_version = ?'];
        const vals = [nextSv];
        if (hasPassword) { sets.push('password_hash = ?'); vals.push(bcrypt.hashSync(String(password), 10)); }
        if (hasPin) { sets.push('pin_code_hash = ?'); vals.push(bcrypt.hashSync(String(pin_code).trim(), 10)); }
        vals.push(targetId);

        db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals, function(updErr) {
            if (updErr) return res.status(500).json({ error: updErr.message });
            if (this.changes === 0) return res.status(404).json({ error: 'User not found.' });

            let token = null;
            if (req.user.id === targetId) {
                // Admin reset their own credentials: hand back a fresh token
                token = jwt.sign({ id: req.user.id, username: req.user.username, full_name: req.user.full_name, role: req.user.role, sv: nextSv }, JWT_SECRET, { expiresIn: '7d' });
            }
            res.json({ success: true, token, message: hasPassword && hasPin ? 'Password and Quick-PIN reset.' : hasPassword ? 'Password reset.' : 'Quick-PIN reset.' });
        });
    });
});

// ==========================================
// BACKUP & RESTORE (Data Safety)
// ==========================================

// GET /api/backup/download - Download a consistent snapshot of the database (Admin)
app.get('/api/backup/download', requireAdmin, (req, res) => {
    const stamp = new Date().toISOString().slice(0, 10);
    const tmpPath = path.join(os.tmpdir(), `archivex-backup-${stamp}-${Date.now()}.db`);
    const attachmentName = `archivex-backup-${stamp}.db`;

    const streamFile = (file) => {
        res.download(file, attachmentName, () => {
            fs.unlink(file, () => {});
        });
    };

    // VACUUM INTO writes a transactionally consistent, defragmented copy
    db.run(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`, (err) => {
        if (!err) return streamFile(tmpPath);
        // Older SQLite builds lack VACUUM INTO — fall back to a raw copy
        try {
            fs.copyFileSync(dbPath, tmpPath);
            streamFile(tmpPath);
        } catch (e) {
            res.status(500).json({ error: 'Backup failed: ' + e.message });
        }
    });
});

// POST /api/backup/restore - Replace the live database with an uploaded backup (Admin)
// Raw binary body. Validates SQLite magic bytes + required tables first, keeps
// a .pre-restore-*.bak copy of the current data, then signs everyone out.
app.post('/api/backup/restore', requireAdmin, express.raw({ type: '*/*', limit: '64mb' }), (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 512) {
        return res.status(400).json({ error: 'No backup file received.' });
    }
    if (buf.slice(0, 16).toString('latin1') !== 'SQLite format 3\u0000') {
        return res.status(400).json({ error: 'That file is not a valid SQLite backup.' });
    }

    const tmpPath = path.join(os.tmpdir(), `archivex-restore-${Date.now()}.db`);
    try {
        fs.writeFileSync(tmpPath, buf);
    } catch (e) {
        return res.status(500).json({ error: 'Could not stage the backup: ' + e.message });
    }

    // Structural validation before touching live data
    const probe = new sqlite3.Database(tmpPath, sqlite3.OPEN_READONLY, (openErr) => {
        if (openErr) {
            fs.unlink(tmpPath, () => {});
            return res.status(400).json({ error: 'Backup file cannot be opened.' });
        }
        probe.get(
            `SELECT COUNT(DISTINCT name) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'files', 'file_logs')`,
            [],
            (probeErr, row) => {
                probe.close();
                if (probeErr || !row || row.n !== 3) {
                    fs.unlink(tmpPath, () => {});
                    return res.status(400).json({ error: 'Backup is missing required tables (users, files, file_logs).' });
                }
                swapInBackup(tmpPath, res);
            }
        );
    });
});

// Swap a validated backup into place: preserve the old file, reopen, migrate,
// and invalidate every session so restored data starts from a clean login.
function swapInBackup(tmpPath, res) {
    const previousPath = `${dbPath}.pre-restore-${Date.now()}.bak`;

    db.close(() => {
        let safetyOk = true;
        try {
            fs.copyFileSync(dbPath, previousPath); // keep a copy of what we're replacing
        } catch (e) {
            safetyOk = false;
        }

        try {
            fs.copyFileSync(tmpPath, dbPath);
        } catch (e) {
            // Roll back to the safety copy and reopen
            try { if (safetyOk) fs.copyFileSync(previousPath, dbPath); } catch (e2) { /* best effort */ }
            db = new sqlite3.Database(dbPath, () => initializeSchema(db));
            fs.unlink(tmpPath, () => {});
            return res.status(500).json({ error: 'Restore failed while swapping files: ' + e.message });
        }

        fs.unlink(tmpPath, () => {});
        db = new sqlite3.Database(dbPath, () => {
            initializeSchema(db, () => {
                db.run('UPDATE users SET session_version = session_version + 1', () => {
                    res.json({
                        success: true,
                        message: 'Backup restored. All sessions were signed out for safety.' +
                            (safetyOk ? ` Previous data kept as ${path.basename(previousPath)}.` : '')
                    });
                });
            });
        });
    });
}

// ==========================================
// DASHBOARD & ANALYTICS API
// ==========================================

// GET /api/dashboard/stats - Executive metrics & distributions
app.get('/api/dashboard/stats', requireAuth, (req, res) => {
    const summaryQuery = `
        SELECT 
            COUNT(*) AS total_files,
            SUM(CASE WHEN status = 'AVAILABLE' THEN 1 ELSE 0 END) AS available_files,
            SUM(CASE WHEN status = 'CHECKED_OUT' THEN 1 ELSE 0 END) AS checked_out_files,
            SUM(CASE WHEN is_classified = 1 THEN 1 ELSE 0 END) AS classified_files,
            SUM(CASE WHEN status = 'CHECKED_OUT' AND due_date IS NOT NULL AND due_date != '' AND due_date < date('now') THEN 1 ELSE 0 END) AS overdue_files,
            SUM(CASE WHEN retention_due IS NOT NULL AND retention_due != '' AND retention_due <= date('now') AND status != 'DISPOSED' THEN 1 ELSE 0 END) AS disposal_due_files,
            SUM(CASE WHEN status = 'DISPOSED' THEN 1 ELSE 0 END) AS disposed_files
        FROM files
    `;

    const recentActionsQuery = `
        SELECT COUNT(*) AS today_actions 
        FROM file_logs 
        WHERE created_at >= datetime('now', '-1 day')
    `;

    const categoryQuery = `
        SELECT category, COUNT(*) AS count 
        FROM files 
        GROUP BY category 
        ORDER BY count DESC
    `;

    const typeQuery = `
        SELECT type, COUNT(*) AS count 
        FROM files 
        GROUP BY type
    `;

    db.get(summaryQuery, [], (err, summary) => {
        if (err) return res.status(500).json({ error: err.message });

        db.get(recentActionsQuery, [], (err, recent) => {
            if (err) return res.status(500).json({ error: err.message });

            db.all(categoryQuery, [], (err, categories) => {
                if (err) return res.status(500).json({ error: err.message });

                db.all(typeQuery, [], (err, types) => {
                    if (err) return res.status(500).json({ error: err.message });

                    const typeMap = { PHYSICAL: 0, DIGITAL: 0, HYBRID: 0 };
                    types.forEach(t => { if (t.type) typeMap[t.type] = t.count; });

                    res.json({
                        total_files: summary.total_files || 0,
                        available_files: summary.available_files || 0,
                        checked_out_files: summary.checked_out_files || 0,
                        classified_files: summary.classified_files || 0,
                        overdue_files: summary.overdue_files || 0,
                        disposal_due_files: summary.disposal_due_files || 0,
                        disposed_files: summary.disposed_files || 0,
                        today_actions: recent.today_actions || 0,
                        category_distribution: categories,
                        type_distribution: typeMap
                    });
                });
            });
        });
    });
});

// GET /api/logs - Real-time activity feed & audit history
app.get('/api/logs', requireAuth, (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 15;
    const query = `
        SELECT 
            l.id,
            l.file_id,
            l.user_name,
            l.action,
            l.notes,
            l.created_at,
            COALESCE(f.file_code, l.file_code) AS file_code,
            f.title AS file_title,
            f.category AS file_category,
            f.is_classified
        FROM file_logs l
        LEFT JOIN files f ON l.file_id = f.id
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ?
    `;

    db.all(query, [limit], (err, rows) => {
        if (err) {
            console.error("Logs Error:", err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// ==========================================
// FILE REGISTRY CRUD API
// ==========================================

// GET /api/files - List files with search & multi-filter support
app.get('/api/files', requireAuth, (req, res) => {
    const { search = '', category = '', status = '', type = '', classified = '', overdue = '', disposal = '' } = req.query;

    let conditions = [];
    let params = [];

    if (search.trim()) {
        conditions.push(`(title LIKE ? OR file_code LIKE ? OR category LIKE ? OR physical_location LIKE ?)`);
        const s = `%${search.trim()}%`;
        params.push(s, s, s, s);
    }

    if (category) {
        conditions.push(`category = ?`);
        params.push(category);
    }

    if (status) {
        conditions.push(`status = ?`);
        params.push(status);
    }

    if (type) {
        conditions.push(`type = ?`);
        params.push(type);
    }

    if (classified !== '') {
        conditions.push(`is_classified = ?`);
        params.push(parseInt(classified, 10));
    }

    if (overdue === '1') {
        // Past their due date and still out in circulation
        conditions.push(`status = 'CHECKED_OUT' AND due_date IS NOT NULL AND due_date != '' AND due_date < date('now')`);
    }

    if (disposal === '1') {
        // Retention period has ended and the record hasn't been disposed yet
        conditions.push(`retention_due IS NOT NULL AND retention_due != '' AND retention_due <= date('now') AND status != 'DISPOSED'`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `SELECT * FROM files ${whereClause} ORDER BY id DESC`;

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error("GET Error:", err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// POST /api/files - Register new file (Admin Only)
app.post('/api/files', requireAdmin, (req, res) => {
    const { file_code, title, category, type, physical_location, digital_path = '', is_classified, retention_due } = req.body;
    
    if (!file_code || !title || !category || !type) {
        return res.status(400).json({ error: 'file_code, title, category, and type are required.' });
    }

    const retentionGiven = retention_due !== undefined && retention_due !== null && String(retention_due).trim() !== '';
    if (retentionGiven && !(/^\d{4}-\d{2}-\d{2}$/.test(String(retention_due).trim()) && !isNaN(new Date(String(retention_due).trim())))) {
        return res.status(400).json({ error: 'retention_due must be a valid date in YYYY-MM-DD format.' });
    }
    const retentionVal = retentionGiven ? String(retention_due).trim() : null;

    const operator = req.user ? req.user.full_name : 'Administrator';
    const classifiedValue = is_classified ? 1 : 0;
    const query = `
        INSERT INTO files (file_code, title, category, type, physical_location, digital_path, is_classified, status, retention_due) 
        VALUES (?, ?, ?, ?, ?, ?, ?, 'AVAILABLE', ?)
    `;

    db.run(query, [file_code.trim(), title.trim(), category, type, physical_location || '', digital_path || '', classifiedValue, retentionVal], function(err) {
        if (err) {
            console.error("POST Error:", err.message);
            return res.status(400).json({ error: err.message });
        }

        const newId = this.lastID;
        // Audit log registration
        db.run(
            `INSERT INTO file_logs (file_id, user_name, action, notes, file_code) VALUES (?, ?, 'REGISTER', 'Registered new document in registry', ?)`,
            [newId, operator, file_code.trim()]
        );

        res.json({ success: true, id: newId, message: `File ${file_code} successfully registered.` });
    });
});

// POST /api/files/import - Bulk import records from a CSV upload (Admin Only)
// Expected header: file_code,title,category,type,physical_location,digital_path
// Every row is validated; duplicates (in-file or in-registry) are skipped with
// a reason, and each imported record gets its own REGISTER audit entry.
app.post('/api/files/import', requireAdmin, (req, res) => {
    const { csv: csvText } = req.body || {};
    if (!csvText || typeof csvText !== 'string' || !csvText.trim()) {
        return res.status(400).json({ error: 'No CSV content received.' });
    }

    let responded = false;
    const rows = [];
    Readable.from([csvText])
        .pipe(csv())
        .on('data', (row) => rows.push(row))
        .on('error', () => {
            responded = true;
            res.status(400).json({ error: 'Could not parse CSV. Check for stray quotes or broken lines.' });
        })
        .on('end', () => {
            if (responded) return;
            if (!rows.length) return res.status(400).json({ error: 'The CSV has no data rows.' });

            // Normalize headers (case/whitespace tolerant)
            const norm = rows.map(r => {
                const o = {};
                Object.keys(r).forEach(k => { o[String(k).trim().toLowerCase().replace(/^\uFEFF/, '')] = r[k]; });
                return o;
            });

            const required = ['file_code', 'title', 'category', 'type'];
            const headerKeys = Object.keys(norm[0]);
            const missingCols = required.filter(c => !headerKeys.includes(c));
            if (missingCols.length) {
                return res.status(400).json({
                    error: `Missing required column(s): ${missingCols.join(', ')}. Expected header: file_code,title,category,type,physical_location,digital_path`
                });
            }

            const VALID_TYPES = ['PHYSICAL', 'DIGITAL', 'HYBRID'];
            const seen = new Set();
            const skipped = [];
            const toImport = [];

            norm.forEach((row, i) => {
                const line = i + 2; // header occupies line 1
                const code = String(row.file_code || '').trim().toUpperCase();
                const title = String(row.title || '').trim();
                const category = String(row.category || '').trim();
                const type = String(row.type || '').trim().toUpperCase();
                const retention = String(row.retention_due || '').trim();

                if (!code && !title && !category) return; // fully blank row: ignore
                if (!code) return skipped.push({ line, code: '(blank)', reason: 'file_code is required' });
                if (!title) return skipped.push({ line, code, reason: 'title is required' });
                if (!category) return skipped.push({ line, code, reason: 'category is required' });
                if (!VALID_TYPES.includes(type)) return skipped.push({ line, code, reason: `type must be PHYSICAL, DIGITAL or HYBRID (got "${type || '?'}")` });
                if (retention && !(/^\d{4}-\d{2}-\d{2}$/.test(retention) && !isNaN(new Date(retention)))) return skipped.push({ line, code, reason: `retention_due must be YYYY-MM-DD (got "${retention}")` });
                if (seen.has(code)) return skipped.push({ line, code, reason: 'duplicate code inside this file' });
                seen.add(code);
                toImport.push({
                    line, code, title, category, type,
                    ret: retention,
                    loc: String(row.physical_location || '').trim(),
                    dig: String(row.digital_path || '').trim()
                });
            });

            if (!toImport.length) {
                return res.status(400).json({ error: 'No valid rows to import.', skipped, total: rows.length });
            }

            db.all(`SELECT file_code FROM files`, [], (err, existing) => {
                if (err) return res.status(500).json({ error: err.message });
                const taken = new Set((existing || []).map(r => String(r.file_code).trim().toUpperCase()));
                const queue = toImport.filter(r => {
                    if (taken.has(r.code)) { skipped.push({ line: r.line, code: r.code, reason: 'already in registry' }); return false; }
                    return true;
                });
                if (!queue.length) {
                    return res.status(400).json({ error: 'Every valid row already exists in the registry.', skipped, total: rows.length });
                }

                const operator = req.user ? req.user.full_name : 'Administrator';
                let imported = 0;
                let idx = 0;

                const finish = () => {
                    res.json({
                        success: true,
                        total: rows.length,
                        imported,
                        skipped,
                        message: `Imported ${imported} record${imported === 1 ? '' : 's'}${skipped.length ? `, skipped ${skipped.length}` : ''}.`
                    });
                };

                const next = () => {
                    if (idx >= queue.length) return finish();
                    const r = queue[idx++];
                    db.run(
                        `INSERT INTO files (file_code, title, category, type, physical_location, digital_path, status, retention_due) VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', ?)`,
                        [r.code, r.title, r.category, r.type, r.loc, r.dig, r.ret || null],
                        function (e2) {
                            if (e2) {
                                skipped.push({ line: r.line, code: r.code, reason: (e2.message || '').includes('UNIQUE') ? 'already in registry' : e2.message });
                            } else {
                                imported++;
                                db.run(
                                    `INSERT INTO file_logs (file_id, user_name, action, notes, file_code) VALUES (?, ?, 'REGISTER', 'Registered via CSV bulk import', ?)`,
                                    [this.lastID, operator, r.code]
                                );
                            }
                            next();
                        }
                    );
                };
                next();
            });
        });
});

// PUT /api/files/:id - Update existing file (Admin Only)
// Saving an edit that lowers classification (classified → public) requires Quick-PIN.
app.put('/api/files/:id', requireAdmin, (req, res) => {
    const { title, category, type, physical_location, digital_path = '', is_classified, pin_code, retention_due } = req.body;
    const classifiedValue = is_classified ? 1 : 0;
    const fileId = req.params.id;
    const operator = req.user ? req.user.full_name : 'Administrator';

    // retention_due: undefined = leave unchanged; '' = clear; a date = set
    const touchRetention = retention_due !== undefined && retention_due !== null;
    const retentionTrimmed = touchRetention ? String(retention_due).trim() : '';
    if (retentionTrimmed && !(/^\d{4}-\d{2}-\d{2}$/.test(retentionTrimmed) && !isNaN(new Date(retentionTrimmed)))) {
        return res.status(400).json({ error: 'retention_due must be a valid date in YYYY-MM-DD format.' });
    }

    const query = `
        UPDATE files 
        SET title = ?, category = ?, type = ?, physical_location = ?, digital_path = ?, is_classified = ?${touchRetention ? ', retention_due = ?' : ''}, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
    `;
    const queryParams = [title.trim(), category, type, physical_location || '', digital_path || '', classifiedValue];
    if (touchRetention) queryParams.push(retentionTrimmed || null);
    queryParams.push(fileId);

    db.get(`SELECT id, file_code, is_classified FROM files WHERE id = ?`, [fileId], (err, current) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!current) return res.status(404).json({ error: 'File not found.' });

        const applyUpdate = (confirmedByName) => {
            db.run(query, queryParams, function(err) {
                if (err) {
                    console.error("PUT Error:", err.message);
                    return res.status(500).json({ error: err.message });
                }

                let note = 'Updated document metadata';
                if (confirmedByName) note = `Declassified to public access — 🔒 Quick-PIN confirmed by ${confirmedByName}`;

                db.run(
                    `INSERT INTO file_logs (file_id, user_name, action, notes, file_code) VALUES (?, ?, 'UPDATE', ?, ?)`,
                    [fileId, operator, note, current.file_code]
                );

                res.json({ success: true, message: 'File updated successfully', pin_confirmed_by: confirmedByName || null });
            });
        };

        if (current.is_classified === 1 && classifiedValue === 0) {
            return requireDeclassifyPin(req, res, pin_code, applyUpdate);
        }
        applyUpdate(null);
    });
});

// PATCH /api/files/:id/classify - Toggle security classification (Admin Only)
// classified → public additionally requires two-step Quick-PIN verification.
app.patch('/api/files/:id/classify', requireAdmin, (req, res) => {
    const { is_classified, pin_code } = req.body;
    const val = is_classified ? 1 : 0;
    const fileId = req.params.id;
    const operator = req.user ? req.user.full_name : 'Security Administrator';

    db.get(`SELECT id, file_code, title, is_classified FROM files WHERE id = ?`, [fileId], (err, file) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!file) return res.status(404).json({ error: 'File not found.' });

        const declassifying = file.is_classified === 1 && val === 0;

        const applyToggle = (confirmedByName) => {
            db.run(`UPDATE files SET is_classified = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [val, fileId], function(err) {
                if (err) {
                    console.error("PATCH Error:", err.message);
                    return res.status(500).json({ error: err.message });
                }

                const actionText = val === 1 ? 'RESTRICT' : 'UNRESTRICT';
                let noteText = val === 1 ? 'Classified security clearance applied' : 'Declassified to public access';
                if (confirmedByName) noteText += ` — 🔒 Quick-PIN confirmed by ${confirmedByName}`;

                db.run(
                    `INSERT INTO file_logs (file_id, user_name, action, notes, file_code) VALUES (?, ?, ?, ?, ?)`,
                    [fileId, operator, actionText, noteText, file.file_code]
                );

                res.json({ success: true, is_classified: val, pin_confirmed_by: confirmedByName || null });
            });
        };

        if (declassifying) {
            return requireDeclassifyPin(req, res, pin_code, applyToggle);
        }
        applyToggle(null);
    });
});

// POST /api/files/:id/dispose - Formally dispose of a record (Admin Only)
// The record STAYS in the registry as status DISPOSED so its metadata and
// full audit history survive. Quick-PIN is ALWAYS required (this is a
// destructive records decision) and checked-out custody must return first.
app.post('/api/files/:id/dispose', requireAdmin, (req, res) => {
    const fileId = parseInt(req.params.id, 10);
    const { pin_code, notes } = req.body || {};

    db.get(`SELECT id, file_code, title, status, retention_due FROM files WHERE id = ?`, [fileId], (err, file) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!file) return res.status(404).json({ error: 'File not found.' });

        if (file.status === 'DISPOSED') {
            return res.status(409).json({ error: `"${file.file_code}" has already been disposed.`, code: 'ALREADY_DISPOSED' });
        }
        if (file.status === 'CHECKED_OUT') {
            return res.status(409).json({
                error: `"${file.file_code}" is CHECKED OUT and cannot be disposed. Check it in first.`,
                code: 'CHECKED_OUT'
            });
        }

        const performDispose = (confirmedByName) => {
            const operator = req.user ? req.user.full_name : 'Administrator';
            const dueNote = file.retention_due ? `· retention due ${file.retention_due}` : '· no retention date set';
            const extra = (notes && typeof notes === 'string' && notes.trim()) ? `· ${notes.trim().slice(0, 200)}` : '';
            const note = `Record disposed of, removed from active holdings ${dueNote} ${extra} — 🔒 Quick-PIN confirmed by ${confirmedByName}`;

            db.run(`UPDATE files SET status = 'DISPOSED', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [fileId], function(updateErr) {
                if (updateErr) return res.status(500).json({ error: updateErr.message });

                db.run(
                    `INSERT INTO file_logs (file_id, user_name, action, notes, file_code) VALUES (?, ?, 'DISPOSE', ?, ?)`,
                    [fileId, operator, note, file.file_code],
                    (logErr) => {
                        if (logErr) console.error('DISPOSE Log Error:', logErr.message);
                        res.json({
                            success: true,
                            status: 'DISPOSED',
                            message: `"${file.file_code}" disposed of. Metadata and audit history retained.`,
                            pin_confirmed_by: confirmedByName
                        });
                    }
                );
            });
        };

        return requireDeclassifyPin(req, res, pin_code, performDispose, 'Disposing of a record');
    });
});

// DELETE /api/files/:id - Delete file permanently (Admin Only)
// 🛡️ Guards: checked-out records cannot be destroyed (custody must return
// first), classified records require Quick-PIN verification, and the audit
// trail SURVIVES the record — logs are kept and a DELETE entry is written.
app.delete('/api/files/:id', requireAdmin, (req, res) => {
    const fileId = parseInt(req.params.id, 10);

    db.get(`SELECT id, file_code, title, status, is_classified, borrower_name FROM files WHERE id = ?`, [fileId], (err, file) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!file) return res.status(404).json({ error: 'File not found.' });

        if (file.status === 'CHECKED_OUT') {
            return res.status(409).json({
                error: `"${file.file_code}" is CHECKED OUT${file.borrower_name ? ` to ${file.borrower_name}` : ''} and cannot be deleted. Check it in first.`,
                code: 'CHECKED_OUT'
            });
        }

        const performDelete = (confirmedByName) => {
            const operator = req.user ? req.user.full_name : 'Administrator';
            const note = `Document "${file.file_code}" (${file.title}) permanently deleted` +
                (confirmedByName ? ` — 🔒 Quick-PIN confirmed by ${confirmedByName}` : '');

            // Log FIRST (the row references the soon-to-be-gone file_id, but
            // keeps its own copy of the code), then remove only the record.
            db.run(
                `INSERT INTO file_logs (file_id, user_name, action, notes, file_code) VALUES (?, ?, 'DELETE', ?, ?)`,
                [fileId, operator, note, file.file_code],
                (logErr) => {
                    if (logErr) console.error("DELETE Log Error:", logErr.message);

                    db.run(`DELETE FROM files WHERE id = ?`, [fileId], function(delErr) {
                        if (delErr) {
                            console.error("DELETE Error:", delErr.message);
                            return res.status(500).json({ error: delErr.message });
                        }
                        res.json({ success: true, message: `File ${file.file_code} deleted permanently (audit history preserved)` });
                    });
                }
            );
        };

        // 🔒 Destroying a classified record gets the same two-step PIN gate as declassification
        if (file.is_classified === 1) {
            return requireDeclassifyPin(req, res, req.body && req.body.pin_code, performDelete, 'Deleting this classified record');
        }
        performDelete(null);
    });
});

// ==========================================
// CIRCULATION API (CHECK-IN / CHECK-OUT)
// ==========================================

// POST /api/files/action - Perform circulation action (Supports Session OR Quick-PIN)
app.post('/api/files/action', (req, res) => {
    const { file_code, action, notes = '', pin_code, borrower = '', due_date = '' } = req.body;

    if (!file_code || !action) {
        return res.status(400).json({ error: 'file_code and action are required.' });
    }

    const executeCirculation = (operatorName, pinAuthorizedBy) => {
        const trimmedCode = file_code.trim();

        db.get(`SELECT id, file_code, title, status, is_classified FROM files WHERE file_code = ?`, [trimmedCode], (err, file) => {
            if (err || !file) {
                return res.status(404).json({ error: `File code "${trimmedCode}" not found in registry.` });
            }

            if (action === 'CHECK_OUT' && file.status === 'DISPOSED') {
                return res.status(400).json({
                    error: `File "${file.file_code}" has been disposed and is no longer part of the active holdings.`,
                    code: 'DISPOSED'
                });
            }

            if (action === 'CHECK_OUT' && file.status === 'CHECKED_OUT') {
                return res.status(400).json({ error: `File "${file.file_code}" is ALREADY checked out!` });
            }

            if (action === 'CHECK_IN' && file.status === 'AVAILABLE') {
                return res.status(400).json({ error: `File "${file.file_code}" is ALREADY in storage (Available)!` });
            }

            const performUpdate = (confirmedByName) => {
                const newStatus = action === 'CHECK_OUT' ? 'CHECKED_OUT' : 'AVAILABLE';
                const expectedStatus = action === 'CHECK_OUT' ? 'AVAILABLE' : 'CHECKED_OUT';
                let actionNote = notes || (action === 'CHECK_OUT' ? 'Checked out at circulation desk' : 'Returned and verified in storage');
                // Custody fields apply on check-out only; a return clears them
                const custodyBorrower = (action === 'CHECK_OUT' && typeof borrower === 'string' && borrower.trim()) ? borrower.trim().slice(0, 120) : null;
                const dueOk = action === 'CHECK_OUT' && typeof due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(due_date.trim()) && !isNaN(new Date(due_date.trim()));
                const custodyDue = dueOk ? due_date.trim() : null;
                if (custodyBorrower) actionNote += ` | Borrower: ${custodyBorrower}`;
                if (custodyDue) actionNote += ` | Due: ${custodyDue}`;
                const isClassifiedRelease = action === 'CHECK_OUT' && file.is_classified === 1;
                if (isClassifiedRelease && confirmedByName) {
                    actionNote += ` | 🔒 Classified release — Quick-PIN confirmed by ${confirmedByName}`;
                }

                // Conditional update: only succeeds while the status still matches the
                // pre-check — closes the race where two simultaneous actions both pass
                db.run(
                    `UPDATE files SET status = ?, borrower_name = ?, due_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?`,
                    [newStatus, custodyBorrower, custodyDue, file.id, expectedStatus],
                    function (err) {
                        if (err) return res.status(500).json({ error: err.message });

                        if (this.changes === 0) {
                            return res.status(409).json({
                                error: `File "${file.file_code}" was just ${action === 'CHECK_OUT' ? 'checked out to' : 'returned by'} someone else. Please refresh and try again.`,
                                code: 'CONFLICT'
                            });
                        }

                        db.run(
                            `INSERT INTO file_logs (file_id, user_name, action, notes, file_code) VALUES (?, ?, ?, ?, ?)`,
                            [file.id, operatorName, action, actionNote, file.file_code],
                            (err) => {
                                if (err) return res.status(500).json({ error: err.message });

                                res.json({
                                    success: true,
                                    file: {
                                        id: file.id,
                                        file_code: file.file_code,
                                        title: file.title,
                                        status: newStatus,
                                        borrower_name: custodyBorrower,
                                        due_date: custodyDue
                                    },
                                    operator: operatorName,
                                    pin_confirmed_by: isClassifiedRelease ? confirmedByName : null,
                                    message: `Successfully ${action === 'CHECK_OUT' ? 'checked out' : 'checked in'} "${file.title}" (${file.file_code}) by ${operatorName}.` +
                                        (isClassifiedRelease && confirmedByName ? ` 🔒 PIN confirmed by ${confirmedByName}.` : '')
                                });
                            }
                        );
                    }
                );
            };

            // 🔒 Two-step verification: classified check-outs require a verified Quick-PIN
            // confirmation (any active staff PIN), recorded in the audit trail.
            if (action === 'CHECK_OUT' && file.is_classified === 1) {
                // Kiosk/PIN mode: the request's PIN already authenticated this action
                if (pinAuthorizedBy) {
                    return performUpdate(pinAuthorizedBy);
                }

                // Session mode: require a fresh confirmation PIN
                if (!pin_code || typeof pin_code !== 'string') {
                    return res.status(403).json({
                        error: `Classified document "${file.file_code}" requires Quick-PIN confirmation before check-out.`,
                        code: 'PIN_REQUIRED'
                    });
                }

                const rate = pinRateCheck(req);
                if (!rate.allowed) {
                    return res.status(429).json({ error: `Too many failed PIN attempts. Try again in ${rate.retryAfter} second(s).`, code: 'PIN_LOCKED' });
                }

                return db.all('SELECT id, username, pin_code_hash, full_name, role FROM users WHERE pin_code_hash IS NOT NULL', [], (err2, users) => {
                    if (err2) return res.status(500).json({ error: err2.message });

                    const matched = (users || []).find(u => bcrypt.compareSync(pin_code.trim(), u.pin_code_hash));
                    if (!matched) {
                        pinRateFail(req);
                        return res.status(403).json({ error: 'Invalid Quick-PIN code. Access denied.', code: 'PIN_INVALID' });
                    }

                    pinRateReset(req);
                    performUpdate(`${matched.full_name} (${matched.username})`);
                });
            }

            performUpdate(null);
        });
    };

    // 1. If caller has an active session token (Admin or logged-in Staff)
    if (req.user) {
        return executeCirculation(req.user.full_name, null);
    }

    // 2. Otherwise, authenticate via Quick-PIN (Kiosk / Desk terminal)
    if (!pin_code || typeof pin_code !== 'string') {
        return res.status(401).json({ error: 'Quick-PIN or active login session required to execute circulation.' });
    }

    const rate = pinRateCheck(req);
    if (!rate.allowed) {
        return res.status(429).json({ error: `Too many failed PIN attempts. Try again in ${rate.retryAfter} second(s).`, code: 'PIN_LOCKED' });
    }

    db.all('SELECT id, username, pin_code_hash, full_name, role FROM users WHERE pin_code_hash IS NOT NULL', [], (err, users) => {
        if (err) return res.status(500).json({ error: err.message });

        const matched = users.find(u => bcrypt.compareSync(pin_code.trim(), u.pin_code_hash));
        if (!matched) {
            pinRateFail(req);
            return res.status(403).json({ error: 'Invalid Quick-PIN code. Access denied.', code: 'PIN_INVALID' });
        }

        pinRateReset(req);
        executeCirculation(matched.full_name, matched.full_name);
    });
});

// ==========================================
// PUBLIC QR DOCUMENT VIEWER (/view/:code)
// ==========================================

// Escape registry metadata before embedding it into viewer HTML
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Allow only http/https or relative link targets; blocks javascript:/data: URIs
function safeHref(value) {
    const s = String(value || '').trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
    return s;
}

// POST /api/files/:code/unlock - Release a classified record's location & digital
// copy only after valid Quick-PIN verification (server-side gate, not just CSS)
app.post('/api/files/:code/unlock', (req, res) => {
    const { pin_code } = req.body;
    if (!pin_code || typeof pin_code !== 'string') {
        return res.status(400).json({ error: 'Quick-PIN code is required.' });
    }

    const rate = pinRateCheck(req);
    if (!rate.allowed) {
        return res.status(429).json({ error: `Too many failed PIN attempts. Try again in ${rate.retryAfter} second(s).`, code: 'PIN_LOCKED' });
    }

    db.get('SELECT physical_location, digital_path FROM files WHERE file_code = ?', [req.params.code], (err, file) => {
        if (err || !file) {
            return res.status(404).json({ error: 'Document not found in registry.' });
        }

        db.all('SELECT pin_code_hash FROM users WHERE pin_code_hash IS NOT NULL', [], (err2, users) => {
            if (err2) return res.status(500).json({ error: err2.message });

            const matched = (users || []).some(u => bcrypt.compareSync(pin_code.trim(), u.pin_code_hash));
            if (!matched) {
                pinRateFail(req);
                return res.status(401).json({ error: 'Invalid Quick-PIN code. Access denied.' });
            }
            pinRateReset(req);

            const href = file.digital_path ? safeHref(file.digital_path) : null;
            res.json({
                success: true,
                physical_location: file.physical_location || null,
                digital_path: href,
                is_url: !!href && /^https?:\/\//i.test(href)
            });
        });
    });
});

// GET /view/:code - Mobile-friendly digital document viewer / QR scan target.
// Public by design: printed QR tags are opened on phones that hold no session
// token. Classified records keep location + digital copy behind Quick-PIN.
app.get('/view/:code', (req, res) => {
    const code = req.params.code;
    db.get('SELECT * FROM files WHERE file_code = ?', [code], (err, file) => {
        if (err || !file) {
            return res.status(404).send(`
                <!DOCTYPE html>
                <html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Not Found</title>
                <script src="https://cdn.tailwindcss.com"></script></head>
                <body class="bg-slate-100 p-6 flex items-center justify-center min-h-screen text-slate-800">
                    <div class="bg-white p-6 rounded-2xl shadow max-w-sm text-center space-y-3">
                        <div class="text-3xl">🔍</div>
                        <h2 class="text-lg font-bold">Document Not Found</h2>
                        <p class="text-xs text-slate-500">Document code "${escapeHtml(code)}" does not exist in the registry.</p>
                        <a href="/" class="inline-block mt-2 px-4 py-2 bg-sky-600 text-white rounded-lg text-xs font-semibold">Go to Registry</a>
                    </div>
                </body></html>
            `);
        }

        // If digital_path is an absolute URL, we can present an immediate open or direct redirect
        const hasDigital = file.digital_path && file.digital_path.trim().length > 0;
        const isUrl = hasDigital && (file.digital_path.startsWith('http://') || file.digital_path.startsWith('https://'));

        // Viewer state
        const rawPath = file.digital_path ? file.digital_path.trim() : '';
        const href = rawPath ? safeHref(rawPath) : null;
        const needsUnlock = file.is_classified === 1;

        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>${escapeHtml(file.file_code)} - ${escapeHtml(file.title)}</title>
                <script src="https://cdn.tailwindcss.com"></script>
            </head>
            <body class="bg-slate-100 p-4 font-sans text-slate-800 flex items-center justify-center min-h-screen">
                <div class="max-w-md w-full bg-white p-6 rounded-2xl shadow-xl border border-slate-200 space-y-4">
                    <div class="flex items-center justify-between">
                        <span class="font-mono font-bold text-sky-700 bg-sky-50 px-2.5 py-1 rounded text-xs border border-sky-200">${escapeHtml(file.file_code)}</span>
                        <span class="text-xs px-2.5 py-0.5 rounded-full font-bold ${file.status === 'AVAILABLE' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-amber-50 text-amber-700 border border-amber-200'}">${escapeHtml(file.status)}</span>
                    </div>
                    <div>
                        <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(file.category)}</span>
                        <h1 class="text-lg font-bold text-slate-900 mt-0.5">${escapeHtml(file.title)}</h1>
                        <div class="flex items-center gap-2 mt-1">
                            <span class="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-semibold border">${escapeHtml(file.type)}</span>
                            ${file.is_classified === 1 ? '<span class="text-xs px-2 py-0.5 rounded bg-rose-50 text-rose-700 font-bold border border-rose-200">🔒 Classified</span>' : ''}
                        </div>
                    </div>
                    
                    ${file.physical_location ? `
                        <div id="locBox" class="${needsUnlock ? 'hidden ' : ''}p-3 bg-slate-50 rounded-xl text-xs space-y-0.5 border border-slate-100">
                            <span class="text-slate-400 block font-medium">Physical Location:</span>
                            <span id="locVal" class="font-bold text-slate-700">${needsUnlock ? '' : escapeHtml(file.physical_location)}</span>
                        </div>
                    ` : ''}

                    ${needsUnlock ? `
                        <!-- Classified: location + digital copy unlock after server-side Quick-PIN verification -->
                        <div id="pinGate" class="p-3.5 rounded-xl bg-rose-50 border border-rose-200 space-y-2">
                            <div class="text-xs font-bold text-rose-700 flex items-center gap-1.5">
                                <span>🔒</span> Classified Document — Quick-PIN Required
                            </div>
                            <div class="flex gap-2">
                                <input id="gatePin" type="password" inputmode="numeric" maxlength="4" placeholder="Quick-PIN" class="flex-1 min-w-0 p-2.5 text-sm font-mono text-center tracking-widest border border-rose-300 rounded-lg bg-white focus:ring-2 focus:ring-rose-500">
                                <button id="gateBtn" type="button" class="px-4 py-2.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-lg shadow-sm transition cursor-pointer">Unlock</button>
                            </div>
                            <p id="gateErr" class="hidden text-[11px] font-semibold text-rose-600"></p>
                        </div>
                        <a id="digitalLink" target="_blank" class="hidden w-full py-3 bg-sky-600 hover:bg-sky-700 text-white text-center rounded-xl font-bold text-sm shadow-md shadow-sky-600/20 transition">
                            Open Digital Document ↗
                        </a>
                    ` : hasDigital && href ? `
                        <div class="pt-2 space-y-2">
                            <a href="${escapeHtml(href)}" target="_blank" class="block w-full py-3 bg-sky-600 hover:bg-sky-700 text-white text-center rounded-xl font-bold text-sm shadow-md shadow-sky-600/20 transition">
                                Open Digital Document ↗
                            </a>
                            <p class="text-[10px] text-slate-400 text-center font-mono truncate">${escapeHtml(rawPath)}</p>
                        </div>
                    ` : hasDigital ? `
                        <div class="p-3 bg-slate-50 rounded-xl text-xs border border-slate-100 text-center space-y-1">
                            <span class="text-slate-400 block font-medium">Digital Reference</span>
                            <span class="font-mono text-slate-600 break-all">${escapeHtml(rawPath)}</span>
                            <p class="text-[10px] text-slate-400">This reference cannot be opened as a link.</p>
                        </div>
                    ` : `
                        <div class="p-3 bg-amber-50 rounded-xl text-xs text-amber-700 border border-amber-200 text-center">
                            This is a physical-only file. Original copy is in storage.
                        </div>
                    `}

                    <div class="pt-2 text-center border-t border-slate-100">
                        <a href="/" class="text-xs text-slate-500 hover:text-sky-600 font-semibold">← Open Office File Tracker Dashboard</a>
                    </div>
                </div>

                ${needsUnlock ? `
                <script>
                (function () {
                    var gate = document.getElementById('pinGate');
                    var btn = document.getElementById('gateBtn');
                    var input = document.getElementById('gatePin');
                    var err = document.getElementById('gateErr');
                    var link = document.getElementById('digitalLink');
                    var locBox = document.getElementById('locBox');
                    var locVal = document.getElementById('locVal');
                    if (!btn) return;

                    function unlock() {
                        var pin = (input.value || '').trim();
                        if (!pin) {
                            err.textContent = 'Enter the Quick-PIN to unlock this document.';
                            err.classList.remove('hidden');
                            return;
                        }
                        btn.disabled = true;
                        btn.textContent = 'Checking...';
                        err.classList.add('hidden');

                        fetch('/api/files/${encodeURIComponent(file.file_code)}/unlock', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ pin_code: pin })
                        })
                        .then(function (r) { return r.json().catch(function () { return {}; }); })
                        .then(function (data) {
                            if (!data || !data.success) {
                                err.textContent = (data && data.error) || 'Invalid Quick-PIN. Access denied.';
                                err.classList.remove('hidden');
                                return;
                            }
                            if (data.physical_location && locBox && locVal) {
                                locVal.textContent = data.physical_location;
                                locBox.classList.remove('hidden');
                            }
                            if (data.digital_path && link) {
                                link.href = data.digital_path;
                                if (data.is_url) link.target = '_blank';
                                link.classList.remove('hidden');
                            }
                            gate.classList.add('hidden');
                        })
                        .catch(function () {
                            err.textContent = 'Could not reach the server. Please try again.';
                            err.classList.remove('hidden');
                        })
                        .finally(function () {
                            btn.disabled = false;
                            btn.textContent = 'Unlock';
                        });
                    }

                    btn.addEventListener('click', unlock);
                    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') unlock(); });
                    input.focus();
                })();
                </script>
                ` : ''}
            </body>
            </html>
        `);
    });
});

// ==========================================
// DIGITAL COPY SERVING + BRANDED NOT-FOUND PAGE
// ==========================================

const DOCS_ROOT = path.join(__dirname, 'docs');

// Branded replacement for Express' raw white "Cannot GET /..." error page
function docNotFoundPage(requestPath) {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>File Not Found - ARCHIVEX</title>
            <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="bg-slate-100 p-6 flex items-center justify-center min-h-screen font-sans text-slate-800">
            <div class="max-w-md w-full bg-white p-7 rounded-2xl shadow-xl border border-slate-200 space-y-4 text-center">
                <div class="text-4xl">📂</div>
                <h2 class="text-lg font-bold">Digital copy not found</h2>
                <p class="text-xs text-slate-500">No file is stored on this server at:</p>
                <p class="font-mono text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2 break-all">${escapeHtml(requestPath)}</p>
                <div class="text-xs text-slate-500 text-left bg-sky-50 border border-sky-100 rounded-xl p-3 space-y-1.5">
                    <p class="font-bold text-sky-800">How to make it openable:</p>
                    <p>1. Copy the real file into the <span class="font-mono font-semibold">docs</span> folder of the ARCHIVEX installation so it matches this path, or</p>
                    <p>2. Edit the record and enter a full web link (https://...) for cloud storage.</p>
                </div>
                <div class="flex gap-2 justify-center pt-1">
                    <button onclick="history.back()" class="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg text-xs font-bold transition cursor-pointer">← Go back</button>
                    <a href="/" class="px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-xs font-bold transition">Open Registry</a>
                </div>
            </div>
        </body>
        </html>
    `;
}

// Serve digital copies from the project's docs/ folder (path-traversal guarded).
// "/docs/legal/x.pdf" -> <project>/docs/legal/x.pdf
// Missing files get the branded page above instead of Express' white error.
app.get(/^\/docs\/.+$/i, (req, res) => {
    let rel;
    try {
        rel = decodeURIComponent(req.path);
    } catch (e) {
        return res.status(400).send(docNotFoundPage(req.path));
    }
    const target = path.resolve(DOCS_ROOT, rel.replace(/^\/?docs[\\/]/, ''));
    if (target !== DOCS_ROOT && !target.startsWith(DOCS_ROOT + path.sep)) {
        return res.status(403).send(docNotFoundPage(rel));
    }
    fs.stat(target, (err, st) => {
        if (err || !st.isFile()) {
            return res.status(404).send(docNotFoundPage(rel));
        }
        res.sendFile(target);
    });
});

// Any other missing file-like request (…/something.ext) also gets the branded
// page - never Express' raw white "Cannot GET" response.
app.get(/\.[a-z0-9]{2,5}$/i, (req, res) => {
    res.status(404).send(docNotFoundPage(req.path));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Office File Tracker server running on http://localhost:${PORT}`));