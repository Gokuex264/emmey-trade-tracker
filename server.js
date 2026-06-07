const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const { Pool } = require('pg');

// ── POSTGRESQL SETUP ──────────────────────────────────────────────────────────
let pool = null;
let appDataCache = null;
let usingPg = false;
let lastDbError = null;
const DB_KEYS = ['users','trades','notebooks','notes','brokers','savedArticles','portfolios'];

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });
  pool.on('error', err => console.error('❌ PostgreSQL pool error:', err.message));
}

async function connectDb() {
  if (!pool) return false;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await pool.query('SELECT 1');
      console.log('✅ PostgreSQL connected');

      await pool.query(`
        CREATE TABLE IF NOT EXISTS appdata (
          id INTEGER PRIMARY KEY DEFAULT 1,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      const result = await pool.query('SELECT data FROM appdata WHERE id = 1');
      if (result.rows.length > 0) {
        appDataCache = result.rows[0].data;
        let changed = false;
        DB_KEYS.forEach(k => { if (!appDataCache[k]) { appDataCache[k] = []; changed = true; } });
        if (changed) await pool.query('UPDATE appdata SET data = $1, updated_at = NOW() WHERE id = 1', [JSON.stringify(appDataCache)]);
        console.log(`📦 Loaded: ${appDataCache.users.length} users, ${appDataCache.trades.length} trades, ${(appDataCache.portfolios||[]).length} portfolios`);
      } else {
        appDataCache = Object.fromEntries(DB_KEYS.map(k => [k, []]));
        await pool.query('INSERT INTO appdata (id, data) VALUES (1, $1)', [JSON.stringify(appDataCache)]);
        console.log('📦 Fresh database initialized');
      }
      return true;
    } catch (err) {
      lastDbError = err.message;
      console.error(`❌ PostgreSQL attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
    }
  }
  console.error('❌ All PostgreSQL connection attempts failed — falling back to local file');
  return false;
}

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});

// CSV multer (memory storage, no disk write)
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_FILE = path.join(__dirname, 'data.json');

function initData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users: [], trades: [], notebooks: [], notes: [], brokers: [], savedArticles: [] }, null, 2));
  } else {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    let changed = false;
    if (!d.users)          { d.users = []; changed = true; }
    if (!d.notebooks)      { d.notebooks = []; changed = true; }
    if (!d.brokers)        { d.brokers = []; changed = true; }
    if (!d.savedArticles)  { d.savedArticles = []; changed = true; }
    if (!d.portfolios)     { d.portfolios = []; changed = true; }
    if (changed) fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
  }
}

// ── RSS NEWS ENGINE ───────────────────────────────────────────────────────────

const newsCache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
    .replace(/\s+/g,' ').trim().slice(0, 220);
}

function parseRSS(xml, sourceName) {
  const items = [];
  const itemRx = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRx.exec(xml)) !== null) {
    const chunk = m[1];
    const title  = stripHtml(extractTag(chunk, 'title'));
    const link   = extractTag(chunk, 'link') || extractTag(chunk, 'guid');
    const pubDate= extractTag(chunk, 'pubDate') || extractTag(chunk, 'dc:date') || '';
    const desc   = stripHtml(extractTag(chunk, 'description'));
    if (title && link) items.push({ title, link, pubDate, description: desc, source: sourceName, id: Buffer.from(link).toString('base64').slice(0,16) });
  }
  return items;
}

async function fetchRSS(url, sourceName) {
  const cached = newsCache.get(url);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradeTracker/1.0)' },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = parseRSS(xml, sourceName);
    newsCache.set(url, { data: items, time: Date.now() });
    return items;
  } catch { return []; }
}

// ── CSV PARSING & BROKER NORMALIZATION ────────────────────────────────────────

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur.trim());
  return result.map(v => v.replace(/^"|"$/g, '').trim());
}

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const headers = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] || ''; });
    return row;
  }).filter(row => Object.values(row).some(v => v));
  return { headers, rows };
}

function detectBroker(headers) {
  const lc = headers.map(h => h.toLowerCase());
  if (lc.some(h => h.includes('activity date')) && lc.some(h => h.includes('trans code'))) return 'robinhood';
  if (lc.includes('side') && lc.some(h => h.includes('average price') || h.includes('avg price') || h.includes('filled qty'))) return 'webull';
  if (lc.some(h => h === 'transaction type' || h === 'trans type') && lc.some(h => h === 'shares' || h === 'quantity')) return 'td';
  if (lc.some(h => h.includes('buy/sell')) || (lc.some(h => h.includes('trade date')) && lc.includes('proceeds'))) return 'ibkr';
  return 'generic';
}

function cleanNum(s) { return parseFloat((s || '').replace(/[$,()]/g, '')) || 0; }
function fmtPrice(n) { return n > 0 ? n.toFixed(2) : ''; }
function fmtPnl(n, raw) {
  if (!n) return '';
  // if original string had parens it's negative (TD format)
  const neg = typeof raw === 'string' && raw.includes('(');
  const val = neg ? -Math.abs(n) : n;
  return (val >= 0 ? '+' : '') + val.toFixed(2);
}

