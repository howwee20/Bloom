const SESSION_KEY = "bloom_console_session_v1";

const state = {
  session: null,
  connected: false,
  messages: [],
  pendingQuotes: [],
  stepUp: null,
  stepUpError: "",
  streaming: false,
  lastUpdatedAt: null,
  refreshTimer: null,
  updatedTimer: null,
  abortController: null
};

const elements = {
  statusBadge: document.getElementById("statusBadge"),
  detailsToggle: document.getElementById("detailsToggle"),
  detailsDrawer: document.getElementById("detailsDrawer"),
  detailsClose: document.getElementById("detailsClose"),
  detailsOverlay: document.getElementById("detailsOverlay"),
  availableValue: document.getElementById("availableValue"),
  updatedLabel: document.getElementById("updatedLabel"),
  chatMessages: document.getElementById("chatMessages"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
  stopButton: document.getElementById("stopButton"),
  sendButton: document.getElementById("sendButton"),
  emptyState: document.getElementById("emptyState"),
  connectPanel: document.getElementById("connectPanel"),
  connectButton: document.getElementById("connectButton"),
  bootstrapTokenWrap: document.getElementById("bootstrapTokenWrap"),
  bootstrapTokenInput: document.getElementById("bootstrapTokenInput"),
  bootstrapTokenInputDetails: document.getElementById("bootstrapTokenInputDetails"),
  sessionError: document.getElementById("sessionError"),
  suggestions: document.getElementById("suggestions"),
  walletAddress: document.getElementById("walletAddress"),
  copyAddress: document.getElementById("copyAddress"),
  recordList: document.getElementById("recordList"),
  lockButton: document.getElementById("lockButton"),
  createConfirmInput: document.getElementById("createConfirmInput"),
  createButton: document.getElementById("createButton"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  agentIdInput: document.getElementById("agentIdInput"),
  importButton: document.getElementById("importButton"),
  advancedError: document.getElementById("advancedError")
};

function getBootstrapToken() {
  const primary = elements.bootstrapTokenInput.value.trim();
  if (primary) return primary;
  const secondary = elements.bootstrapTokenInputDetails?.value.trim();
  return secondary || undefined;
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveSession(session) {
  state.session = session;
  if (!session) {
    localStorage.removeItem(SESSION_KEY);
  } else {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }
}

function setStatus(connected) {
  elements.statusBadge.textContent = connected ? "Connected" : "Disconnected";
  elements.statusBadge.classList.toggle("status--ok", connected);
}

function setConnected(connected) {
  state.connected = connected;
  setStatus(connected);
  elements.chatInput.disabled = !connected;
  elements.sendButton.disabled = !connected;
  if (!connected) {
    elements.availableValue.textContent = "$0.00";
    elements.updatedLabel.textContent = "Updated just now";
  }
  updateEmptyState();
}

function setStreaming(streaming) {
  state.streaming = streaming;
  elements.stopButton.hidden = !streaming;
  elements.sendButton.disabled = streaming || !state.connected;
}

function formatMoney(cents) {
  if (!Number.isFinite(cents)) return "$0.00";
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function setError(message) {
  elements.sessionError.textContent = message || "";
}

function setAdvancedError(message) {
  elements.advancedError.textContent = message || "";
}

function updateEmptyState() {
  const hasMessages = state.messages.length > 0;
  const showConnect = !state.connected;
  const showSuggestions = state.connected && !hasMessages;
  elements.emptyState.hidden = !showConnect && !showSuggestions;
  elements.connectPanel.hidden = !showConnect;
  elements.suggestions.hidden = !showSuggestions;
}

function renderMessages() {
  elements.chatMessages.innerHTML = "";

  state.messages.forEach((msg) => {
    const bubble = document.createElement("div");
    bubble.className = `message message--${msg.role}`;
    bubble.textContent = msg.content;
    elements.chatMessages.appendChild(bubble);
  });

  if (state.connected) {
    renderPendingQuotes();
    if (state.stepUp) {
      renderStepUpCard();
    }
  }

  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
  updateEmptyState();
}

function renderPendingQuotes() {
  state.pendingQuotes.forEach((quote) => {
    const card = document.createElement("div");
    card.className = "action-card";

    const title = document.createElement("div");
    title.className = "action-title";
    title.textContent = quote.allowed ? "Approval needed" : "Not approved";

    const summary = document.createElement("div");
    summary.className = "action-summary";
    summary.textContent = quote.summary || quote.reason || "Quote created";

    card.appendChild(title);
    card.appendChild(summary);

    if (quote.allowed) {
      const actions = document.createElement("div");
      actions.className = "action-actions";

      const approve = document.createElement("button");
      approve.className = "btn btn--primary";
      approve.type = "button";
      approve.textContent = quote.requires_step_up ? "Approve (step-up)" : "Approve";
      approve.addEventListener("click", () => handleApproval(quote));

      const cancel = document.createElement("button");
      cancel.className = "btn btn--ghost";
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => cancelQuote(quote.quote_id));

      actions.appendChild(approve);
      actions.appendChild(cancel);
      card.appendChild(actions);
    }

    elements.chatMessages.appendChild(card);
  });
}

function renderStepUpCard() {
  const card = document.createElement("div");
  card.className = "action-card";

  const title = document.createElement("div");
  title.className = "action-title";
  title.textContent = "Enter code";

  const summary = document.createElement("div");
  summary.className = "action-summary";
  summary.textContent = "Confirm this approval using your step-up code.";

  const inputRow = document.createElement("div");
  inputRow.className = "action-input";

  const codeInput = document.createElement("input");
  codeInput.placeholder = "Code";
  codeInput.value = state.stepUp.code || "";

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "btn btn--primary";
  confirmBtn.type = "button";
  confirmBtn.textContent = "Confirm";
  confirmBtn.addEventListener("click", () => confirmStepUp(codeInput.value.trim()));

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn btn--ghost";
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => cancelStepUp());

  inputRow.appendChild(codeInput);
  inputRow.appendChild(confirmBtn);
  inputRow.appendChild(cancelBtn);

  card.appendChild(title);
  card.appendChild(summary);
  card.appendChild(inputRow);

  if (state.stepUpError) {
    const error = document.createElement("div");
    error.className = "error";
    error.textContent = state.stepUpError;
    card.appendChild(error);
  }

  elements.chatMessages.appendChild(card);
}

function renderRecord(activity) {
  elements.recordList.innerHTML = "";
  if (!activity || activity.length === 0) {
    const empty = document.createElement("div");
    empty.className = "record-item";
    empty.textContent = "No record yet.";
    elements.recordList.appendChild(empty);
    return;
  }

  activity.forEach((item) => {
    const row = document.createElement("div");
    row.className = "record-item";

    const title = document.createElement("strong");
    title.textContent = item.line;

    const meta = document.createElement("div");
    meta.className = "record-meta";
    meta.textContent = item.when;

    row.appendChild(title);
    row.appendChild(meta);

    if (item.summary && item.summary.length) {
      const summary = document.createElement("div");
      summary.className = "record-meta";
      summary.textContent = item.summary.join(" | ");
      row.appendChild(summary);
    }

    elements.recordList.appendChild(row);
  });
}

function updateUpdatedLabel() {
  if (!state.lastUpdatedAt) {
    elements.updatedLabel.textContent = "Updated just now";
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - state.lastUpdatedAt);
  if (diff < 60) {
    elements.updatedLabel.textContent = "Updated just now";
  } else if (diff < 3600) {
    const mins = Math.floor(diff / 60);
    elements.updatedLabel.textContent = `Updated ${mins}m ago`;
  } else if (diff < 86400) {
    const hours = Math.floor(diff / 3600);
    elements.updatedLabel.textContent = `Updated ${hours}h ago`;
  } else {
    const days = Math.floor(diff / 86400);
    elements.updatedLabel.textContent = `Updated ${days}d ago`;
  }
}

async function apiFetch(path, options = {}) {
  const headers = {
    "content-type": "application/json",
    ...(options.headers || {})
  };

  if (state.session?.session_id) {
    headers["x-console-session"] = state.session.session_id;
  }
  if (state.session?.api_key) {
    headers["x-api-key"] = state.session.api_key;
  }

  const response = await fetch(path, { ...options, headers, signal: options.signal });
  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { error: raw };
    }
  }

  if (!response.ok) {
    const message = data?.error || raw || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return data;
}

async function refreshOverview() {
  if (!state.session?.agent_id) return false;
  try {
    const overview = await apiFetch(`/console/overview?agent_id=${encodeURIComponent(state.session.agent_id)}`);
    const spend = overview?.state?.spend_power || {};
    elements.availableValue.textContent = formatMoney(spend.effective_spend_power_cents || 0);

    const walletAddress = overview?.state?.observation?.wallet_address;
    elements.walletAddress.value = walletAddress || "Not available";
    elements.copyAddress.disabled = !walletAddress;

    state.lastUpdatedAt = overview?.updated_at || Math.floor(Date.now() / 1000);
    updateUpdatedLabel();

    renderRecord(overview?.activity || []);
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

function scheduleRefresh() {
  if (state.refreshTimer) window.clearInterval(state.refreshTimer);
  state.refreshTimer = window.setInterval(async () => {
    await refreshOverview();
  }, 7000);

  if (state.updatedTimer) window.clearInterval(state.updatedTimer);
  state.updatedTimer = window.setInterval(updateUpdatedLabel, 1000);
}

async function handleChatSubmit(event) {
  event.preventDefault();
  if (!state.connected || state.streaming) return;
  const text = elements.chatInput.value.trim();
  if (!text) return;

  state.messages.push({ role: "user", content: text });
  elements.chatInput.value = "";
  autoResize();
  renderMessages();
  setStreaming(true);

  state.abortController = new AbortController();

  try {
    const response = await apiFetch("/console/chat", {
      method: "POST",
      body: JSON.stringify({
        agent_id: state.session.agent_id,
        messages: state.messages
      }),
      signal: state.abortController.signal
    });

    if (response?.assistant) {
      state.messages.push({ role: "assistant", content: response.assistant });
    }
    state.pendingQuotes = (response?.pending_quotes || []).map((quote) => ({
      ...quote,
      summary: quote.summary || quote.reason || "Quote created"
    }));

    renderMessages();
    await refreshOverview();
  } catch (err) {
    if (err.name === "AbortError") {
      state.messages.push({ role: "assistant", content: "Stopped." });
    } else {
      state.messages.push({ role: "assistant", content: `Error: ${err.message}` });
    }
    renderMessages();
  } finally {
    setStreaming(false);
    state.abortController = null;
  }
}

async function handleApproval(quote) {
  if (!quote) return;
  setAdvancedError("");
  try {
    if (quote.requires_step_up) {
      const stepUp = await apiFetch("/console/step_up/request", {
        method: "POST",
        body: JSON.stringify({ agent_id: state.session.agent_id, quote_id: quote.quote_id })
      });
      state.stepUp = {
        challenge_id: stepUp.challenge_id,
        quote_id: quote.quote_id,
        idempotency_key: quote.idempotency_key,
        code: stepUp.code || ""
      };
      state.stepUpError = "";
      renderMessages();
      return;
    }
    await executeQuote(quote.quote_id, quote.idempotency_key);
  } catch (err) {
    state.stepUpError = err.message;
    renderMessages();
  }
}

async function executeQuote(quoteId, idempotencyKey, stepUpToken) {
  await apiFetch("/console/execute", {
    method: "POST",
    body: JSON.stringify({
      quote_id: quoteId,
      idempotency_key: idempotencyKey,
      step_up_token: stepUpToken
    })
  });
  state.pendingQuotes = state.pendingQuotes.filter((item) => item.quote_id !== quoteId);
  state.stepUp = null;
  state.stepUpError = "";
  renderMessages();
  await refreshOverview();
}

function cancelQuote(quoteId) {
  state.pendingQuotes = state.pendingQuotes.filter((item) => item.quote_id !== quoteId);
  renderMessages();
}

async function confirmStepUp(code) {
  if (!state.stepUp || !code) {
    state.stepUpError = "Enter the code.";
    renderMessages();
    return;
  }
  try {
    const result = await apiFetch("/console/step_up/confirm", {
      method: "POST",
      body: JSON.stringify({
        challenge_id: state.stepUp.challenge_id,
        code,
        decision: "approve"
      })
    });
    const token = result?.step_up_token;
    if (!token) throw new Error("No step-up token returned.");
    await executeQuote(state.stepUp.quote_id, state.stepUp.idempotency_key, token);
  } catch (err) {
    state.stepUpError = err.message;
    renderMessages();
  }
}

function cancelStepUp() {
  state.stepUp = null;
  state.stepUpError = "";
  renderMessages();
}

async function freezeAgent() {
  if (!state.session?.agent_id) return;
  try {
    await apiFetch("/console/freeze", {
      method: "POST",
      body: JSON.stringify({ agent_id: state.session.agent_id, reason: "console_lock" })
    });
    alert("Locked. Spending is stopped immediately.");
  } catch (err) {
    alert(err.message);
  }
}

async function connectDefault() {
  setError("");
  try {
    const response = await fetch("/console/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bootstrap_token: getBootstrapToken()
      })
    });
    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : {};
    if (!response.ok) {
      if (data?.error === "bootstrap_token_required") {
        elements.bootstrapTokenWrap.hidden = false;
        setError("Enter the bootstrap code to continue.");
        return;
      }
      setError(data?.error || raw || "Unable to connect.");
      return;
    }

    elements.bootstrapTokenWrap.hidden = true;
    elements.bootstrapTokenInput.value = "";
    if (elements.bootstrapTokenInputDetails) elements.bootstrapTokenInputDetails.value = "";
    saveSession({ session_id: data.session_id, agent_id: data.agent_id });
    await onConnected();
  } catch (err) {
    setError(err.message);
  }
}

