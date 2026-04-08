const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 3000;

// Data file paths
const DATA_FILE = path.join(__dirname, 'data.json');

// Initialize data file if it doesn't exist
function initData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ trades: [], notes: [], chatHistory: [] }, null, 2));
  }
}

function readData() {
  initData();
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── TRADES API ───────────────────────────────────────────────────────────────

// Get all trades
app.get('/api/trades', (req, res) => {
  const data = readData();
  res.json(data.trades);
});

// Add a trade
app.post('/api/trades', (req, res) => {
  const data = readData();
  const trade = {
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    ...req.body
  };
  data.trades.push(trade);
  writeData(data);
  res.json(trade);
});

// Update a trade
app.put('/api/trades/:id', (req, res) => {
  const data = readData();
  const idx = data.trades.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Trade not found' });
  data.trades[idx] = { ...data.trades[idx], ...req.body, id: req.params.id };
  writeData(data);
  res.json(data.trades[idx]);
});

// Delete a trade
app.delete('/api/trades/:id', (req, res) => {
  const data = readData();
  data.trades = data.trades.filter(t => t.id !== req.params.id);
  writeData(data);
  res.json({ success: true });
});

// ─── NOTES API ────────────────────────────────────────────────────────────────

// Get all notes
app.get('/api/notes', (req, res) => {
  const data = readData();
  res.json(data.notes);
});

// Add a note
app.post('/api/notes', (req, res) => {
  const data = readData();
  const note = {
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...req.body
  };
  data.notes.push(note);
  writeData(data);
  res.json(note);
});

// Update a note
app.put('/api/notes/:id', (req, res) => {
  const data = readData();
  const idx = data.notes.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Note not found' });
  data.notes[idx] = { ...data.notes[idx], ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
  writeData(data);
  res.json(data.notes[idx]);
});

// Delete a note
app.delete('/api/notes/:id', (req, res) => {
  const data = readData();
  data.notes = data.notes.filter(n => n.id !== req.params.id);
  writeData(data);
  res.json({ success: true });
});

// ─── AI CHAT API ──────────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { message, apiKey } = req.body;

  if (!apiKey) {
    return res.status(400).json({ error: 'API key is required' });
  }

  const data = readData();

  // Build trade context
  const trades = data.trades;
  let tradeContext = '';
  if (trades.length > 0) {
    const tradeList = trades.map(t => {
      return `- ${t.symbol} | ${(t.assetType || 'stock').toUpperCase()} | ${(t.direction || 'long').toUpperCase()} | Bought At: ${t.entryPrice || '?'} | Sold At: ${t.exitPrice || 'Open'} | P&L: ${t.pnl || 'N/A'} | Status: ${t.status || 'open'} | Date: ${t.date || t.createdAt?.split('T')[0]} | Why I took it: ${t.reason || 'not noted'} | Notes: ${t.notes || 'none'}`;
    }).join('\n');
    tradeContext = `\n\nCurrent trades in portfolio:\n${tradeList}`;
  } else {
    tradeContext = '\n\nNo trades recorded yet.';
  }

  const systemPrompt = `You are an expert trading analyst and coach. You help traders analyze their trades, identify patterns, improve their strategy, and answer questions about trading concepts.

You have access to the user's actual trade data:${tradeContext}

When answering questions:
- Reference specific trades by symbol when relevant
- Calculate P&L, win rate, and other metrics when asked
- Give actionable advice based on their actual trade history
- Explain trading concepts clearly
- Be direct and concise`;

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
    const msg = err.message || 'Claude API error';
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ Trade Tracker running at http://localhost:${PORT}\n`);
});