function normalizeRobinhood(rows) {
  return rows.filter(r => {
    const tc = (r['Trans Code'] || '').toLowerCase();
    return tc === 'buy' || tc === 'sell';
  }).map(r => {
    const isBuy = r['Trans Code'].toLowerCase() === 'buy';
    const price = cleanNum(r['Price']);
    const amount = cleanNum(r['Amount']);
    const sym = (r['Instrument'] || r['Description'] || '').split(' ')[0].toUpperCase();
    return {
      symbol: sym, direction: 'long',
      entryPrice: isBuy ? fmtPrice(price) : '',
      exitPrice: !isBuy ? fmtPrice(price) : '',
      quantity: r['Quantity'] || '',
      date: r['Activity Date'] || r['Process Date'] || '',
      status: isBuy ? 'open' : 'closed',
      assetType: 'stock',
      pnl: !isBuy ? fmtPnl(amount, r['Amount']) : '',
      notes: `Robinhood ${r['Trans Code']} | ${r['Description'] || ''}`
    };
  }).filter(t => t.symbol);
}

function normalizeWebull(rows) {
  return rows.map(r => {
    const side = (r['Side'] || r['Action'] || r['Type'] || '').toLowerCase();
    const isBuy = side.includes('buy');
    const price = cleanNum(r['Average Price'] || r['Avg Price'] || r['Price']);
    const qty = cleanNum(r['Filled Qty'] || r['Quantity'] || r['Qty']);
    const date = (r['Filled Time'] || r['Place Time'] || r['Date'] || '').split(' ')[0];
    return {
      symbol: (r['Symbol'] || r['Ticker'] || '').toUpperCase(),
      direction: 'long',
      entryPrice: isBuy ? fmtPrice(price) : '',
      exitPrice: !isBuy ? fmtPrice(price) : '',
      quantity: qty ? qty.toString() : '',
      date, status: isBuy ? 'open' : 'closed', assetType: 'stock', pnl: '',
      notes: `Webull ${r['Side'] || ''} | ${r['Status'] || ''}`
    };
  }).filter(t => t.symbol);
}

function normalizeTD(rows) {
  return rows.filter(r => {
    const t = (r['TRANSACTION TYPE'] || r['Transaction Type'] || '').toLowerCase();
    return t.includes('buy') || t.includes('sell') || t.includes('trade');
  }).map(r => {
    const t = (r['TRANSACTION TYPE'] || r['Transaction Type'] || '').toLowerCase();
    const isBuy = t.includes('buy');
    const price = cleanNum(r['PRICE'] || r['Price']);
    const shares = cleanNum(r['SHARES'] || r['Shares'] || r['Quantity']);
    const amount = cleanNum(r['AMOUNT'] || r['Amount']);
    return {
      symbol: (r['SYMBOL'] || r['Symbol'] || '').toUpperCase(),
      direction: 'long',
      entryPrice: isBuy ? fmtPrice(price) : '',
      exitPrice: !isBuy ? fmtPrice(price) : '',
      quantity: shares ? shares.toString() : '',
      date: r['DATE'] || r['Date'] || '',
      status: isBuy ? 'open' : 'closed', assetType: 'stock',
      pnl: !isBuy ? fmtPnl(amount, r['AMOUNT'] || r['Amount']) : '',
      notes: `TD Ameritrade | ${r['DESCRIPTION'] || r['Description'] || ''}`
    };
  }).filter(t => t.symbol);
}

function normalizeIBKR(rows) {
  return rows.filter(r => {
    const bs = (r['Buy/Sell'] || r['Action'] || '').toLowerCase();
    return bs === 'buy' || bs === 'sell';
  }).map(r => {
    const isBuy = (r['Buy/Sell'] || '').toLowerCase() === 'buy';
    const price = cleanNum(r['T. Price'] || r['Price']);
    const qty = Math.abs(cleanNum(r['Quantity'] || r['Qty']));
    const proceeds = cleanNum(r['Proceeds']);
    const realized = cleanNum(r['Realized P/L'] || r['Realized P&L']);
    return {
      symbol: (r['Symbol'] || '').toUpperCase(),
      direction: 'long',
      entryPrice: isBuy ? fmtPrice(price) : '',
      exitPrice: !isBuy ? fmtPrice(price) : '',
      quantity: qty ? qty.toString() : '',
      date: (r['Date/Time'] || r['Trade Date'] || '').split(' ')[0].split(',')[0],
      status: isBuy ? 'open' : 'closed', assetType: 'stock',
      pnl: realized ? fmtPnl(realized, '') : (!isBuy && proceeds ? fmtPnl(proceeds, '') : ''),
      notes: `IBKR ${r['Buy/Sell'] || ''} | ${r['Description'] || ''}`
    };
  }).filter(t => t.symbol);
}