async function importApiKey() {
  setAdvancedError("");
  try {
    const response = await fetch("/console/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: elements.apiKeyInput.value.trim(),
        agent_id: elements.agentIdInput.value.trim(),
        bootstrap_token: getBootstrapToken()
      })
    });
    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : {};
    if (!response.ok) {
      if (data?.error === "bootstrap_token_required") {
        elements.bootstrapTokenWrap.hidden = false;
        setAdvancedError("Enter the bootstrap code to continue.");
        return;
      }
      setAdvancedError(data?.error || raw || "Unable to import.");
      return;
    }

    saveSession({ session_id: data.session_id, agent_id: data.agent_id });
    await onConnected();
  } catch (err) {
    setAdvancedError(err.message);
  }
}

async function createNewBloom() {
  setAdvancedError("");
  const confirmText = elements.createConfirmInput.value.trim();
  if (confirmText !== "CREATE") {
    setAdvancedError("Type CREATE to confirm.");
    return;
  }
  try {
    const response = await fetch("/console/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        confirm_text: confirmText,
        bootstrap_token: getBootstrapToken()
      })
    });
    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : {};
    if (!response.ok) {
      if (data?.error === "bootstrap_token_required") {
        elements.bootstrapTokenWrap.hidden = false;
        setAdvancedError("Enter the bootstrap code to continue.");
        return;
      }
      setAdvancedError(data?.error || raw || "Unable to create.");
      return;
    }

    saveSession({ session_id: data.session_id, agent_id: data.agent_id });
    await onConnected();
  } catch (err) {
    setAdvancedError(err.message);
  }
}

