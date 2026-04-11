// ── STATE ──────────────────────────────────────────────────────────────────
let trades = [];
let notebooks = [];
let notes = [];          // pages inside the active notebook
let activeNotebook = null;
let activeNote = null;
let editingTradeId = null;
let pendingDeleteId = null;
let pendingDeleteType = null;
let chatHistory = [];
let currentUser = null;
let brokers = [];
let importParsedTrades = [];   // trades from CSV/API waiting for user selection
let importSelectedBroker = '';

// ── API KEY ─────────────────────────────────────────────────────────────────
function getApiKey() { return localStorage.getItem('claude_api_key') || ''; }
function setApiKey(key) { localStorage.setItem('claude_api_key', key); }

// ── INIT ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupAuthListeners();
  const me = await checkSession();
  if (me.loggedIn) {
    showApp(me);
  } else {
    showAuthScreen();
  }
});

async function checkSession() {
  try {
    const res = await fetch('/api/me');
    return await res.json();
  } catch { return { loggedIn: false }; }
}

function showAuthScreen() {
  document.getElementById('authScreen').classList.remove('hidden');
  document.getElementById('appWrapper').classList.add('hidden');
}

async function showApp(user) {
  currentUser = user;
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('appWrapper').classList.remove('hidden');
  document.getElementById('sidebarUsername').textContent = user.username;
  document.getElementById('dateDisplay').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  await loadTrades();
  await loadNotebooks();
  await loadBrokers();
  updateDashboard();
  renderTradesTable();
  renderNotebooksGrid();
  renderBrokersPage();
  renderMyTradeSymbols();
  checkApiKey();
  setupEventListeners();

  document.querySelector('#quickTradeForm [name="date"]').value = new Date().toISOString().split('T')[0];
  document.querySelector('#tradeForm [name="date"]').value = new Date().toISOString().split('T')[0];
}

// ── AUTH ─────────────────────────────────────────────────────────────────────
function setupAuthListeners() {
  // Tab switching
  document.getElementById('loginTabBtn').addEventListener('click', () => {
    document.getElementById('loginTabBtn').classList.add('active');
    document.getElementById('registerTabBtn').classList.remove('active');
    document.getElementById('loginForm').classList.remove('hidden');
    document.getElementById('registerForm').classList.add('hidden');
    document.getElementById('loginError').classList.add('hidden');
  });
  document.getElementById('registerTabBtn').addEventListener('click', () => {
    document.getElementById('registerTabBtn').classList.add('active');
    document.getElementById('loginTabBtn').classList.remove('active');
    document.getElementById('registerForm').classList.remove('hidden');
    document.getElementById('loginForm').classList.add('hidden');
    document.getElementById('registerError').classList.add('hidden');
  });

  // Login
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errEl = document.getElementById('loginError');
    errEl.classList.add('hidden');

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.error; errEl.classList.remove('hidden'); return; }
      showApp(data);
    } catch { errEl.textContent = 'Network error. Try again.'; errEl.classList.remove('hidden'); }
  });

  // Register
  document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('regUsername').value.trim();
    const password = document.getElementById('regPassword').value;
    const confirm = document.getElementById('regConfirm').value;
    const errEl = document.getElementById('registerError');
    errEl.classList.add('hidden');

    if (password !== confirm) { errEl.textContent = 'Passwords do not match.'; errEl.classList.remove('hidden'); return; }

    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.error; errEl.classList.remove('hidden'); return; }
      showApp(data);
    } catch { errEl.textContent = 'Network error. Try again.'; errEl.classList.remove('hidden'); }
  });
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  trades = []; notebooks = []; notes = []; activeNotebook = null; activeNote = null; currentUser = null; chatHistory = [];
  // Reset notebook views
  document.getElementById('notebookOpenView')?.classList.add('hidden');
  document.getElementById('notebooksListView')?.classList.remove('hidden');
  // Reset chat UI
  document.getElementById('chatMessages').innerHTML = `
    <div class="chat-welcome">
      <div class="welcome-icon">🤖</div>
      <h3>Claude AI Trading Analyst</h3>
      <p>Ask me anything about your trades, strategies, or market concepts.</p>
      <div class="suggestion-chips">
        <button class="chip" onclick="sendSuggestion('What is my overall win rate?')">Win Rate</button>
        <button class="chip" onclick="sendSuggestion('Which of my trades had the best return?')">Best Trade</button>
        <button class="chip" onclick="sendSuggestion('Analyze my trading patterns and give me advice')">Analyze Patterns</button>
        <button class="chip" onclick="sendSuggestion('What are my open positions?')">Open Positions</button>
      </div>
    </div>`;
  showAuthScreen();
}

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
    if (res.status === 401) { showAuthScreen(); return; }
    trades = await res.json();
  } catch (e) { trades = []; }
}

async function loadNotebooks() {
  try {
    const res = await fetch('/api/notebooks');
    if (res.status === 401) { showAuthScreen(); return; }
    notebooks = await res.json();
  } catch (e) { notebooks = []; }
}

async function loadNotesForNotebook(notebookId) {
  try {
    const res = await fetch(`/api/notebooks/${notebookId}/notes`);
    if (res.status === 401) { showAuthScreen(); return; }
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

  const closedWithPnl = closedTrades.filter(t => t.pnl);
  const winning = closedWithPnl.filter(t => parseFloat(t.pnl.replace(/[^0-9.\-+]/g, '')) > 0);
  const winRate = closedWithPnl.length ? Math.round((winning.length / closedWithPnl.length) * 100) : 0;

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
    tbody.innerHTML = '<tr><td colspan="10" class="empty-state">No trades found</td></tr>';
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
    renderMyTradeSymbols();
  } catch (err) { alert('Error saving trade: ' + err.message); }
}

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
    renderMyTradeSymbols();
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
    if (pendingDeleteType === 'trade') {
      await fetch(`/api/trades/${pendingDeleteId}`, { method: 'DELETE' });
      trades = trades.filter(t => t.id !== pendingDeleteId);
      updateDashboard();
      renderTradesTable();
    } else if (pendingDeleteType === 'notebook') {
      await fetch(`/api/notebooks/${pendingDeleteId}`, { method: 'DELETE' });
      notebooks = notebooks.filter(nb => nb.id !== pendingDeleteId);
      if (activeNotebook?.id === pendingDeleteId) {
        activeNotebook = null;
        notes = [];
        activeNote = null;
      }
      backToNotebooks();
      renderNotebooksGrid();
    } else {
      await fetch(`/api/notes/${pendingDeleteId}`, { method: 'DELETE' });
      notes = notes.filter(n => n.id !== pendingDeleteId);
      if (activeNote?.id === pendingDeleteId) {
        activeNote = null;
        showEditorEmpty();
      }
      renderPagesList();
    }
  } catch (err) { alert('Error deleting: ' + err.message); }
  document.getElementById('confirmModal').classList.add('hidden');
  pendingDeleteId = null;
}