function normalizeGeneric(headers, rows) {
  const lc = headers.map(h => h.toLowerCase());
  const col = (patterns) => headers.find((_, i) => patterns.some(p => lc[i].includes(p)));
  const symCol  = col(['symbol', 'ticker', 'instrument', 'security']);
  const priceCol= col(['price', 'avg price', 'average price', 'fill price', 'exec price']);
  const qtyCol  = col(['qty', 'quantity', 'shares', 'size', 'filled qty']);
  const dateCol = col(['date', 'time', 'filled', 'activity', 'trade date']);
  const sideCol = col(['side', 'action', 'type', 'trans code', 'transaction', 'buy/sell']);
  const pnlCol  = col(['pnl', 'p&l', 'profit', 'realized', 'gain', 'amount']);

  return rows.map(r => {
    const side = (sideCol ? r[sideCol] : '').toLowerCase();
    const isBuy = side.includes('buy') || side.includes('long') || side.includes('b');
    const price = cleanNum(priceCol ? r[priceCol] : '');
    const qty   = cleanNum(qtyCol   ? r[qtyCol]   : '');
    const pnl   = cleanNum(pnlCol   ? r[pnlCol]   : '');
    return {
      symbol: ((symCol ? r[symCol] : '') || '').toUpperCase(),
      direction: 'long',
      entryPrice: isBuy ? fmtPrice(price) : '',
      exitPrice: !isBuy ? fmtPrice(price) : '',
      quantity: qty ? qty.toString() : '',
      date: (dateCol ? r[dateCol] : '').split(' ')[0],
      status: isBuy ? 'open' : 'closed', assetType: 'stock',
      pnl: pnl ? fmtPnl(pnl, pnlCol ? r[pnlCol] : '') : '',
      notes: 'Imported from CSV'
    };
  }).filter(t => t.symbol && t.symbol.toLowerCase() !== 'symbol');
}

function normalizeAlpacaOrders(orders) {
  return orders
    .filter(o => o.status === 'filled' && parseFloat(o.filled_qty || 0) > 0)
    .map(o => {
      const isBuy = o.side === 'buy';
      const price = parseFloat(o.filled_avg_price || 0);
      const qty   = parseFloat(o.filled_qty || 0);
      const date  = (o.filled_at || o.created_at || '').split('T')[0];
      const assetType = o.asset_class === 'crypto' ? 'crypto' : o.asset_class === 'us_option' ? 'options' : 'stock';
      return {
        symbol: o.symbol, direction: isBuy ? 'long' : 'long',
        entryPrice: isBuy ? fmtPrice(price) : '',
        exitPrice: !isBuy ? fmtPrice(price) : '',
        quantity: qty.toString(), date,
        status: isBuy ? 'open' : 'closed', assetType, pnl: '',
        notes: `Alpaca ${o.side.toUpperCase()} | ${o.type} | ID:${(o.id || '').slice(0, 8)}`
      };
    });
}

function normalizeAlpacaPositions(positions) {
  return positions.map(p => {
    const qty = parseFloat(p.qty || 0);
    return {
      symbol: p.symbol,
      direction: qty >= 0 ? 'long' : 'short',
      entryPrice: fmtPrice(parseFloat(p.avg_entry_price || 0)),
      exitPrice: '',
      quantity: Math.abs(qty).toString(), date: '',
      status: 'open', assetType: 'stock',
      pnl: fmtPnl(parseFloat(p.unrealized_pl || 0), ''),
      notes: `Alpaca Open Position | Unrealized P&L: $${parseFloat(p.unrealized_pl || 0).toFixed(2)}`
    };
  });
}

function readData() {
  if (usingPg) return JSON.parse(JSON.stringify(appDataCache));
  initData();
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeData(data) {
  if (usingPg) {
    appDataCache = data;
    pool.query('UPDATE appdata SET data = $1, updated_at = NOW() WHERE id = 1', [JSON.stringify(data)])
      .catch(err => {
        console.error('❌ DB write failed, retrying…', err.message);
        setTimeout(() => {
          pool.query('UPDATE appdata SET data = $1, updated_at = NOW() WHERE id = 1', [JSON.stringify(data)])
            .catch(e => console.error('❌ DB write retry also failed:', e.message));
        }, 1000);
      });
    return;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.use(express.json());

app.use(session({
  secret: process.env.emmey_trade_tracker || 'tradetracker-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    database: usingPg ? '✅ PostgreSQL (Supabase) connected — data is safe' : '⚠️ Using local file — data will reset on restart',
    dbConfigured: !!process.env.DATABASE_URL,
    usingPostgres: usingPg,
    lastError: lastDbError || null,
    recordCounts: usingPg ? {
      users: appDataCache?.users?.length || 0,
      trades: appDataCache?.trades?.length || 0,
      portfolios: appDataCache?.portfolios?.length || 0
    } : null
  });
});

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.adminAuthed) return res.status(403).json({ error: 'Admin authentication required' });
  next();
}

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────

app.post('/api/register', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!email) return res.status(400).json({ error: 'Email is required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const normalizedEmail = email.trim().toLowerCase();
  const data = readData();
  if (data.users.find(u => u.username.toLowerCase() === username.toLowerCase()))
    return res.status(400).json({ error: 'Username already taken' });
  if (data.users.find(u => u.email === normalizedEmail))
    return res.status(400).json({ error: 'An account with that email already exists' });

  const hash = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), username, email: normalizedEmail, passwordHash: hash, createdAt: new Date().toISOString() };
  data.users.push(user);
  writeData(data);

  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ id: user.id, username: user.username });
});

