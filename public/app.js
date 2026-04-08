// ── STATE ──────────────────────────────────────────────────────────────────
let trades = [];
let notes = [];
let activeNote = null;
let editingTradeId = null;
let pendingDeleteId = null;
let pendingDeleteType = null;
let chatHistory = [];

// ── API KEY ─────────────────────────────────────────────────────────────────
function getApiKey() { return localStorage.getItem('claude_api_key') || ''; }
function setApiKey(key) { localStorage.setItem('claude_api_key', key); }

// ── INIT ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('dateDisplay').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  await loadTrades();
  await loadNotes();
  updateDashboard();
  renderTradesTable();
  renderNotesList();
  checkApiKey();
  setupEventListeners();

  // Set today's date as default in quick form
  document.querySelector('#quickTradeForm [name="date"]').value = new Date().toISOString().split('T')[0];
  document.querySelector('#tradeForm [name="date"]').value = new Date().toISOString().split('T')[0];
});

// ── NAVIGATION ──────────────────────────────────────────────────────────────
function showTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-${tabName}`).classList.add('active');
  document.querySelector(`.nav-btn[data-tab="${tabName}"]`).classList.add('active');
}

// ── LOAD DATA ───────────────────────────────────────────────────────────────
async function loadTrades() {
  try {
    const res = await fetch('/api/trades');
    trades = await res.json();
  } catch (e) { trades = []; }
}

async function loadNotes() {
  try {
    const res = await fetch('/api/notes');
    notes = await res.json();
  } catch (e) { notes = []; }
}

// ── P&L DISPLAY ─────────────────────────────────────────────────────────────
function getPnL(trade) {
  if (!trade.pnl) return null;
  return trade.pnl.toString().trim();
}

function formatPnL(raw) {
  if (!raw) return '<span class="pnl-open">—</span>';
  const num = parseFloat(raw.replace(/[^0-9.\-+]/g, ''));
  if (isNaN(num)) return `<span class="pnl-open">${escHtml(raw)}</span>`;
  const cls = num >= 0 ? 'pnl-pos' : 'pnl-neg';
  const sign = num >= 0 && !raw.startsWith('+') ? '+' : '';
  return `<span class="${cls}">${sign}${raw}</span>`;
}

// ── DASHBOARD ───────────────────────────────────────────────────────────────
function updateDashboard() {
  const total = trades.length;
  const openTrades = trades.filter(t => t.status === 'open' || !t.status);
  const closedTrades = trades.filter(t => t.status === 'closed');

  // Win rate based on manually entered pnl
  const closedWithPnl = closedTrades.filter(t => t.pnl);
  const winning = closedWithPnl.filter(t => parseFloat(t.pnl.replace(/[^0-9.\-+]/g, '')) > 0);
  const winRate = closedWithPnl.length ? Math.round((winning.length / closedWithPnl.length) * 100) : 0;

  // Total P&L from manually entered values
  const totalPnL = closedWithPnl.reduce((sum, t) => {
    const n = parseFloat(t.pnl.replace(/[^0-9.\-+]/g, ''));
    return sum + (isNaN(n) ? 0 : n);
  }, 0);

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-winrate').textContent = `${winRate}%`;
  const pnlEl = document.getElementById('stat-pnl');
  pnlEl.textContent = `${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`;
  pnlEl.style.color = totalPnL >= 0 ? 'var(--green)' : 'var(--red)';
  document.getElementById('stat-open').textContent = openTrades.length;

  // Recent trades (last 5)
  const recent = [...trades].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
  const el = document.getElementById('recentTradesList');
  if (!recent.length) {
    el.innerHTML = '<div class="empty-state">No trades yet. Add your first trade!</div>';
    return;
  }
  el.innerHTML = recent.map(t => `
    <div class="recent-item">
      <div>
        <span class="recent-symbol">${t.symbol.toUpperCase()}</span>
        <span class="badge badge-${t.assetType || 'stock'}" style="margin-left:8px">${(t.assetType || 'stock').toUpperCase()}</span>
        <span class="badge badge-${t.direction || 'long'}" style="margin-left:4px">${(t.direction || 'long').toUpperCase()}</span>
      </div>
      <div>${formatPnL(t.pnl)}</div>
    </div>`
  ).join('');
}

// ── TRADES TABLE ─────────────────────────────────────────────────────────────
function renderTradesTable() {
  const search = (document.getElementById('tradeSearch')?.value || '').toLowerCase();
  const statusFilter = document.getElementById('tradeStatusFilter')?.value || 'all';
  const dirFilter = document.getElementById('tradeDirFilter')?.value || 'all';

  let filtered = trades.filter(t => {
    const matchSearch = !search || t.symbol.toLowerCase().includes(search);
    const matchStatus = statusFilter === 'all' || t.status === statusFilter || (!t.status && statusFilter === 'open');
    const matchDir = dirFilter === 'all' || (t.direction || 'long') === dirFilter;
    return matchSearch && matchStatus && matchDir;
  });

  const tbody = document.getElementById('tradesBody');
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No trades found</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(t => {
    const date = t.date || t.createdAt?.split('T')[0] || '';
    const reason = t.reason ? escHtml(t.reason.slice(0, 60)) + (t.reason.length > 60 ? '…' : '') : '—';
    return `<tr>
      <td><strong>${t.symbol.toUpperCase()}</strong></td>
      <td><span class="badge badge-${t.assetType || 'stock'}">${(t.assetType || 'stock').toUpperCase()}</span></td>
      <td><span class="badge badge-${t.direction || 'long'}">${(t.direction || 'long').toUpperCase()}</span></td>
      <td>${t.entryPrice || '—'}</td>
      <td>${t.exitPrice || '—'}</td>
      <td>${formatPnL(t.pnl)}</td>
      <td style="max-width:200px;color:var(--text2);font-size:12px">${reason}</td>
      <td>${date}</td>
      <td><span class="badge badge-${t.status || 'open'}">${(t.status || 'open').toUpperCase()}</span></td>
      <td>
        <div class="action-btns">
          <button class="btn-edit" onclick="editTrade('${t.id}')">Edit</button>
          <button class="btn-del" onclick="confirmDelete('${t.id}', 'trade')">Del</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── TRADE MODAL ──────────────────────────────────────────────────────────────
function openTradeModal(id = null) {
  editingTradeId = id;
  const modal = document.getElementById('tradeModal');
  const form = document.getElementById('tradeForm');
  document.getElementById('modalTitle').textContent = id ? 'Edit Trade' : 'New Trade';

  form.reset();
  document.querySelector('#tradeForm [name="date"]').value = new Date().toISOString().split('T')[0];

  if (id) {
    const t = trades.find(t => t.id === id);
    if (!t) return;
    Object.keys(t).forEach(k => {
      const el = form.querySelector(`[name="${k}"]`);
      if (el) el.value = t[k];
    });
  }
  modal.classList.remove('hidden');
}

function editTrade(id) { openTradeModal(id); }

async function saveTrade(e) {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form).entries());

  // Clean up empty fields
  if (!data.exitPrice) delete data.exitPrice;
  if (!data.pnl) delete data.pnl;
  if (!data.reason) delete data.reason;
  if (!data.notes) delete data.notes;

  try {
    if (editingTradeId) {
      const res = await fetch(`/api/trades/${editingTradeId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const updated = await res.json();
      const idx = trades.findIndex(t => t.id === editingTradeId);
      trades[idx] = updated;
    } else {
      const res = await fetch('/api/trades', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const newTrade = await res.json();
      trades.push(newTrade);
    }
    document.getElementById('tradeModal').classList.add('hidden');
    updateDashboard();
    renderTradesTable();
  } catch (err) { alert('Error saving trade: ' + err.message); }
}

// Quick add trade
async function quickAddTrade(e) {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form).entries());
  if (!data.exitPrice) delete data.exitPrice;
  if (!data.pnl) delete data.pnl;
  if (!data.reason) delete data.reason;

  try {
    const res = await fetch('/api/trades', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const newTrade = await res.json();
    trades.push(newTrade);
    form.reset();
    form.querySelector('[name="date"]').value = new Date().toISOString().split('T')[0];
    updateDashboard();
    renderTradesTable();
  } catch (err) { alert('Error: ' + err.message); }
}

// ── DELETE CONFIRM ────────────────────────────────────────────────────────────
function confirmDelete(id, type) {
  pendingDeleteId = id;
  pendingDeleteType = type;
  document.getElementById('confirmMsg').textContent = `Delete this ${type}?`;
  document.getElementById('confirmModal').classList.remove('hidden');
}

async function executeDelete() {
  if (!pendingDeleteId) return;
  try {
    await fetch(`/api/${pendingDeleteType === 'trade' ? 'trades' : 'notes'}/${pendingDeleteId}`, { method: 'DELETE' });
    if (pendingDeleteType === 'trade') {
      trades = trades.filter(t => t.id !== pendingDeleteId);
      updateDashboard();
      renderTradesTable();
    } else {
      notes = notes.filter(n => n.id !== pendingDeleteId);
      if (activeNote?.id === pendingDeleteId) {
        activeNote = null;
        showEditorPlaceholder();
      }
      renderNotesList();
    }
  } catch (err) { alert('Error deleting: ' + err.message); }
  document.getElementById('confirmModal').classList.add('hidden');
  pendingDeleteId = null;
}

// ── NOTEBOOK ─────────────────────────────────────────────────────────────────
function renderNotesList() {
  const el = document.getElementById('notesList');
  if (!notes.length) {
    el.innerHTML = '<div class="empty-state">No notes yet</div>';
    return;
  }
  const sorted = [...notes].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  el.innerHTML = sorted.map(n => `
    <div class="note-item ${activeNote?.id === n.id ? 'active' : ''}" onclick="openNote('${n.id}')">
      <div class="note-title">${escHtml(n.title || 'Untitled')}</div>
      <div class="note-preview">${escHtml((n.body || '').slice(0, 60))}</div>
      <div class="note-date">${formatDate(n.updatedAt)}</div>
      ${n.tags ? `<div class="note-tags">${n.tags.split(',').filter(Boolean).map(t => `<span class="tag-chip">${escHtml(t.trim())}</span>`).join('')}</div>` : ''}
    </div>
  `).join('');
}

function openNote(id) {
  activeNote = notes.find(n => n.id === id);
  renderNotesList();
  showEditor(activeNote);
}

function showEditorPlaceholder() {
  document.getElementById('noteEditor').innerHTML = '<div class="editor-placeholder">Select a note or create a new one</div>';
}

let saveNoteTimeout = null;

function showEditor(note) {
  const el = document.getElementById('noteEditor');
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <input class="editor-title" id="noteTitle" value="${escHtml(note.title || '')}" placeholder="Note title..." />
      <button class="btn-del" onclick="confirmDelete('${note.id}', 'note')">Delete</button>
    </div>
    <div class="editor-toolbar">
      <span style="color:var(--text2);font-size:12px">Tags:</span>
      <input class="editor-tags-input" id="noteTags" value="${escHtml(note.tags || '')}" placeholder="trade-journal, review, strategy..." />
    </div>
    <textarea class="editor-body" id="noteBody" placeholder="Write your notes here...">${escHtml(note.body || '')}</textarea>
  `;

  document.getElementById('noteTitle').addEventListener('input', scheduleNoteSave);
  document.getElementById('noteTags').addEventListener('input', scheduleNoteSave);
  document.getElementById('noteBody').addEventListener('input', scheduleNoteSave);
}

function scheduleNoteSave() {
  clearTimeout(saveNoteTimeout);
  saveNoteTimeout = setTimeout(saveActiveNote, 800);
}

async function saveActiveNote() {
  if (!activeNote) return;
  const title = document.getElementById('noteTitle')?.value || '';
  const body = document.getElementById('noteBody')?.value || '';
  const tags = document.getElementById('noteTags')?.value || '';

  try {
    const res = await fetch(`/api/notes/${activeNote.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, tags })
    });
    const updated = await res.json();
    const idx = notes.findIndex(n => n.id === activeNote.id);
    notes[idx] = updated;
    activeNote = updated;
    renderNotesList();
  } catch (err) { console.error('Save error:', err); }
}

async function createNewNote() {
  try {
    const res = await fetch('/api/notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Note', body: '', tags: '' })
    });
    const note = await res.json();
    notes.push(note);
    activeNote = note;
    renderNotesList();
    showEditor(note);
    setTimeout(() => document.getElementById('noteTitle')?.focus(), 50);
  } catch (err) { alert('Error creating note: ' + err.message); }
}

// ── AI CHAT ──────────────────────────────────────────────────────────────────
function checkApiKey() {
  const notice = document.getElementById('apiKeyNotice');
  if (getApiKey()) {
    notice.classList.add('hidden');
  } else {
    notice.classList.remove('hidden');
  }
}

function showSettings() {
  document.getElementById('apiKeyInput').value = getApiKey();
  document.getElementById('settingsModal').classList.remove('hidden');
}

function sendSuggestion(text) {
  document.getElementById('chatInput').value = text;
  sendMessage();
}

async function sendMessage() {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;

  const apiKey = getApiKey();
  if (!apiKey) { showSettings(); return; }

  input.value = '';
  input.style.height = 'auto';

  // Hide welcome screen, show messages
  const welcomeEl = document.querySelector('.chat-welcome');
  if (welcomeEl) welcomeEl.style.display = 'none';

  const messagesEl = document.getElementById('chatMessages');

  // Add user message
  messagesEl.innerHTML += `
    <div class="message user">
      <div class="msg-avatar">👤</div>
      <div class="msg-bubble">${escHtml(msg)}</div>
    </div>
  `;

  // Add streaming AI message
  const aiId = 'ai-msg-' + Date.now();
  messagesEl.innerHTML += `
    <div class="message" id="${aiId}">
      <div class="msg-avatar">🤖</div>
      <div class="msg-bubble msg-streaming" id="${aiId}-bubble"></div>
    </div>
  `;

  messagesEl.scrollTop = messagesEl.scrollHeight;

  const sendBtn = document.getElementById('sendBtn');
  sendBtn.disabled = true;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, apiKey })
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const bubbleEl = document.getElementById(`${aiId}-bubble`);
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') break;

        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            bubbleEl.classList.remove('msg-streaming');
            bubbleEl.textContent = '❌ Error: ' + parsed.error;
            break;
          }
          if (parsed.text) {
            fullText += parsed.text;
            bubbleEl.innerHTML = formatMarkdown(fullText);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        } catch (_) {}
      }
    }

    bubbleEl.classList.remove('msg-streaming');
    bubbleEl.innerHTML = formatMarkdown(fullText);

  } catch (err) {
    const bubbleEl = document.getElementById(`${aiId}-bubble`);
    if (bubbleEl) {
      bubbleEl.classList.remove('msg-streaming');
      bubbleEl.textContent = '❌ Network error: ' + err.message;
    }
  }

  sendBtn.disabled = false;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function formatMarkdown(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

// ── SETTINGS ─────────────────────────────────────────────────────────────────
function setupEventListeners() {
  // Nav tabs
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });

  // Trade modal
  document.getElementById('openTradeModal').addEventListener('click', () => openTradeModal());
  document.getElementById('tradeForm').addEventListener('submit', saveTrade);
  document.querySelectorAll('.close-modal').forEach(b => {
    b.addEventListener('click', () => document.getElementById('tradeModal').classList.add('hidden'));
  });

  // Quick trade form
  document.getElementById('quickTradeForm').addEventListener('submit', quickAddTrade);

  // Filters
  document.getElementById('tradeSearch').addEventListener('input', renderTradesTable);
  document.getElementById('tradeStatusFilter').addEventListener('change', renderTradesTable);
  document.getElementById('tradeDirFilter').addEventListener('change', renderTradesTable);

  // Notebook
  document.getElementById('newNoteBtn').addEventListener('click', createNewNote);

  // Chat
  document.getElementById('sendBtn').addEventListener('click', sendMessage);
  document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  document.getElementById('chatInput').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  // Settings
  document.getElementById('settingsBtn').addEventListener('click', showSettings);
  document.querySelectorAll('.close-settings').forEach(b => {
    b.addEventListener('click', () => document.getElementById('settingsModal').classList.add('hidden'));
  });
  document.getElementById('saveSettings').addEventListener('click', () => {
    const key = document.getElementById('apiKeyInput').value.trim();
    setApiKey(key);
    document.getElementById('settingsModal').classList.add('hidden');
    checkApiKey();
  });
  document.getElementById('toggleApiKey').addEventListener('click', () => {
    const input = document.getElementById('apiKeyInput');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // Delete confirm
  document.getElementById('confirmOk').addEventListener('click', executeDelete);
  document.getElementById('confirmCancel').addEventListener('click', () => {
    document.getElementById('confirmModal').classList.add('hidden');
    pendingDeleteId = null;
  });

  // Close modals on backdrop click
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  });
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