// ── NOTEBOOK ─────────────────────────────────────────────────────────────────

function renderNotebooksGrid() {
  const el = document.getElementById('notebooksGrid');
  if (!notebooks.length) {
    el.innerHTML = `
      <div class="notebooks-empty-state">
        <div style="font-size:52px;margin-bottom:16px">📓</div>
        <h3>No notebooks yet</h3>
        <p>Create a notebook to start organizing your trading notes and ideas</p>
        <button class="btn-primary" style="margin-top:16px" onclick="createNewNotebook()">+ New Notebook</button>
      </div>`;
    return;
  }
  const sorted = [...notebooks].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  el.innerHTML = sorted.map(nb => `
    <div class="notebook-card" onclick="openNotebook('${nb.id}')">
      <div class="nb-card-icon">📓</div>
      <div class="nb-card-title">${escHtml(nb.title)}</div>
      <div class="nb-card-date">${formatDate(nb.updatedAt)}</div>
      <button class="nb-card-del" title="Delete notebook" onclick="event.stopPropagation();confirmDelete('${nb.id}','notebook')">✕</button>
    </div>
  `).join('');
}

async function openNotebook(id) {
  await saveActiveNote(true); // flush any pending save
  activeNotebook = notebooks.find(nb => nb.id === id);
  activeNote = null;
  await loadNotesForNotebook(id);

  document.getElementById('notebooksListView').classList.add('hidden');
  document.getElementById('notebookOpenView').classList.remove('hidden');
  document.getElementById('openNotebookTitle').textContent = activeNotebook.title;

  renderPagesList();

  // Auto-open first page
  if (notes.length > 0) {
    const sorted = [...notes].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    openPage(sorted[0].id);
  } else {
    showEditorEmpty();
  }
}

function backToNotebooks() {
  saveActiveNote(true);
  activeNotebook = null;
  activeNote = null;
  notes = [];
  document.getElementById('notebookOpenView').classList.add('hidden');
  document.getElementById('notebooksListView').classList.remove('hidden');
}

function renderPagesList() {
  const el = document.getElementById('pagesList');
  if (!notes.length) {
    el.innerHTML = '<div class="pages-empty">No pages yet.<br>Click &ldquo;+ New Page&rdquo; to add one.</div>';
    return;
  }
  const sorted = [...notes].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  el.innerHTML = sorted.map(n => `
    <div class="page-item ${activeNote?.id === n.id ? 'active' : ''}" onclick="openPage('${n.id}')">
      <div class="page-item-title">${escHtml(n.title || 'Untitled')}</div>
      <div class="page-item-date">${formatDate(n.updatedAt)}</div>
    </div>
  `).join('');
}

function openPage(id) {
  saveActiveNote(true);
  activeNote = notes.find(n => n.id === id);
  renderPagesList();
  loadPageIntoEditor(activeNote);
}

function showEditorEmpty() {
  document.getElementById('editorEmptyState').style.display = 'flex';
  document.getElementById('editorPanel').classList.add('hidden');
  document.getElementById('editorPanel').style.display = 'none';
}

function loadPageIntoEditor(note) {
  document.getElementById('editorEmptyState').style.display = 'none';
  const panel = document.getElementById('editorPanel');
  panel.classList.remove('hidden');
  panel.style.display = 'flex';

  document.getElementById('pageTitle').value = note.title || '';
  document.getElementById('pageTags').value = note.tags || '';
  const body = document.getElementById('pageBody');
  body.innerHTML = note.body || '';

  // Scroll editor to top
  body.scrollTop = 0;

  setAutosaveStatus('');
}

let saveNoteTimeout = null;
let isSaving = false;

function scheduleNoteSave() {
  setAutosaveStatus('Unsaved');
  clearTimeout(saveNoteTimeout);
  saveNoteTimeout = setTimeout(() => saveActiveNote(false), 800);
}

function setAutosaveStatus(msg) {
  const el = document.getElementById('autosaveIndicator');
  if (el) el.textContent = msg;
}

async function saveActiveNote(immediate = false) {
  if (!activeNote || isSaving) return;
  clearTimeout(saveNoteTimeout);

  const titleEl = document.getElementById('pageTitle');
  const tagsEl = document.getElementById('pageTags');
  const bodyEl = document.getElementById('pageBody');
  if (!titleEl || !bodyEl) return;

  const title = titleEl.value || 'Untitled';
  const tags = tagsEl?.value || '';
  const body = bodyEl.innerHTML || '';

  isSaving = true;
  try {
    const res = await fetch(`/api/notes/${activeNote.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, tags })
    });
    const updated = await res.json();
    const idx = notes.findIndex(n => n.id === activeNote.id);
    if (idx !== -1) notes[idx] = updated;
    activeNote = updated;
    renderPagesList();
    setAutosaveStatus('Saved');
    setTimeout(() => setAutosaveStatus(''), 2000);
  } catch (err) {
    setAutosaveStatus('Save failed');
    console.error('Save error:', err);
  }
  isSaving = false;
}

async function createNewNotebook() {
  const title = prompt('Notebook name:');
  if (!title || !title.trim()) return;
  try {
    const res = await fetch('/api/notebooks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim() })
    });
    const nb = await res.json();
    if (!res.ok) { alert(nb.error); return; }
    notebooks.push(nb);
    renderNotebooksGrid();
    openNotebook(nb.id);
  } catch (err) { alert('Error: ' + err.message); }
}

async function createNewPage() {
  if (!activeNotebook) return;
  await saveActiveNote(true);
  try {
    const res = await fetch(`/api/notebooks/${activeNotebook.id}/notes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Untitled Page', body: '', tags: '' })
    });
    const note = await res.json();
    notes.push(note);
    activeNote = note;
    renderPagesList();
    loadPageIntoEditor(note);
    setTimeout(() => {
      const t = document.getElementById('pageTitle');
      if (t) { t.select(); }
    }, 50);
  } catch (err) { alert('Error creating page: ' + err.message); }
}

