const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');

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
const PORT = 3000;

const DATA_FILE = path.join(__dirname, 'data.json');

function initData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users: [], trades: [], notebooks: [], notes: [], brokers: [] }, null, 2));
  } else {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    let changed = false;
    if (!d.users)     { d.users = []; changed = true; }
    if (!d.notebooks) { d.notebooks = []; changed = true; }
    if (!d.brokers)   { d.brokers = []; changed = true; }
    if (changed) fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
  }
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
  initData();
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.use(express.json());
app.use(session({
  secret: 'tradetracker-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const data = readData();
  const exists = data.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (exists) return res.status(400).json({ error: 'Username already taken' });

  const hash = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), username, passwordHash: hash, createdAt: new Date().toISOString() };
  data.users.push(user);
  writeData(data);

  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ id: user.id, username: user.username });
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

// ─── AI CHAT API ──────────────────────────────────────────────────────────────

app.post('/api/chat', requireAuth, async (req, res) => {
  const { message, apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API key is required' });

  const data = readData();
  const trades = data.trades.filter(t => t.userId === req.session.userId);
  let tradeContext = trades.length
    ? '\n\nCurrent trades in portfolio:\n' + trades.map(t =>
        `- ${t.symbol} | ${(t.assetType||'stock').toUpperCase()} | ${(t.direction||'long').toUpperCase()} | Bought At: ${t.entryPrice||'?'} | Sold At: ${t.exitPrice||'Open'} | P&L: ${t.pnl||'N/A'} | Status: ${t.status||'open'} | Date: ${t.date||t.createdAt?.split('T')[0]} | Reason: ${t.reason||'not noted'} | Notes: ${t.notes||'none'}`
      ).join('\n')
    : '\n\nNo trades recorded yet.';

  const systemPrompt = `You are an expert trading analyst and coach. You help traders analyze their trades, identify patterns, improve their strategy, and answer questions about trading concepts.\n\nYou have access to the user's actual trade data:${tradeContext}\n\nWhen answering questions:\n- Reference specific trades by symbol when relevant\n- Calculate P&L, win rate, and other metrics when asked\n- Give actionable advice based on their actual trade history\n- Explain trading concepts clearly\n- Be direct and concise`;

  try {
    const client = new Anthropic({ apiKey });
    const stream = await client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }]
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message || 'Claude API error' })}\n\n`);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ Trade Tracker running at http://localhost:${PORT}\n`);
});