app.post('/api/forgot-password', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const data = readData();
  const user = data.users.find(u => u.email === email.trim().toLowerCase());
  if (!user) return res.status(404).json({ error: 'No account found with that email address' });

  res.json({ username: user.username });
});

app.post('/api/reset-password', async (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword) return res.status(400).json({ error: 'Email and new password are required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const data = readData();
  const user = data.users.find(u => u.email === email.trim().toLowerCase());
  if (!user) return res.status(404).json({ error: 'No account found with that email address' });

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  writeData(data);
  res.json({ success: true });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const data = readData();
  const user = data.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Invalid username or password' });

  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ id: user.id, username: user.username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, id: req.session.userId, username: req.session.username });
});

// ─── TRADES API ───────────────────────────────────────────────────────────────

app.get('/api/trades', requireAuth, (req, res) => {
  const data = readData();
  res.json(data.trades.filter(t => t.userId === req.session.userId));
});

app.post('/api/trades', requireAuth, (req, res) => {
  const data = readData();
  const trade = { id: uuidv4(), userId: req.session.userId, createdAt: new Date().toISOString(), ...req.body };
  data.trades.push(trade);
  writeData(data);
  res.json(trade);
});

app.put('/api/trades/:id', requireAuth, (req, res) => {
  const data = readData();
  const idx = data.trades.findIndex(t => t.id === req.params.id && t.userId === req.session.userId);
  if (idx === -1) return res.status(404).json({ error: 'Trade not found' });
  data.trades[idx] = { ...data.trades[idx], ...req.body, id: req.params.id, userId: req.session.userId };
  writeData(data);
  res.json(data.trades[idx]);
});

app.delete('/api/trades/:id', requireAuth, (req, res) => {
  const data = readData();
  data.trades = data.trades.filter(t => !(t.id === req.params.id && t.userId === req.session.userId));
  writeData(data);
  res.json({ success: true });
});

// ─── IMAGE UPLOAD ─────────────────────────────────────────────────────────────