// ── IMAGE UPLOAD ──────────────────────────────────────────────────────────────

function triggerImageUpload() {
  document.getElementById('imageFileInput').click();
}

async function handleImageUpload(file) {
  if (!file) return;
  const formData = new FormData();
  formData.append('image', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Upload failed'); return; }
    insertImageAtCursor(data.url);
  } catch (err) { alert('Upload error: ' + err.message); }
}

function insertImageAtCursor(url) {
  const body = document.getElementById('pageBody');
  if (!body) return;
  body.focus();

  const img = document.createElement('img');
  img.src = url;
  img.className = 'note-img';
  img.alt = '';

  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const range = sel.getRangeAt(0);
    // Make sure we're inside the editor
    if (body.contains(range.commonAncestorContainer)) {
      range.deleteContents();
      range.insertNode(img);
      // Move cursor after the image
      const after = document.createRange();
      after.setStartAfter(img);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    } else {
      body.appendChild(img);
    }
  } else {
    body.appendChild(img);
  }
  scheduleNoteSave();
}

function fmt(cmd) {
  document.getElementById('pageBody')?.focus();
  document.execCommand(cmd, false, null);
  scheduleNoteSave();
}

// ── AI CHAT ──────────────────────────────────────────────────────────────────
function checkApiKey() {
  const notice = document.getElementById('apiKeyNotice');
  if (getApiKey()) notice.classList.add('hidden');
  else notice.classList.remove('hidden');
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

  const welcomeEl = document.querySelector('.chat-welcome');
  if (welcomeEl) welcomeEl.style.display = 'none';

  const messagesEl = document.getElementById('chatMessages');

  messagesEl.innerHTML += `
    <div class="message user">
      <div class="msg-avatar">👤</div>
      <div class="msg-bubble">${escHtml(msg)}</div>
    </div>
  `;

  const aiId = 'ai-msg-' + Date.now();
  messagesEl.innerHTML += `
    <div class="message" id="${aiId}">
      <div class="msg-avatar">🤖</div>
      <div class="msg-bubble msg-streaming" id="${aiId}-bubble"></div>
    </div>
  `;

  messagesEl.scrollTop = messagesEl.scrollHeight;
  document.getElementById('sendBtn').disabled = true;

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
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') break;
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) { bubbleEl.classList.remove('msg-streaming'); bubbleEl.textContent = '❌ Error: ' + parsed.error; break; }
          if (parsed.text) { fullText += parsed.text; bubbleEl.innerHTML = formatMarkdown(fullText); messagesEl.scrollTop = messagesEl.scrollHeight; }
        } catch (_) {}
      }
    }

    bubbleEl.classList.remove('msg-streaming');
    bubbleEl.innerHTML = formatMarkdown(fullText);
  } catch (err) {
    const bubbleEl = document.getElementById(`${aiId}-bubble`);
    if (bubbleEl) { bubbleEl.classList.remove('msg-streaming'); bubbleEl.textContent = '❌ Network error: ' + err.message; }
  }

  document.getElementById('sendBtn').disabled = false;
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