async function onConnected() {
  setConnected(true);
  const ok = await refreshOverview();
  if (!ok) {
    disconnect();
    return;
  }
  scheduleRefresh();
  seedWelcome();
  renderMessages();
}

function disconnect() {
  saveSession(null);
  setConnected(false);
  state.messages = [];
  state.pendingQuotes = [];
  state.stepUp = null;
  state.stepUpError = "";
  renderMessages();
}

function hydrateFromSession() {
  const existing = loadSession();
  if (existing) {
    state.session = existing;
    onConnected();
  } else {
    setConnected(false);
    renderMessages();
  }
}

function seedWelcome() {
  if (state.messages.length) return;
  state.messages.push({
    role: "assistant",
    content: "Ask me about your balance or set aside money for upcoming bills."
  });
}

function copyWallet() {
  const value = elements.walletAddress.value;
  if (!value || value === "Not available") return;
  navigator.clipboard.writeText(value).then(() => {
    elements.copyAddress.textContent = "Copied";
    setTimeout(() => (elements.copyAddress.textContent = "Copy"), 1500);
  });
}

function toggleDetails(open) {
  const shouldOpen = typeof open === "boolean" ? open : !elements.detailsDrawer.classList.contains("details--open");
  elements.detailsDrawer.classList.toggle("details--open", shouldOpen);
  elements.detailsDrawer.setAttribute("aria-hidden", String(!shouldOpen));
  elements.detailsOverlay.hidden = !shouldOpen;
}