app.post('/api/upload', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// ─── NOTEBOOKS API ────────────────────────────────────────────────────────────

app.get('/api/notebooks', requireAuth, (req, res) => {
  const data = readData();
  res.json(data.notebooks.filter(nb => nb.userId === req.session.userId));
});

app.post('/api/notebooks', requireAuth, (req, res) => {
  const { title } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title required' });
  const data = readData();
  const notebook = { id: uuidv4(), userId: req.session.userId, title: title.trim(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  data.notebooks.push(notebook);
  writeData(data);
  res.json(notebook);
});

app.put('/api/notebooks/:id', requireAuth, (req, res) => {
  const data = readData();
  const idx = data.notebooks.findIndex(nb => nb.id === req.params.id && nb.userId === req.session.userId);
  if (idx === -1) return res.status(404).json({ error: 'Notebook not found' });
  data.notebooks[idx] = { ...data.notebooks[idx], ...req.body, id: req.params.id, userId: req.session.userId, updatedAt: new Date().toISOString() };
  writeData(data);
  res.json(data.notebooks[idx]);
});

app.delete('/api/notebooks/:id', requireAuth, (req, res) => {
  const data = readData();
  data.notebooks = data.notebooks.filter(nb => !(nb.id === req.params.id && nb.userId === req.session.userId));
  data.notes = data.notes.filter(n => !(n.notebookId === req.params.id && n.userId === req.session.userId));
  writeData(data);
  res.json({ success: true });
});

// ─── NOTES (PAGES) API ────────────────────────────────────────────────────────

app.get('/api/notebooks/:notebookId/notes', requireAuth, (req, res) => {
  const data = readData();
  res.json(data.notes.filter(n => n.userId === req.session.userId && n.notebookId === req.params.notebookId));
});

app.post('/api/notebooks/:notebookId/notes', requireAuth, (req, res) => {
  const data = readData();
  const nb = data.notebooks.find(nb => nb.id === req.params.notebookId && nb.userId === req.session.userId);
  if (!nb) return res.status(404).json({ error: 'Notebook not found' });
  const note = { id: uuidv4(), userId: req.session.userId, notebookId: req.params.notebookId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...req.body };
  data.notes.push(note);
  writeData(data);
  res.json(note);
});

app.put('/api/notes/:id', requireAuth, (req, res) => {
  const data = readData();
  const idx = data.notes.findIndex(n => n.id === req.params.id && n.userId === req.session.userId);
  if (idx === -1) return res.status(404).json({ error: 'Note not found' });
  data.notes[idx] = { ...data.notes[idx], ...req.body, id: req.params.id, userId: req.session.userId, updatedAt: new Date().toISOString() };
  writeData(data);
  res.json(data.notes[idx]);
});

app.delete('/api/notes/:id', requireAuth, (req, res) => {
  const data = readData();
  data.notes = data.notes.filter(n => !(n.id === req.params.id && n.userId === req.session.userId));
  writeData(data);
  res.json({ success: true });
});

// ─── NEWS API ─────────────────────────────────────────────────────────────────

const MARKET_FEEDS = [
  { url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?region=US&lang=en-US', name: 'Yahoo Finance' },
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',                 name: 'CNBC' },
  { url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html',                  name: 'CNBC Economy' },
  { url: 'https://feeds.marketwatch.com/marketwatch/marketpulse/',                name: 'MarketWatch' },
];

// General market news
app.get('/api/news/market', requireAuth, async (req, res) => {
  try {
    const results = await Promise.all(MARKET_FEEDS.map(f => fetchRSS(f.url, f.name)));
    const all = results.flat().sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    // deduplicate by id
    const seen = new Set();
    const deduped = all.filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true; });
    res.json(deduped.slice(0, 60));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ticker-specific news
app.get('/api/news/ticker/:symbol', requireAuth, async (req, res) => {
  const sym = req.params.symbol.toUpperCase().trim();
  if (!sym) return res.status(400).json({ error: 'Symbol required' });
  try {
    const items = await fetchRSS(
      `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(sym)}&region=US&lang=en-US`,
      'Yahoo Finance'
    );
    res.json(items.slice(0, 30));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// News for multiple tickers at once (My Tickers)
app.post('/api/news/tickers', requireAuth, async (req, res) => {
  const { symbols } = req.body;
  if (!Array.isArray(symbols) || !symbols.length) return res.json([]);
  try {
    const results = await Promise.all(
      symbols.slice(0, 8).map(s =>
        fetchRSS(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(s.toUpperCase())}&region=US&lang=en-US`, 'Yahoo Finance')
          .then(items => items.map(i => ({ ...i, symbol: s.toUpperCase() })))
      )
    );
    const all = results.flat().sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    const seen = new Set();
    res.json(all.filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true; }).slice(0, 60));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Saved articles CRUD
app.get('/api/news/saved', requireAuth, (req, res) => {
  const data = readData();
  res.json((data.savedArticles || []).filter(a => a.userId === req.session.userId));
});

app.post('/api/news/saved', requireAuth, (req, res) => {
  const { title, link, description, source, pubDate, symbol } = req.body;
  if (!title || !link) return res.status(400).json({ error: 'title and link required' });
  const data = readData();
  if (!data.savedArticles) data.savedArticles = [];
  // prevent duplicates
  if (data.savedArticles.find(a => a.link === link && a.userId === req.session.userId))
    return res.status(409).json({ error: 'Already saved' });
  const article = { id: uuidv4(), userId: req.session.userId, title, link, description: description || '', source: source || '', pubDate: pubDate || '', symbol: symbol || '', savedAt: new Date().toISOString() };
  data.savedArticles.push(article);
  writeData(data);
  res.json(article);
});

app.delete('/api/news/saved/:id', requireAuth, (req, res) => {
  const data = readData();
  data.savedArticles = (data.savedArticles || []).filter(a => !(a.id === req.params.id && a.userId === req.session.userId));
  writeData(data);
  res.json({ success: true });
});

// ─── OPTIONS CHAIN PROXY ─────────────────────────────────────────────────────

app.get('/api/options-chain', requireAuth, async (req, res) => {
  const { ticker, date } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  const symbol = ticker.trim().toUpperCase();
  const url = date
    ? `https://query1.finance.yahoo.com/v7/finance/options/${symbol}?date=${date}`
    : `https://query1.finance.yahoo.com/v7/finance/options/${symbol}`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradeTracker/1.0)' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return res.status(r.status).json({ error: `Yahoo Finance returned ${r.status}` });
    const data = await r.json();
    const result = data?.optionChain?.result?.[0];
    if (!result) return res.status(404).json({ error: 'No options data found for that ticker' });
    res.json({
      symbol:          result.underlyingSymbol,
      price:           result.quote?.regularMarketPrice,
      expirationDates: result.expirationDates || [],
      calls:           result.options?.[0]?.calls || [],
      puts:            result.options?.[0]?.puts  || [],
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch options data: ' + err.message });
  }
});

// ─── BROKERS API ──────────────────────────────────────────────────────────────

app.get('/api/brokers', requireAuth, (req, res) => {
  const data = readData();
  const brokers = (data.brokers || []).filter(b => b.userId === req.session.userId);
  res.json(brokers.map(b => ({ ...b, apiSecret: b.apiSecret ? '••••••••' : undefined })));
});

app.post('/api/brokers', requireAuth, (req, res) => {
  const { broker, label, apiKey, apiSecret, isPaper } = req.body;
  if (!broker) return res.status(400).json({ error: 'Broker required' });
  const data = readData();
  if (!data.brokers) data.brokers = [];
  const conn = { id: uuidv4(), userId: req.session.userId, broker, label: label || broker, apiKey: apiKey || '', apiSecret: apiSecret || '', isPaper: Boolean(isPaper), createdAt: new Date().toISOString() };
  data.brokers.push(conn);
  writeData(data);
  res.json({ ...conn, apiSecret: conn.apiSecret ? '••••••••' : undefined });
});

app.delete('/api/brokers/:id', requireAuth, (req, res) => {
  const data = readData();
  data.brokers = (data.brokers || []).filter(b => !(b.id === req.params.id && b.userId === req.session.userId));
  writeData(data);
  res.json({ success: true });
});

// Parse uploaded CSV → return normalized trades for preview
app.post('/api/brokers/parse-csv', requireAuth, csvUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const text = req.file.buffer.toString('utf-8');
  const { headers, rows } = parseCSV(text);
  if (!headers.length) return res.status(400).json({ error: 'Could not parse CSV — check the file format' });

  const broker = req.body.broker || detectBroker(headers);
  let trades = [];
  if (broker === 'robinhood') trades = normalizeRobinhood(rows);
  else if (broker === 'webull')    trades = normalizeWebull(rows);
  else if (broker === 'td')        trades = normalizeTD(rows);
  else if (broker === 'ibkr')      trades = normalizeIBKR(rows);
  else                             trades = normalizeGeneric(headers, rows);

  res.json({ broker, trades, totalRows: rows.length, parsedTrades: trades.length });
});

// Fetch trades from Alpaca using a saved connection
app.post('/api/brokers/alpaca/fetch', requireAuth, async (req, res) => {
  const { connectionId } = req.body;
  const data = readData();
  const conn = (data.brokers || []).find(b => b.id === connectionId && b.userId === req.session.userId);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  const base = conn.isPaper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
  const headers = { 'APCA-API-KEY-ID': conn.apiKey, 'APCA-API-SECRET-KEY': conn.apiSecret, 'Content-Type': 'application/json' };

  try {
    const [ordersRes, positionsRes] = await Promise.all([
      fetch(`${base}/v2/orders?status=all&limit=500&direction=desc`, { headers }),
      fetch(`${base}/v2/positions`, { headers })
    ]);

    if (!ordersRes.ok) {
      const err = await ordersRes.json().catch(() => ({}));
      return res.status(400).json({ error: err.message || 'Alpaca API error — check your keys' });
    }

    const orders    = await ordersRes.json();
    const positions = await positionsRes.json().catch(() => []);

    res.json({
      broker: 'alpaca',
      trades:    normalizeAlpacaOrders(Array.isArray(orders) ? orders : []),
      positions: normalizeAlpacaPositions(Array.isArray(positions) ? positions : []),
      totalOrders: Array.isArray(orders) ? orders.length : 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TRADING API ──────────────────────────────────────────────────────────────

// Shared Alpaca request helper — all broker calls go through the server
async function alpacaReq(conn, method, endpoint, body = null) {
  const base = conn.isPaper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
  const opts = {
    method,
    headers: {
      'APCA-API-KEY-ID':     conn.apiKey,
      'APCA-API-SECRET-KEY': conn.apiSecret,
      'Content-Type':        'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${base}${endpoint}`, opts);
  // 204 No Content (cancel order success) has no body
  if (res.status === 204) return { ok: true, status: 204, data: null };
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

function resolveConn(req, res) {
  const data = readData();
  const conn = (data.brokers || []).find(b =>
    b.id === req.body.connectionId && b.userId === req.session.userId
  );
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return null; }
  return conn;
}

// Account info
app.post('/api/trading/account', requireAuth, async (req, res) => {
  const conn = resolveConn(req, res); if (!conn) return;
  try {
    const r = await alpacaReq(conn, 'GET', '/v2/account');
    if (!r.ok) return res.status(400).json({ error: r.data?.message || 'Alpaca error' });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Market clock (open/closed status)
app.post('/api/trading/clock', requireAuth, async (req, res) => {
  const conn = resolveConn(req, res); if (!conn) return;
  try {
    const r = await alpacaReq(conn, 'GET', '/v2/clock');
    if (!r.ok) return res.status(400).json({ error: r.data?.message || 'Alpaca error' });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Open positions
app.post('/api/trading/positions', requireAuth, async (req, res) => {
  const conn = resolveConn(req, res); if (!conn) return;
  try {
    const r = await alpacaReq(conn, 'GET', '/v2/positions');
    if (!r.ok) return res.status(400).json({ error: r.data?.message || 'Alpaca error' });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Order history
app.post('/api/trading/orders', requireAuth, async (req, res) => {
  const conn = resolveConn(req, res); if (!conn) return;
  const status = req.body.status || 'all';
  const limit  = Math.min(parseInt(req.body.limit) || 100, 500);
  try {
    const r = await alpacaReq(conn, 'GET', `/v2/orders?status=${status}&limit=${limit}&direction=desc`);
    if (!r.ok) return res.status(400).json({ error: r.data?.message || 'Alpaca error' });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Place order — all validation happens server-side before forwarding to Alpaca
app.post('/api/trading/place-order', requireAuth, async (req, res) => {
  const { connectionId, ...order } = req.body;
  if (!order.symbol || !order.qty || !order.side || !order.type || !order.time_in_force) {
    return res.status(400).json({ error: 'Missing required fields: symbol, qty, side, type, time_in_force' });
  }
  if (!['buy', 'sell'].includes(order.side)) return res.status(400).json({ error: 'Invalid side' });
  if (!['market','limit','stop','stop_limit','trailing_stop'].includes(order.type)) return res.status(400).json({ error: 'Invalid order type' });

  const data = readData();
  const conn = (data.brokers || []).find(b => b.id === connectionId && b.userId === req.session.userId);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  try {
    const r = await alpacaReq(conn, 'POST', '/v2/orders', order);
    if (!r.ok) return res.status(400).json({ error: r.data?.message || 'Order rejected by Alpaca' });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cancel a pending order
app.post('/api/trading/cancel-order', requireAuth, async (req, res) => {
  const { connectionId, orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  const data = readData();
  const conn = (data.brokers || []).find(b => b.id === connectionId && b.userId === req.session.userId);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  try {
    const r = await alpacaReq(conn, 'DELETE', `/v2/orders/${orderId}`);
    if (r.ok) return res.json({ success: true });
    return res.status(400).json({ error: r.data?.message || 'Could not cancel order' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Validate asset is tradeable
app.post('/api/trading/asset', requireAuth, async (req, res) => {
  const { symbol } = req.body;
  const conn = resolveConn(req, res); if (!conn) return;
  try {
    const r = await alpacaReq(conn, 'GET', `/v2/assets/${(symbol || '').toUpperCase()}`);
    if (!r.ok) return res.status(404).json({ error: 'Symbol not found or not tradeable on Alpaca' });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PORTFOLIOS ────────────────────────────────────────────────────────────────

app.get('/api/portfolios', requireAuth, (req, res) => {
  const data = readData();
  res.json((data.portfolios || []).filter(p => p.userId === req.session.userId));
});

app.post('/api/portfolios', requireAuth, (req, res) => {
  const { name, description, color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const data = readData();
  if (!data.portfolios) data.portfolios = [];
  const p = {
    id: uuidv4(), userId: req.session.userId,
    name: name.trim(), description: description || '',
    color: color || '#1a56db', createdAt: new Date().toISOString()
  };
  data.portfolios.push(p);
  writeData(data);
  res.json(p);
});

app.put('/api/portfolios/:id', requireAuth, (req, res) => {
  const data = readData();
  const idx = (data.portfolios || []).findIndex(p => p.id === req.params.id && p.userId === req.session.userId);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  data.portfolios[idx] = { ...data.portfolios[idx], ...req.body, id: req.params.id, userId: req.session.userId };
  writeData(data);
  res.json(data.portfolios[idx]);
});

app.delete('/api/portfolios/:id', requireAuth, (req, res) => {
  const data = readData();
  data.portfolios = (data.portfolios || []).filter(p => !(p.id === req.params.id && p.userId === req.session.userId));
  writeData(data);
  res.json({ ok: true });
});

// ─── AI CHAT API ──────────────────────────────────────────────────────────────

app.post('/api/chat', requireAuth, async (req, res) => {
  const { message } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'AI chat is not configured on this server.' });

  const data = readData();
  const trades = data.trades.filter(t => t.userId === req.session.userId);
  let tradeContext = trades.length
    ? '\n\nCurrent trades in portfolio:\n' + trades.map(t =>
        `- ${t.symbol} | ${(t.assetType||'stock').toUpperCase()} | ${(t.direction||'long').toUpperCase()} | Bought At: ${t.entryPrice||'?'} | Sold At: ${t.exitPrice||'Open'} | P&L: ${t.pnl||'N/A'} | Status: ${t.status||'open'} | Date: ${t.date||t.createdAt?.split('T')[0]} | Reason: ${t.reason||'not noted'} | Notes: ${t.notes||'none'}`
      ).join('\n')
    : '\n\nNo trades recorded yet.';

  const systemPrompt = `You are an expert trading analyst, market strategist, and financial news interpreter. You serve as the user's personal AI analyst inside their trade tracker app.

You can help with:
1. TRADE ANALYSIS — analyze the user's actual trades, calculate P&L, win rate, patterns, and give personalized coaching
2. MARKET NEWS & EVENTS — explain market-moving news, earnings reports, Fed decisions, CPI/jobs data, geopolitical events and their market impact
3. ECONOMIC CONCEPTS — explain macroeconomics: inflation, interest rates, yield curves, GDP, monetary policy, sector rotation, etc.
4. STOCK/ASSET RESEARCH — discuss fundamentals, technicals, sector trends, and trading setups for any symbol
5. STRATEGY & EDUCATION — explain trading strategies, risk management, options, futures, crypto concepts

User's trade data:${tradeContext}

Guidelines:
- When analyzing trades, reference specific symbols and dates from the data above
- For news/economic questions, give clear context on WHY it matters to markets and HOW it typically affects prices
- Always clarify if information may be outdated (your training data has a cutoff)
- Be direct, specific, and actionable — avoid generic advice
- Use plain language; avoid unnecessary jargon unless the user seems advanced
- Format responses with headers and bullets when covering multiple points`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: message }],
        stream: true
      })
    });

    if (!anthropicRes.ok) {
      const errData = await anthropicRes.json().catch(() => ({}));
      const errMsg = errData.error?.message || `Anthropic API error ${anthropicRes.status}`;
      res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const decoder = new TextDecoder();
    for await (const chunk of anthropicRes.body) {
      const text = decoder.decode(chunk);
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const parsed = JSON.parse(raw);
          if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
            res.write(`data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`);
          }
        } catch (_) {}
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('Chat error:', err.message);
    res.write(`data: ${JSON.stringify({ error: 'Failed to reach AI service: ' + err.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────

app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if (!adminPassword) return res.status(503).json({ error: 'Admin not configured on this server' });
  if (!password) return res.status(400).json({ error: 'Password required' });

  const match = await bcrypt.compare(password, adminPassword).catch(() => false);
  const plain = !match && password === adminPassword;
  if (!match && !plain) return res.status(401).json({ error: 'Incorrect admin password' });

  req.session.adminAuthed = true;
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.adminAuthed = false;
  res.json({ ok: true });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ authed: req.session.adminAuthed === true });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const data = readData();
  const users = data.users || [];
  const trades = data.trades || [];
  const notebooks = data.notebooks || [];
  const notes = data.notes || [];
  const portfolios = data.portfolios || [];
  const brokers = data.brokers || [];
  const stats = users.map(u => ({
    userId: u.id,
    username: u.username,
    trades: trades.filter(t => t.userId === u.id).length,
    notebooks: notebooks.filter(n => n.userId === u.id).length,
    notes: notes.filter(n => n.userId === u.id).length,
    portfolios: portfolios.filter(p => p.userId === u.id).length,
    brokers: brokers.filter(b => b.userId === u.id).length,
  }));
  res.json({
    totalUsers: users.length,
    totalTrades: trades.length,
    totalNotebooks: notebooks.length,
    totalNotes: notes.length,
    totalPortfolios: portfolios.length,
    totalBrokers: brokers.length,
    perUser: stats
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const data = readData();
  const trades = data.trades || [];
  const notebooks = data.notebooks || [];
  const portfolios = data.portfolios || [];
  const brokers = data.brokers || [];
  const users = (data.users || []).map(u => ({
    id: u.id,
    username: u.username,
    email: u.email,
    createdAt: u.createdAt,
    isAdmin: u.isAdmin || false,
    tradeCount: trades.filter(t => t.userId === u.id).length,
    notebookCount: notebooks.filter(n => n.userId === u.id).length,
    portfolioCount: portfolios.filter(p => p.userId === u.id).length,
    brokerCount: brokers.filter(b => b.userId === u.id).length,
  }));
  res.json(users);
});

app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const { username, email, newPassword, isAdmin } = req.body;
  const data = readData();
  const idx = (data.users || []).findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });

  if (username !== undefined) {
    const taken = data.users.find(u => u.username.toLowerCase() === username.toLowerCase() && u.id !== req.params.id);
    if (taken) return res.status(400).json({ error: 'Username already taken' });
    data.users[idx].username = username;
  }
  if (email !== undefined) {
    const taken = data.users.find(u => u.email === email.trim().toLowerCase() && u.id !== req.params.id);
    if (taken) return res.status(400).json({ error: 'Email already in use' });
    data.users[idx].email = email.trim().toLowerCase();
  }
  if (newPassword !== undefined) {
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    data.users[idx].passwordHash = await bcrypt.hash(newPassword, 10);
  }
  if (isAdmin !== undefined) {
    data.users[idx].isAdmin = Boolean(isAdmin);
  }

  writeData(data);
  const u = data.users[idx];
  res.json({ id: u.id, username: u.username, email: u.email, isAdmin: u.isAdmin || false });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const data = readData();
  const user = (data.users || []).find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const adminUser = (process.env.ADMIN_USERNAME || '').toLowerCase();
  if (user.username.toLowerCase() === adminUser)
    return res.status(400).json({ error: 'Cannot delete the admin account' });

  const uid = req.params.id;
  data.users        = data.users.filter(u => u.id !== uid);
  data.trades       = (data.trades || []).filter(t => t.userId !== uid);
  data.notebooks    = (data.notebooks || []).filter(n => n.userId !== uid);
  data.notes        = (data.notes || []).filter(n => n.userId !== uid);
  data.portfolios   = (data.portfolios || []).filter(p => p.userId !== uid);
  data.brokers      = (data.brokers || []).filter(b => b.userId !== uid);
  data.savedArticles= (data.savedArticles || []).filter(a => a.userId !== uid);
  writeData(data);
  res.json({ success: true });
});

// Serve admin page (only navigable if you know it exists — real auth is API-side)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Start server immediately so Render health checks pass
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Trade Tracker running at http://localhost:${PORT}\n`);
});

// Connect to database in background after server is up
connectDb().then(ok => {
  usingPg = ok;
  if (!ok) console.log('⚠️  No DATABASE_URL set or DB failed — using local data.json');
  else console.log('🎉 PostgreSQL ready — all data will persist');
});