// ── EVENT LISTENERS ──────────────────────────────────────────────────────────
function setupEventListeners() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      showTab(btn.dataset.tab);
      if (btn.dataset.tab === 'trading') initTradingTab();
    });
  });

  // Trading subnav
  document.querySelectorAll('.t-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTradingView(btn.dataset.tview));
  });

  // Trading account switcher
  document.getElementById('tradingAccountSelect')?.addEventListener('change', (e) => {
    activeTradingConnId = e.target.value;
    updatePaperBadge();
    loadTradingData();
  });

  // Refresh button
  document.getElementById('refreshTradingBtn')?.addEventListener('click', loadTradingData);

  document.getElementById('openTradeModal').addEventListener('click', () => openTradeModal());
  document.getElementById('tradeForm').addEventListener('submit', saveTrade);
  document.querySelectorAll('.close-modal').forEach(b => {
    b.addEventListener('click', () => document.getElementById('tradeModal').classList.add('hidden'));
  });

  document.getElementById('quickTradeForm').addEventListener('submit', quickAddTrade);

  document.getElementById('tradeSearch').addEventListener('input', renderTradesTable);
  document.getElementById('tradeStatusFilter').addEventListener('change', renderTradesTable);
  document.getElementById('tradeDirFilter').addEventListener('change', renderTradesTable);

  document.getElementById('newNotebookBtn').addEventListener('click', createNewNotebook);
  document.getElementById('newPageBtn').addEventListener('click', createNewPage);
  document.getElementById('backToNotebooks').addEventListener('click', backToNotebooks);
  document.getElementById('deletePageBtn').addEventListener('click', () => {
    if (activeNote) confirmDelete(activeNote.id, 'note');
  });
  document.getElementById('imageFileInput').addEventListener('change', (e) => {
    handleImageUpload(e.target.files[0]);
    e.target.value = ''; // reset so same file can be re-selected
  });

  // Editor input events (contenteditable)
  const pageBody = document.getElementById('pageBody');
  const pageTitle = document.getElementById('pageTitle');
  const pageTags = document.getElementById('pageTags');
  if (pageBody) pageBody.addEventListener('input', scheduleNoteSave);
  if (pageTitle) pageTitle.addEventListener('input', scheduleNoteSave);
  if (pageTags) pageTags.addEventListener('input', scheduleNoteSave);

  document.getElementById('sendBtn').addEventListener('click', sendMessage);
  document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  document.getElementById('chatInput').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

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

  document.getElementById('confirmOk').addEventListener('click', executeDelete);
  document.getElementById('confirmCancel').addEventListener('click', () => {
    document.getElementById('confirmModal').classList.add('hidden');
    pendingDeleteId = null;
  });

  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  });

  document.getElementById('loadChartBtn').addEventListener('click', () => {
    const sym = document.getElementById('chartSymbolInput').value.trim();
    if (sym) loadChart(sym);
  });
  document.getElementById('chartSymbolInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const sym = e.target.value.trim(); if (sym) loadChart(sym); }
  });
  document.querySelectorAll('.sym-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const sym = btn.dataset.sym;
      document.getElementById('chartSymbolInput').value = sym;
      loadChart(sym);
      document.querySelectorAll('.sym-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  document.getElementById('logoutBtn').addEventListener('click', logout);
  setupBrokerListeners();
}

// ── CHARTS ───────────────────────────────────────────────────────────────────
function loadChart(symbol) {
  const interval = document.getElementById('chartInterval').value;
  const container = document.getElementById('tradingview-widget-container');
  const sym = symbol.toUpperCase();

  const params = new URLSearchParams({
    symbol: sym, interval, theme: 'dark', style: '1', locale: 'en',
    toolbar_bg: '#161b22', enable_publishing: '0', hide_top_toolbar: '0',
    hide_legend: '0', save_image: '1', withdateranges: '1',
    timezone: 'America/New_York', utm_source: 'localhost', utm_medium: 'widget',
  });

  container.innerHTML = `<iframe
    src="https://www.tradingview.com/widgetembed/?${params.toString()}"
    style="width:100%;height:100%;border:none;border-radius:8px;"
    allowtransparency="true" allowfullscreen frameborder="0"></iframe>`;

  document.querySelectorAll('.sym-chip').forEach(b => {
    b.classList.toggle('active', b.dataset.sym === sym);
  });
}

function renderMyTradeSymbols() {
  const uniqueSymbols = [...new Set(trades.map(t => t.symbol.toUpperCase()))];
  const wrapper = document.getElementById('myTradeSymbols');
  const chipsEl = document.getElementById('tradeSymbolChips');
  if (!uniqueSymbols.length) { wrapper.style.display = 'none'; return; }
  wrapper.style.display = 'flex';
  chipsEl.innerHTML = uniqueSymbols.map(sym =>
    `<button class="sym-chip" data-sym="${sym}" onclick="document.getElementById('chartSymbolInput').value='${sym}';loadChart('${sym}')">${sym}</button>`
  ).join('');
}

// ── TRADING ──────────────────────────────────────────────────────────────────

let activeTradingConnId = null;
let tradingAccount      = null;
let tradingPositions    = [];
let tradingOrders       = [];
let pendingOrder        = null;
let tradeSide           = 'buy';
let tradingRefreshTimer = null;
const TIF_LABELS = { day: 'Day', gtc: 'Good Till Canceled', ioc: 'Immediate or Cancel', fok: 'Fill or Kill' };
const TYPE_LABELS = { market: 'Market', limit: 'Limit', stop: 'Stop', stop_limit: 'Stop-Limit', trailing_stop: 'Trailing Stop' };
const ORDER_STATUS_CLASS = {
  filled: 'status-filled', partially_filled: 'status-partial',
  new: 'status-new', accepted: 'status-new', pending_new: 'status-new',
  canceled: 'status-canceled', expired: 'status-canceled', rejected: 'status-rejected',
  held: 'status-new', replaced: 'status-canceled'
};

function initTradingTab() {
  const alpacaConns = brokers.filter(b => b.broker === 'alpaca');
  if (!alpacaConns.length) {
    document.getElementById('tradingNoConn').classList.remove('hidden');
    document.getElementById('tradingInterface').classList.add('hidden');
    return;
  }
  document.getElementById('tradingNoConn').classList.add('hidden');
  document.getElementById('tradingInterface').classList.remove('hidden');

  const sel = document.getElementById('tradingAccountSelect');
  sel.innerHTML = alpacaConns.map(c =>
    `<option value="${c.id}">${escHtml(c.label || 'Alpaca')} (${c.isPaper ? 'Paper' : 'Live'})</option>`
  ).join('');

  // Auto-select first or restore previous selection
  activeTradingConnId = activeTradingConnId && alpacaConns.find(c => c.id === activeTradingConnId)
    ? activeTradingConnId : alpacaConns[0].id;
  sel.value = activeTradingConnId;

  updatePaperBadge();
  loadTradingData();
  startTradingRefresh();
}

function updatePaperBadge() {
  const conn = brokers.find(b => b.id === activeTradingConnId);
  const badge = document.getElementById('paperBadge');
  if (conn?.isPaper) badge.classList.remove('hidden');
  else badge.classList.add('hidden');
}

async function loadTradingData() {
  if (!activeTradingConnId) return;
  const body = { connectionId: activeTradingConnId };
  try {
    const [acctRes, posRes, ordRes, clockRes] = await Promise.all([
      post('/api/trading/account',   body),
      post('/api/trading/positions', body),
      post('/api/trading/orders',    { ...body, status: 'all', limit: 100 }),
      post('/api/trading/clock',     body)
    ]);
    if (acctRes.ok)  { tradingAccount   = await acctRes.json();  renderAccountStats(); }
    if (posRes.ok)   { tradingPositions = await posRes.json();   renderPositions();    }
    if (ordRes.ok)   { tradingOrders    = await ordRes.json();   renderOrders();       }
    if (clockRes.ok) { const clk = await clockRes.json(); renderMarketClock(clk); }
  } catch (e) { console.error('Trading refresh error', e); }
}

function post(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function startTradingRefresh() {
  clearInterval(tradingRefreshTimer);
  tradingRefreshTimer = setInterval(() => {
    if (document.querySelector('.nav-btn[data-tab="trading"]')?.classList.contains('active')) {
      loadTradingData();
    }
  }, 30000); // every 30 seconds
}

// ── Account stats ─────────────────────────────────────────────────────────────

function renderAccountStats() {
  if (!tradingAccount) return;
  const equity   = parseFloat(tradingAccount.equity   || 0);
  const lastEq   = parseFloat(tradingAccount.last_equity || equity);
  const cash     = parseFloat(tradingAccount.cash     || 0);
  const bp       = parseFloat(tradingAccount.buying_power || 0);
  const dayPnl   = equity - lastEq;
  const dayPct   = lastEq ? (dayPnl / lastEq * 100) : 0;

  document.getElementById('ts-equity').textContent = fmt$(equity);
  document.getElementById('ts-cash').textContent   = fmt$(cash);
  document.getElementById('ts-bp').textContent     = fmt$(bp);

  const dpEl = document.getElementById('ts-daypnl');
  dpEl.textContent = `${dayPnl >= 0 ? '+' : ''}${fmt$(dayPnl)} (${dayPct >= 0 ? '+' : ''}${dayPct.toFixed(2)}%)`;
  dpEl.style.color = dayPnl >= 0 ? 'var(--green)' : 'var(--red)';
}

function renderMarketClock(clk) {
  const el = document.getElementById('marketStatus');
  if (clk.is_open) {
    el.innerHTML = '<span class="mkt-dot mkt-open"></span> Market Open';
    el.className = 'market-status mkt-status-open';
  } else {
    const nextOpen = new Date(clk.next_open);
    el.innerHTML = `<span class="mkt-dot mkt-closed"></span> Market Closed`;
    el.title = `Next open: ${nextOpen.toLocaleString()}`;
    el.className = 'market-status mkt-status-closed';
  }
}

// ── Positions ─────────────────────────────────────────────────────────────────

function renderPositions() {
  const tbody = document.getElementById('positionsBody');
  const countEl = document.getElementById('positionsCount');
  if (!tradingPositions.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No open positions</td></tr>';
    countEl.textContent = '0 positions';
    renderTradeViewPositions();
    return;
  }
  countEl.textContent = `${tradingPositions.length} position${tradingPositions.length !== 1 ? 's' : ''}`;
  tbody.innerHTML = tradingPositions.map(p => {
    const upl = parseFloat(p.unrealized_pl || 0);
    const pct = parseFloat(p.unrealized_plpc || 0) * 100;
    const todayPct = parseFloat(p.change_today || 0) * 100;
    const uplCls = upl >= 0 ? 'pnl-pos' : 'pnl-neg';
    return `<tr>
      <td><strong>${escHtml(p.symbol)}</strong></td>
      <td><span class="badge badge-${p.side || 'long'}">${(p.side || 'long').toUpperCase()}</span></td>
      <td>${parseFloat(p.qty || 0)}</td>
      <td>$${parseFloat(p.avg_entry_price || 0).toFixed(2)}</td>
      <td>$${parseFloat(p.current_price || 0).toFixed(2)}</td>
      <td>$${parseFloat(p.market_value || 0).toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}</td>
      <td class="${uplCls}">${upl >= 0 ? '+' : ''}${fmt$(upl)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</td>
      <td class="${todayPct >= 0 ? 'pnl-pos' : 'pnl-neg'}">${todayPct >= 0 ? '+' : ''}${todayPct.toFixed(2)}%</td>
      <td>
        <div class="action-btns">
          <button class="btn-edit" onclick="quickTrade('buy','${escHtml(p.symbol)}')">Buy More</button>
          <button class="btn-del" onclick="quickTrade('sell','${escHtml(p.symbol)}','${parseFloat(p.qty||0)}')">Sell</button>
        </div>
      </td>
    </tr>`;
  }).join('');
  renderTradeViewPositions();
}

function renderTradeViewPositions() {
  const el = document.getElementById('tradeViewPositions');
  if (!el) return;
  if (!tradingPositions.length) {
    el.innerHTML = '<div class="empty-state" style="padding:20px">No open positions</div>';
    return;
  }
  el.innerHTML = tradingPositions.map(p => {
    const upl = parseFloat(p.unrealized_pl || 0);
    return `<div class="trade-pos-item" onclick="quickTrade('sell','${escHtml(p.symbol)}','${parseFloat(p.qty||0)}')">
      <div>
        <strong>${escHtml(p.symbol)}</strong>
        <span style="color:var(--text2);font-size:11px;margin-left:6px">${parseFloat(p.qty||0)} shares</span>
      </div>
      <div class="${upl >= 0 ? 'pnl-pos' : 'pnl-neg'}" style="font-size:12px">
        ${upl >= 0 ? '+' : ''}${fmt$(upl)}
      </div>
    </div>`;
  }).join('');
}

// ── Orders ────────────────────────────────────────────────────────────────────

function renderOrders() { filterOrders(); }

function filterOrders() {
  const filter = document.getElementById('orderStatusFilter')?.value || 'all';
  const openStatuses   = new Set(['new','accepted','pending_new','accepted_for_bidding','held','partially_filled','calculated','done_for_day','stopped','suspended','pending_replace']);
  const closedStatuses = new Set(['filled','canceled','expired','replaced','rejected']);

  let filtered = tradingOrders;
  if (filter === 'open')   filtered = tradingOrders.filter(o => openStatuses.has(o.status));
  if (filter === 'closed') filtered = tradingOrders.filter(o => closedStatuses.has(o.status));

  const tbody = document.getElementById('ordersBody');
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state">No orders</td></tr>';
    return;
  }

  const cancelable = new Set(['new','accepted','pending_new','accepted_for_bidding','held','partially_filled']);
  tbody.innerHTML = filtered.map(o => {
    const stCls = ORDER_STATUS_CLASS[o.status] || 'status-new';
    const created = o.created_at ? new Date(o.created_at).toLocaleString() : '—';
    const canCancel = cancelable.has(o.status);
    return `<tr>
      <td><strong>${escHtml(o.symbol)}</strong></td>
      <td><span class="badge badge-${o.side || 'buy'}">${(o.side || '').toUpperCase()}</span></td>
      <td>${parseFloat(o.qty || o.notional || 0)}</td>
      <td>${parseFloat(o.filled_qty || 0)}</td>
      <td>${TYPE_LABELS[o.type] || o.type}</td>
      <td>${o.limit_price ? '$' + parseFloat(o.limit_price).toFixed(2) : '—'}</td>
      <td>${o.stop_price  ? '$' + parseFloat(o.stop_price).toFixed(2)  : '—'}</td>
      <td>${o.filled_avg_price ? '$' + parseFloat(o.filled_avg_price).toFixed(2) : '—'}</td>
      <td><span class="order-status-badge ${stCls}">${o.status.replace(/_/g,' ')}</span></td>
      <td style="font-size:11px;color:var(--text2)">${created}</td>
      <td>
        ${canCancel ? `<button class="btn-del" onclick="cancelOrder('${o.id}')">Cancel</button>` : '—'}
      </td>
    </tr>`;
  }).join('');
}

async function cancelOrder(orderId) {
  if (!confirm('Cancel this order?')) return;
  try {
    const res = await post('/api/trading/cancel-order', { connectionId: activeTradingConnId, orderId });
    if (res.ok) { await loadTradingData(); }
    else { const d = await res.json(); alert('Cancel failed: ' + d.error); }
  } catch (e) { alert('Error: ' + e.message); }
}

// ── Place Trade ───────────────────────────────────────────────────────────────

function setTradeSide(side) {
  tradeSide = side;
  document.getElementById('sideBuyBtn').classList.toggle('active', side === 'buy');
  document.getElementById('sideSellBtn').classList.toggle('active', side === 'sell');
}

function updateOrderFields() {
  const type = document.getElementById('orderType').value;
  document.getElementById('grp-limit').classList.toggle('hidden', !['limit','stop_limit'].includes(type));
  document.getElementById('grp-stop').classList.toggle('hidden',  !['stop','stop_limit'].includes(type));
  document.getElementById('grp-trail').classList.toggle('hidden', type !== 'trailing_stop');
}

function quickTrade(side, symbol, qty = '') {
  switchTradingView('trade');
  setTradeSide(side);
  document.getElementById('orderSymbol').value = symbol;
  if (qty) document.getElementById('orderQty').value = qty;
  document.getElementById('orderType').value = 'market';
  updateOrderFields();
  document.getElementById('previewOrderBtn').scrollIntoView({ behavior: 'smooth' });
}

async function previewOrder() {
  const errEl = document.getElementById('tradeFormError');
  errEl.classList.add('hidden');

  const symbol = document.getElementById('orderSymbol').value.trim().toUpperCase();
  const qty    = document.getElementById('orderQty').value.trim();
  const type   = document.getElementById('orderType').value;
  const tif    = document.getElementById('orderTIF').value;
  const limitP = document.getElementById('orderLimitPrice').value.trim();
  const stopP  = document.getElementById('orderStopPrice').value.trim();
  const trailP = document.getElementById('orderTrailPrice').value.trim();

  if (!symbol) { showTradeError('Symbol is required'); return; }
  if (!qty || parseFloat(qty) <= 0) { showTradeError('Quantity must be greater than 0'); return; }
  if (['limit','stop_limit'].includes(type) && !limitP) { showTradeError('Limit price is required for this order type'); return; }
  if (['stop','stop_limit'].includes(type) && !stopP) { showTradeError('Stop price is required for this order type'); return; }
  if (type === 'trailing_stop' && !trailP) { showTradeError('Trail amount is required'); return; }

  // Build order payload
  pendingOrder = { symbol, qty, side: tradeSide, type, time_in_force: tif };
  if (limitP) pendingOrder.limit_price  = limitP;
  if (stopP)  pendingOrder.stop_price   = stopP;
  if (trailP) pendingOrder.trail_price  = trailP;

  // Fill preview modal
  const conn = brokers.find(b => b.id === activeTradingConnId);
  const isBuy = tradeSide === 'buy';
  document.getElementById('orderActionBanner').textContent   = tradeSide.toUpperCase();
  document.getElementById('orderActionBanner').style.background = isBuy ? 'var(--green)' : 'var(--red)';
  document.getElementById('prev-symbol').textContent  = symbol;
  document.getElementById('prev-side').textContent    = tradeSide.toUpperCase();
  document.getElementById('prev-qty').textContent     = qty + ' shares';
  document.getElementById('prev-type').textContent    = TYPE_LABELS[type] || type;
  document.getElementById('prev-tif').textContent     = TIF_LABELS[tif]  || tif;
  document.getElementById('prev-account').textContent = conn?.label || 'Alpaca';

  document.getElementById('prev-row-limit').classList.toggle('hidden', !limitP);
  document.getElementById('prev-row-stop').classList.toggle('hidden',  !stopP);
  document.getElementById('prev-row-trail').classList.toggle('hidden', !trailP);
  if (limitP) document.getElementById('prev-limit').textContent = '$' + parseFloat(limitP).toFixed(2);
  if (stopP)  document.getElementById('prev-stop').textContent  = '$' + parseFloat(stopP).toFixed(2);
  if (trailP) document.getElementById('prev-trail').textContent = '$' + parseFloat(trailP).toFixed(2);

  if (type === 'market') {
    document.getElementById('prev-est').textContent = 'At next available market price';
  } else if (limitP) {
    document.getElementById('prev-est').textContent = `~$${(parseFloat(limitP) * parseFloat(qty)).toLocaleString('en-US', {minimumFractionDigits:2})}`;
  }

  document.getElementById('orderPreviewModal').classList.remove('hidden');
}

async function submitOrder() {
  if (!pendingOrder) return;
  const btn = document.getElementById('submitOrderBtn');
  btn.disabled = true; btn.textContent = 'Submitting…';

  try {
    const res = await post('/api/trading/place-order', { connectionId: activeTradingConnId, ...pendingOrder });
    const data = await res.json();
    document.getElementById('orderPreviewModal').classList.add('hidden');

    if (!res.ok) {
      document.getElementById('orderConfirmIcon').textContent = '❌';
      document.getElementById('orderConfirmTitle').textContent = 'Order Rejected';
      document.getElementById('orderConfirmMsg').textContent = data.error || 'The order was rejected by Alpaca.';
      document.getElementById('orderConfirmId').textContent = '';
    } else {
      document.getElementById('orderConfirmIcon').textContent = '✅';
      document.getElementById('orderConfirmTitle').textContent = `${pendingOrder.side.toUpperCase()} Order Submitted`;
      document.getElementById('orderConfirmMsg').textContent = `Your ${TYPE_LABELS[pendingOrder.type]?.toLowerCase() || pendingOrder.type} order for ${pendingOrder.qty} shares of ${pendingOrder.symbol} has been submitted.`;
      document.getElementById('orderConfirmId').textContent = `Order ID: ${data.id || '—'}`;
      // Refresh data after short delay
      setTimeout(loadTradingData, 1500);
    }
    document.getElementById('orderConfirmModal').classList.remove('hidden');
    pendingOrder = null;
  } catch (e) {
    alert('Network error: ' + e.message);
  }
  btn.disabled = false; btn.textContent = 'Confirm & Submit';
}

function showTradeError(msg) {
  const el = document.getElementById('tradeFormError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function switchTradingView(view) {
  document.querySelectorAll('.tview').forEach(v => v.classList.add('hidden'));
  document.getElementById(`tview-${view}`)?.classList.remove('hidden');
  document.querySelectorAll('.t-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tview === view));
}

function fmt$(n) {
  return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── BROKERS ──────────────────────────────────────────────────────────────────

async function loadBrokers() {
  try {
    const res = await fetch('/api/brokers');
    if (res.ok) brokers = await res.json();
  } catch { brokers = []; }
}

function renderBrokersPage() {
  renderAlpacaConnections();
}

function renderAlpacaConnections() {
  const el = document.getElementById('alpacaConnectionsList');
  if (!el) return;
  const alpacaConns = brokers.filter(b => b.broker === 'alpaca');
  if (!alpacaConns.length) { el.innerHTML = ''; return; }
  el.innerHTML = alpacaConns.map(c => `
    <div class="alpaca-conn-row card">
      <div style="display:flex;align-items:center;gap:12px;flex:1">
        <span style="font-size:20px">🦙</span>
        <div>
          <div style="font-weight:600;font-size:14px">${escHtml(c.label || 'Alpaca')}</div>
          <div style="font-size:12px;color:var(--text2)">${c.isPaper ? 'Paper Trading' : 'Live Trading'} · Connected ${formatDate(c.createdAt)}</div>
        </div>
        <span class="conn-status-badge">Connected</span>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn-primary btn-sm" onclick="fetchAlpacaTrades('${c.id}')">📥 Fetch Trades</button>
        <button class="btn-del" onclick="disconnectBroker('${c.id}')">Disconnect</button>
      </div>
    </div>
  `).join('');
}

// ── Alpaca connect form ───────────────────────────────────────────────────────

function setupBrokerListeners() {
  document.getElementById('openAlpacaFormBtn')?.addEventListener('click', () => {
    document.getElementById('alpacaForm').classList.remove('hidden');
    document.getElementById('openAlpacaFormBtn').classList.add('hidden');
  });
  document.getElementById('cancelAlpacaForm')?.addEventListener('click', () => {
    document.getElementById('alpacaForm').classList.add('hidden');
    document.getElementById('openAlpacaFormBtn').classList.remove('hidden');
    document.getElementById('alpacaFormError').classList.add('hidden');
  });
  document.getElementById('saveAlpacaBtn')?.addEventListener('click', saveAlpacaConnection);

  // CSV import modal events
  document.getElementById('csvDropZone')?.addEventListener('click', () => document.getElementById('csvFileInput').click());
  document.getElementById('csvDropZone')?.addEventListener('dragover', e => { e.preventDefault(); e.currentTarget.classList.add('dragover'); });
  document.getElementById('csvDropZone')?.addEventListener('dragleave', e => e.currentTarget.classList.remove('dragover'));
  document.getElementById('csvDropZone')?.addEventListener('drop', e => {
    e.preventDefault();
    e.currentTarget.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) handleCsvFile(file);
  });
  document.getElementById('csvFileInput')?.addEventListener('change', e => {
    if (e.target.files[0]) handleCsvFile(e.target.files[0]);
    e.target.value = '';
  });
  document.getElementById('backToStep1Btn')?.addEventListener('click', () => {
    document.getElementById('importStep2').classList.add('hidden');
    document.getElementById('importStep1').classList.remove('hidden');
  });
  document.getElementById('importSelectedBtn')?.addEventListener('click', importSelectedTrades);
  document.querySelectorAll('.close-import-modal').forEach(b => b.addEventListener('click', closeImportModal));
}

async function saveAlpacaConnection() {
  const apiKey    = document.getElementById('alpacaKeyInput').value.trim();
  const apiSecret = document.getElementById('alpacaSecretInput').value.trim();
  const label     = document.getElementById('alpacaLabelInput').value.trim();
  const isPaper   = document.getElementById('alpacaPaperToggle').checked;
  const errEl     = document.getElementById('alpacaFormError');
  errEl.classList.add('hidden');

  if (!apiKey || !apiSecret) {
    errEl.textContent = 'API Key and Secret are required.';
    errEl.classList.remove('hidden');
    return;
  }

  const btn = document.getElementById('saveAlpacaBtn');
  btn.disabled = true; btn.textContent = 'Connecting…';

  try {
    const res = await fetch('/api/brokers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ broker: 'alpaca', label: label || 'Alpaca Account', apiKey, apiSecret, isPaper })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error; errEl.classList.remove('hidden'); return; }
    brokers.push(data);
    document.getElementById('alpacaKeyInput').value = '';
    document.getElementById('alpacaSecretInput').value = '';
    document.getElementById('alpacaLabelInput').value = '';
    document.getElementById('alpacaForm').classList.add('hidden');
    document.getElementById('openAlpacaFormBtn').classList.remove('hidden');
    renderAlpacaConnections();
    // Reinitialize trading tab if it's active
    if (document.querySelector('.nav-btn[data-tab="trading"]')?.classList.contains('active')) {
      initTradingTab();
    }
  } catch (err) {
    errEl.textContent = 'Error: ' + err.message;
    errEl.classList.remove('hidden');
  }
  btn.disabled = false; btn.textContent = 'Save Connection';
}

async function disconnectBroker(id) {
  if (!confirm('Disconnect this account? Your imported trades will stay in the tracker.')) return;
  await fetch(`/api/brokers/${id}`, { method: 'DELETE' });
  brokers = brokers.filter(b => b.id !== id);
  renderAlpacaConnections();
}

// ── Fetch from Alpaca ─────────────────────────────────────────────────────────

async function fetchAlpacaTrades(connectionId) {
  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Fetching…';
  try {
    const res = await fetch('/api/brokers/alpaca/fetch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId })
    });
    const data = await res.json();
    if (!res.ok) { alert('Alpaca error: ' + data.error); return; }

    // Combine filled orders + open positions
    const combined = [...(data.trades || []), ...(data.positions || [])];
    if (!combined.length) { alert('No trades found in this Alpaca account.'); return; }

    importSelectedBroker = 'alpaca';
    showImportPreview(combined, `Alpaca — ${data.totalOrders} orders fetched`);
  } catch (err) { alert('Error: ' + err.message); }
  btn.disabled = false; btn.textContent = '📥 Fetch Trades';
}

// ── CSV import flow ───────────────────────────────────────────────────────────

const BROKER_LABELS = {
  robinhood: 'Robinhood',
  webull:    'Webull',
  td:        'TD Ameritrade / Schwab',
  ibkr:      'Interactive Brokers',
  alpaca:    'Alpaca',
  generic:   'Custom CSV'
};

const BROKER_INSTRUCTIONS = {
  robinhood: 'In Robinhood: Account → Statements & History → scroll to "Brokerage Statements" → Download CSV.',
  webull:    'In Webull app: More → Orders → Order History → tap Export (top right).',
  td:        'In TD / Schwab: History & Statements → Transactions → Export (CSV).',
  ibkr:      'In IBKR: Reports → Statements → Activity → select date range → CSV.',
  generic:   'Upload any CSV that has columns for symbol, price, quantity, and date.',
};

function openCsvImport(broker) {
  importSelectedBroker = broker;
  document.getElementById('importModalTitle').textContent = `Import from ${BROKER_LABELS[broker] || broker}`;
  document.getElementById('importBrokerBadge').textContent = BROKER_LABELS[broker] || broker;
  const inst = BROKER_INSTRUCTIONS[broker] || '';
  const instrEl = document.getElementById('csvInstructions');
  instrEl.textContent = inst;
  instrEl.style.display = inst ? 'block' : 'none';
  document.getElementById('importStep1Error').classList.add('hidden');
  document.getElementById('importStep1Loading').classList.add('hidden');
  document.getElementById('importStep1').classList.remove('hidden');
  document.getElementById('importStep2').classList.add('hidden');
  document.getElementById('importStep3').classList.add('hidden');
  document.getElementById('brokerImportModal').classList.remove('hidden');
}

function closeImportModal() {
  document.getElementById('brokerImportModal').classList.add('hidden');
  importParsedTrades = [];
}

async function handleCsvFile(file) {
  const errEl = document.getElementById('importStep1Error');
  const loadEl = document.getElementById('importStep1Loading');
  errEl.classList.add('hidden');
  loadEl.classList.remove('hidden');

  const formData = new FormData();
  formData.append('file', file);
  formData.append('broker', importSelectedBroker);

  try {
    const res = await fetch('/api/brokers/parse-csv', { method: 'POST', body: formData });
    const data = await res.json();
    loadEl.classList.add('hidden');
    if (!res.ok) { errEl.textContent = data.error; errEl.classList.remove('hidden'); return; }
    if (!data.trades?.length) {
      errEl.textContent = `No trades found in this CSV (${data.totalRows} rows scanned). Make sure it's the correct export format.`;
      errEl.classList.remove('hidden');
      return;
    }
    showImportPreview(data.trades, `${BROKER_LABELS[data.broker] || data.broker} — ${data.parsedTrades} trades found from ${data.totalRows} rows`);
  } catch (err) {
    loadEl.classList.add('hidden');
    errEl.textContent = 'Upload error: ' + err.message;
    errEl.classList.remove('hidden');
  }
}

// ── Import preview table ──────────────────────────────────────────────────────

function showImportPreview(parsedTrades, summaryText) {
  importParsedTrades = parsedTrades;

  document.getElementById('importStep1').classList.add('hidden');
  document.getElementById('importStep2').classList.remove('hidden');
  document.getElementById('importSummaryText').textContent = summaryText;

  const alreadyIn = new Set(
    trades.map(t => `${t.symbol}|${t.date}|${t.entryPrice || t.exitPrice}`)
  );

  const tbody = document.getElementById('importTableBody');
  tbody.innerHTML = parsedTrades.map((t, i) => {
    const key = `${t.symbol}|${t.date}|${t.entryPrice || t.exitPrice}`;
    const dup = alreadyIn.has(key);
    return `
    <tr class="${dup ? 'import-row-dup' : ''}">
      <td><input type="checkbox" class="import-chk" data-idx="${i}" ${dup ? '' : 'checked'} onchange="updateImportCount()" /></td>
      <td><strong>${escHtml(t.symbol)}</strong></td>
      <td><span class="badge badge-${t.direction || 'long'}">${(t.direction || 'long').toUpperCase()}</span></td>
      <td>${t.entryPrice || '—'}</td>
      <td>${t.exitPrice || '—'}</td>
      <td>${t.quantity || '—'}</td>
      <td class="${t.pnl?.startsWith('+') ? 'pnl-pos' : t.pnl?.startsWith('-') ? 'pnl-neg' : ''}">${t.pnl || '—'}</td>
      <td>${t.date || '—'}</td>
      <td><span class="badge badge-${t.assetType || 'stock'}">${(t.assetType || 'stock').toUpperCase()}</span></td>
      <td style="max-width:180px;font-size:11px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(t.notes || '')}">${dup ? '<span style="color:var(--yellow)">⚠ Already imported</span>' : escHtml((t.notes || '').slice(0, 40))}</td>
    </tr>`;
  }).join('');

  updateImportCount();
}

function updateImportCount() {
  const checked = document.querySelectorAll('.import-chk:checked').length;
  const total   = document.querySelectorAll('.import-chk').length;
  document.getElementById('selectedCount').textContent = `${checked} of ${total} selected`;
  const btn = document.getElementById('importSelectedBtn');
  btn.textContent = `Import ${checked} Trade${checked !== 1 ? 's' : ''}`;
  btn.disabled = checked === 0;
  document.getElementById('selectAllCheckbox').checked = checked === total;
  document.getElementById('selectAllCheckbox').indeterminate = checked > 0 && checked < total;
}

function selectAllImport(checked) {
  document.querySelectorAll('.import-chk').forEach(cb => cb.checked = checked);
  updateImportCount();
}

async function importSelectedTrades() {
  const selected = [...document.querySelectorAll('.import-chk:checked')]
    .map(cb => importParsedTrades[parseInt(cb.dataset.idx)]);

  if (!selected.length) return;

  const btn = document.getElementById('importSelectedBtn');
  btn.disabled = true; btn.textContent = 'Importing…';

  let imported = 0;
  for (const t of selected) {
    try {
      const body = { symbol: t.symbol, assetType: t.assetType || 'stock', direction: t.direction || 'long', date: t.date || '', entryPrice: t.entryPrice || '', exitPrice: t.exitPrice || '', quantity: t.quantity || '', pnl: t.pnl || '', status: t.status || 'open', notes: t.notes || '', reason: `Imported from ${BROKER_LABELS[importSelectedBroker] || importSelectedBroker}` };
      const res = await fetch('/api/trades', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) { const newTrade = await res.json(); trades.push(newTrade); imported++; }
    } catch { /* skip failed rows */ }
  }

  updateDashboard();
  renderTradesTable();
  renderMyTradeSymbols();

  document.getElementById('importStep2').classList.add('hidden');
  document.getElementById('importStep3').classList.remove('hidden');
  document.getElementById('importSuccessMsg').textContent = `${imported} Trade${imported !== 1 ? 's' : ''} Imported!`;
  btn.disabled = false;
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