function autoResize() {
  elements.chatInput.style.height = "auto";
  elements.chatInput.style.height = `${Math.min(elements.chatInput.scrollHeight, 160)}px`;
}

function stopStreaming() {
  if (state.abortController) {
    state.abortController.abort();
  }
}

function bindSuggestions() {
  document.querySelectorAll(".suggestion").forEach((button) => {
    button.addEventListener("click", () => {
      const text = button.dataset.suggestion;
      if (!text) return;
      elements.chatInput.value = text;
      autoResize();
      if (state.connected) {
        elements.chatForm.requestSubmit();
      }
    });
  });
}

function init() {
  elements.connectButton.addEventListener("click", connectDefault);
  elements.chatForm.addEventListener("submit", handleChatSubmit);
  elements.stopButton.addEventListener("click", stopStreaming);
  elements.lockButton.addEventListener("click", freezeAgent);
  elements.copyAddress.addEventListener("click", copyWallet);
  elements.detailsToggle.addEventListener("click", () => toggleDetails(true));
  elements.detailsClose.addEventListener("click", () => toggleDetails(false));
  elements.detailsOverlay.addEventListener("click", () => toggleDetails(false));
  elements.importButton.addEventListener("click", importApiKey);
  elements.createButton.addEventListener("click", createNewBloom);
  elements.chatInput.addEventListener("input", autoResize);
  elements.chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      elements.chatForm.requestSubmit();
    }
  });

  bindSuggestions();
  hydrateFromSession();
  updateEmptyState();
  autoResize();
}

init();
