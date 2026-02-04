const state = {
  session: null,
  messages: [],
  pendingQuotes: [],
  stepUp: null,
  refreshTimer: null,
  refreshInFlight: false,
  isStreaming: false,
  streamAbort: null,
  lastUpdatedAt: null,
  consolePassword: ""
};

const elements = {
  statusBadge: document.getElementById("statusBadge"),
  detailsButton: document.getElementById("detailsButton"),
  detailsDrawer: document.getElementById("detailsDrawer"),
  closeDetails: document.getElementById("closeDetails"),
  drawerBackdrop: document.getElementById("drawerBackdrop"),
  sessionPanel: document.getElementById("sessionPanel"),
  consoleMain: document.getElementById("consoleMain"),
  passwordInput: document.getElementById("passwordInput"),
  bootstrapTokenWrap: document.getElementById("bootstrapTokenWrap"),
  bootstrapTokenInput: document.getElementById("bootstrapTokenInput"),
  loginButton: document.getElementById("loginButton"),
  importButton: document.getElementById("importButton"),
  createPanel: document.getElementById("createPanel"),
  createConfirmInputLogin: document.getElementById("createConfirmInputLogin"),
  createButtonLogin: document.getElementById("createButtonLogin"),
  sessionError: document.getElementById("sessionError"),
  sessionHint: document.getElementById("sessionHint"),
  availableValue: document.getElementById("availableValue"),
  availableUpdated: document.getElementById("availableUpdated"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
  chatMessages: document.getElementById("chatMessages"),
  chatSuggestions: document.getElementById("chatSuggestions"),
  stopButton: document.getElementById("stopButton"),
  sendButton: document.getElementById("sendButton"),
  walletAddress: document.getElementById("walletAddress"),
  copyAddress: document.getElementById("copyAddress"),
  fundingHint: document.getElementById("fundingHint"),
  recordList: document.getElementById("recordList"),
  lockButton: document.getElementById("lockButton"),
  createConfirmInput: document.getElementById("createConfirmInput"),
  createButton: document.getElementById("createButton"),
  createError: document.getElementById("createError")
};

function setStatus(connected) {
  elements.statusBadge.textContent = connected ? "Connected" : "Disconnected";
  elements.statusBadge.classList.toggle("status--ok", connected);
  elements.detailsButton.disabled = !connected;
}

function formatMoney(cents) {
  if (!Number.isFinite(cents)) return "—";
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function formatExpires(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp * 1000);
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function formatUpdated(seconds) {
  if (!seconds) return "Updated just now";
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - seconds);
  if (diff < 5) return "Updated just now";
  if (diff < 60) return `Updated ${diff}s ago`;
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `Updated ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `Updated ${hours}h ago`;
}

function showError(message) {
  elements.sessionError.textContent = message;
}

function clearError() {
  elements.sessionError.textContent = "";
}

function setStreaming(active) {
  state.isStreaming = active;
  elements.stopButton.hidden = !active;
  elements.stopButton.disabled = !active;
  elements.chatInput.disabled = active;
  elements.sendButton.disabled = active;
  if (!active) {
    state.streamAbort = null;
  }
}

function renderSuggestions() {
  const show =
    state.messages.length === 0 &&
    !state.isStreaming &&
    state.pendingQuotes.length === 0 &&
    !state.stepUp &&
    !!state.session?.agent_id;
  elements.chatSuggestions.hidden = !show;
}

function buildMessageRow(message) {
  const row = document.createElement("div");
  row.className = `message-row message-row--${message.role}`;
  const bubble = document.createElement("div");
  bubble.className = `message message--${message.role}${message.streaming ? " message--streaming" : ""}`;
  bubble.textContent = message.content;
  row.appendChild(bubble);
  return row;
}

function buildQuoteCard(quote) {
  const row = document.createElement("div");
  row.className = "message-row message-row--assistant";

  const card = document.createElement("div");
  card.className = `action-card${quote.allowed ? "" : " action-card--declined"}`;

  const title = document.createElement("h4");
  title.textContent = quote.allowed ? "Approval needed" : "Not approved";
  card.appendChild(title);

  const summary = document.createElement("p");
  summary.textContent = quote.summary || quote.reason || "Quote created";
  card.appendChild(summary);

  if (quote.reason && !quote.allowed) {
    const reason = document.createElement("p");
    reason.className = "action-card__meta";
    reason.textContent = `Reason: ${quote.reason}`;
    card.appendChild(reason);
  }

  if (quote.expires_at) {
    const expires = document.createElement("p");
    expires.className = "action-card__meta";
    expires.textContent = `Expires ${formatExpires(quote.expires_at)}`;
    card.appendChild(expires);
  }

  if (quote.allowed) {
    const actionRow = document.createElement("div");
    actionRow.className = "action-card__actions";

    const approve = document.createElement("button");
    approve.className = "btn btn--primary";
    approve.textContent = quote.requires_step_up ? "Approve (step-up)" : "Approve";
    approve.addEventListener("click", () => handleApproval(quote));

    const cancel = document.createElement("button");
    cancel.className = "btn btn--ghost";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => dismissQuote(quote.quote_id));

    actionRow.appendChild(approve);
    actionRow.appendChild(cancel);
    card.appendChild(actionRow);
  }

  row.appendChild(card);
  return row;
}

function buildStepUpCard(stepUp) {
  const row = document.createElement("div");
  row.className = "message-row message-row--assistant";

  const card = document.createElement("div");
  card.className = "action-card";

  const title = document.createElement("h4");
  title.textContent = "Enter code to approve";
  card.appendChild(title);

  if (stepUp.summary) {
    const summary = document.createElement("p");
    summary.textContent = stepUp.summary;
    card.appendChild(summary);
  }

  const inputRow = document.createElement("div");
  inputRow.className = "step-up-input";

  const input = document.createElement("input");
  input.placeholder = "Enter code";
  input.autocomplete = "off";
  if (stepUp.code) {
    input.value = stepUp.code;
  }

  const confirm = document.createElement("button");
  confirm.className = "btn btn--primary";
  confirm.textContent = "Confirm";
  confirm.addEventListener("click", () => confirmStepUp(input.value));

  const cancel = document.createElement("button");
  cancel.className = "btn btn--ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => cancelStepUp());

  inputRow.appendChild(input);
  inputRow.appendChild(confirm);
  inputRow.appendChild(cancel);
  card.appendChild(inputRow);

  if (stepUp.error) {
    const error = document.createElement("p");
    error.className = "error";
    error.textContent = stepUp.error;
    card.appendChild(error);
  }

  row.appendChild(card);
  return row;
}

function renderThread() {
  elements.chatMessages.innerHTML = "";
  state.messages.forEach((msg) => {
    elements.chatMessages.appendChild(buildMessageRow(msg));
  });

  if (state.session?.agent_id) {
    state.pendingQuotes.forEach((quote) => {
      elements.chatMessages.appendChild(buildQuoteCard(quote));
    });

    if (state.stepUp) {
      elements.chatMessages.appendChild(buildStepUpCard(state.stepUp));
    }
  }

  renderSuggestions();
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function renderRecord(activity) {
  elements.recordList.innerHTML = "";
  if (!activity || activity.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No record yet.";
    elements.recordList.appendChild(empty);
    return;
  }

  activity.forEach((item) => {
    const row = document.createElement("div");
    row.className = "record-item";

    const headline = document.createElement("strong");
    headline.textContent = item.line;

    const meta = document.createElement("div");
    meta.className = "record-meta";
    meta.textContent = item.when;

    row.appendChild(headline);
    row.appendChild(meta);

    if (item.summary && item.summary.length) {
      const summary = document.createElement("div");
      summary.className = "record-meta";
      summary.textContent = item.summary.join(" · ");
      row.appendChild(summary);
    }

    elements.recordList.appendChild(row);
  });
}

async function consoleFetch(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });

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
    const err = new Error(message);
    err.status = response.status;
    err.code = data?.error;
    throw err;
  }

  return data;
}

async function refreshOverview() {
  if (!state.session?.agent_id || state.refreshInFlight) return;
  state.refreshInFlight = true;
  try {
    const overview = await consoleFetch("/console/overview", { method: "GET" });
    const spend = overview?.state?.spend_power || {};

    elements.availableValue.textContent = formatMoney(spend.effective_spend_power_cents);
    state.lastUpdatedAt = overview?.updated_at ?? null;
    elements.availableUpdated.textContent = formatUpdated(state.lastUpdatedAt);

    const walletAddress = overview?.state?.observation?.wallet_address;
    elements.walletAddress.textContent = walletAddress || "Not available";
    elements.copyAddress.disabled = !walletAddress;
    elements.fundingHint.textContent = walletAddress
      ? "Send USDC to this address."
      : "This environment does not expose a wallet address.";

    renderRecord(overview?.activity || []);
  } catch (err) {
    if (err.status === 401) {
      disconnect();
    } else {
      console.error(err);
    }
  } finally {
    state.refreshInFlight = false;
  }
}

function scheduleRefresh() {
  if (state.refreshTimer) window.clearInterval(state.refreshTimer);
  state.refreshTimer = window.setInterval(refreshOverview, 2000);
}

function getChatHistory() {
  return state.messages.map((msg) => ({ role: msg.role, content: msg.content }));
}

async function streamChat(messages) {
  const controller = new AbortController();
  state.streamAbort = controller;
  setStreaming(true);

  const response = await fetch("/console/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream"
    },
    body: JSON.stringify({ messages, stream: true }),
    signal: controller.signal
  });

  if (!response.ok) {
    const raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    const message = data?.error || raw || `HTTP ${response.status}`;
    throw new Error(message);
  }

  if (!response.body) {
    throw new Error("Streaming not supported.");
  }

  const streamingIndex = state.messages.push({ role: "assistant", content: "", streaming: true }) - 1;
  renderThread();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const applyToken = (token) => {
    const msg = state.messages[streamingIndex];
    if (!msg) return;
    msg.content += token;
    renderThread();
  };

  const finalize = (text, pendingQuotes) => {
    const msg = state.messages[streamingIndex];
    if (msg) {
      msg.streaming = false;
      msg.content = text || msg.content;
    }
    state.pendingQuotes = (pendingQuotes || []).map((quote) => ({
      ...quote,
      summary: quote.summary || quote.reason || "Quote created"
    }));
    renderThread();
    refreshOverview();
  };

  const handleEventBlock = (block) => {
    const lines = block.split("\n");
    let eventName = "message";
    const dataLines = [];
    lines.forEach((line) => {
      if (line.startsWith("event:")) {
        eventName = line.replace("event:", "").trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.replace("data:", "").trim());
      }
    });
    const dataRaw = dataLines.join("\n");
    if (!dataRaw) return;
    let payload = null;
    try {
      payload = JSON.parse(dataRaw);
    } catch {
      payload = { text: dataRaw };
    }

    if (eventName === "token") {
      applyToken(payload.text || "");
    } else if (eventName === "done") {
      finalize(payload.assistant || "", payload.pending_quotes || []);
    } else if (eventName === "error") {
      throw new Error(payload.error || "console_chat_failed");
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    parts.forEach((part) => {
      if (part.trim()) {
        handleEventBlock(part);
      }
    });
  }

  const msg = state.messages[streamingIndex];
  if (msg) {
    msg.streaming = false;
  }
  renderThread();
  setStreaming(false);
}

async function handleChatSubmit(event) {
  event.preventDefault();
  const text = elements.chatInput.value.trim();
  if (!text || !state.session?.agent_id) return;
  if (state.isStreaming) return;

  state.messages.push({ role: "user", content: text });
  elements.chatInput.value = "";
  resizeTextarea();
  renderThread();

  try {
    await streamChat(getChatHistory());
  } catch (err) {
    const streamingIndex = state.messages.findIndex((msg) => msg.streaming);
    if (streamingIndex >= 0) {
      state.messages[streamingIndex].streaming = false;
      if (!state.messages[streamingIndex].content) {
        state.messages.splice(streamingIndex, 1);
      }
    }
    if (err.name === "AbortError") {
      setStreaming(false);
      renderThread();
      return;
    }
    state.messages.push({ role: "assistant", content: `Error: ${err.message}` });
    renderThread();
    setStreaming(false);
  }
}

function dismissQuote(quoteId) {
  state.pendingQuotes = state.pendingQuotes.filter((item) => item.quote_id !== quoteId);
  renderThread();
}

async function handleApproval(quote) {
  if (!quote) return;
  try {
    if (quote.requires_step_up) {
      const stepUp = await consoleFetch("/console/step_up/request", {
        method: "POST",
        body: JSON.stringify({ quote_id: quote.quote_id })
      });
      state.stepUp = {
        ...stepUp,
        quote_id: quote.quote_id,
        idempotency_key: quote.idempotency_key,
        summary: quote.summary || "Approval required",
        error: null
      };
      renderThread();
      return;
    }
    await executeQuote(quote.quote_id, quote.idempotency_key);
  } catch (err) {
    alert(err.message);
  }
}

async function executeQuote(quoteId, idempotencyKey, stepUpToken) {
  await consoleFetch("/console/execute", {
    method: "POST",
    body: JSON.stringify({
      quote_id: quoteId,
      idempotency_key: idempotencyKey,
      step_up_token: stepUpToken
    })
  });
  state.pendingQuotes = state.pendingQuotes.filter((item) => item.quote_id !== quoteId);
  state.stepUp = null;
  renderThread();
  refreshOverview();
}

async function confirmStepUp(code) {
  if (!state.stepUp) return;
  const trimmed = String(code || "").trim();
  if (!trimmed) {
    state.stepUp.error = "Enter the code to approve.";
    renderThread();
    return;
  }
  try {
    const result = await consoleFetch("/console/step_up/confirm", {
      method: "POST",
      body: JSON.stringify({
        challenge_id: state.stepUp.challenge_id,
        code: trimmed,
        decision: "approve"
      })
    });
    const token = result?.step_up_token;
    if (!token) throw new Error("No step-up token returned.");
    await executeQuote(state.stepUp.quote_id, state.stepUp.idempotency_key, token);
  } catch (err) {
    state.stepUp.error = `Failed: ${err.message}`;
    renderThread();
  }
}

async function cancelStepUp() {
  if (!state.stepUp) return;
  try {
    if (state.stepUp.code) {
      await consoleFetch("/console/step_up/confirm", {
        method: "POST",
        body: JSON.stringify({
          challenge_id: state.stepUp.challenge_id,
          code: state.stepUp.code,
          decision: "deny"
        })
      });
    }
  } catch (err) {
    console.error(err);
  } finally {
    state.stepUp = null;
    renderThread();
  }
}

async function lockAccount() {
  if (!state.session?.agent_id) return;
  const confirmLock = window.confirm("Lock this account? This stops new actions immediately.");
  if (!confirmLock) return;
  try {
    await consoleFetch("/console/freeze", {
      method: "POST",
      body: JSON.stringify({ reason: "console_lock" })
    });
    alert("Account locked. You can unlock it by updating policies on the backend.");
  } catch (err) {
    alert(err.message);
  }
}

async function login() {
  clearError();
  const password = elements.passwordInput.value.trim();
  state.consolePassword = password;
  const bootstrapToken = elements.bootstrapTokenInput.value.trim();
  try {
    const session = await consoleFetch("/console/login", {
      method: "POST",
      body: JSON.stringify({
        password: password || undefined,
        bootstrap_token: bootstrapToken || undefined
      })
    });

    elements.bootstrapTokenWrap.hidden = true;
    elements.bootstrapTokenInput.value = "";
    elements.passwordInput.value = "";
    elements.createPanel.hidden = true;
    setSession(session);
    onConnected();
  } catch (err) {
    if (err.code === "bootstrap_token_required") {
      elements.bootstrapTokenWrap.hidden = false;
      showError("Enter the bootstrap code to continue.");
      return;
    }
    if (err.code === "console_password_required") {
      showError("Console password required or incorrect.");
      return;
    }
    if (err.code === "no_agents_found") {
      showError("No existing Bloom found. Create a new Bloom to continue.");
      elements.createPanel.hidden = false;
      return;
    }
    showError(err.message);
  }
}

async function importExisting() {
  clearError();
  const password = elements.passwordInput.value.trim();
  state.consolePassword = password;
  try {
    const session = await consoleFetch("/console/import", {
      method: "POST",
      body: JSON.stringify({
        password: password || undefined
      })
    });
    elements.passwordInput.value = "";
    elements.createPanel.hidden = true;
    setSession(session);
    onConnected();
  } catch (err) {
    if (err.code === "console_password_required") {
      showError("Console password required or incorrect.");
      return;
    }
    if (err.code === "no_agents_found") {
      showError("No existing Bloom found in this kernel. Create a new Bloom to continue.");
      elements.createPanel.hidden = false;
      return;
    }
    showError(err.message);
  }
}

async function createNewBloom(confirmInput) {
  clearError();
  const confirmValue = String(confirmInput.value || "").trim();
  if (confirmValue !== "CREATE") {
    showError("Type CREATE to confirm.");
    return;
  }
  try {
    const session = await consoleFetch("/console/create", {
      method: "POST",
      body: JSON.stringify({
        password: state.consolePassword || undefined,
        bootstrap_token: elements.bootstrapTokenInput.value.trim() || undefined,
        confirm: confirmValue
      })
    });
    confirmInput.value = "";
    elements.bootstrapTokenInput.value = "";
    elements.createPanel.hidden = true;
    setSession(session);
    onConnected();
  } catch (err) {
    if (err.code === "bootstrap_token_required") {
      elements.bootstrapTokenWrap.hidden = false;
      showError("Enter the bootstrap code to continue.");
      return;
    }
    if (err.code === "console_password_required") {
      showError("Console password required or incorrect.");
      return;
    }
    showError(err.message);
  }
}

async function createNewBloomFromDrawer() {
  elements.createError.textContent = "";
  const confirmValue = String(elements.createConfirmInput.value || "").trim();
  if (confirmValue !== "CREATE") {
    elements.createError.textContent = "Type CREATE to confirm.";
    return;
  }
  try {
    const session = await consoleFetch("/console/create", {
      method: "POST",
      body: JSON.stringify({
        password: state.consolePassword || undefined,
        confirm: confirmValue
      })
    });
    elements.createConfirmInput.value = "";
    setSession(session);
    onConnected();
    closeDetails();
  } catch (err) {
    elements.createError.textContent = err.message;
  }
}

async function logout() {
  try {
    await consoleFetch("/console/logout", { method: "POST" });
  } catch (err) {
    console.error(err);
  }
  disconnect();
}

function setSession(session) {
  state.session = session;
}

function onConnected() {
  setStatus(true);
  elements.consoleMain.hidden = false;
  elements.sessionPanel.hidden = true;
  renderThread();
  refreshOverview();
  scheduleRefresh();
}

function disconnect() {
  setStatus(false);
  elements.consoleMain.hidden = true;
  elements.sessionPanel.hidden = false;
  state.session = null;
  state.messages = [];
  state.pendingQuotes = [];
  state.stepUp = null;
  elements.availableValue.textContent = "—";
  elements.availableUpdated.textContent = "Updated just now";
  renderThread();
  closeDetails();
}

async function hydrateSession() {
  try {
    const session = await consoleFetch("/console/session", { method: "GET" });
    if (session?.agent_id) {
      setSession(session);
      onConnected();
      return;
    }
  } catch (err) {
    setStatus(false);
  }
  disconnect();
}

function stopStreaming() {
  if (state.streamAbort) {
    state.streamAbort.abort();
  }
}

function copyWallet() {
  const value = elements.walletAddress.textContent;
  if (!value || value === "Not available" || value === "—") return;
  navigator.clipboard.writeText(value).then(() => {
    elements.copyAddress.textContent = "Copied";
    setTimeout(() => (elements.copyAddress.textContent = "Copy"), 1500);
  });
}

function resizeTextarea() {
  const input = elements.chatInput;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function handleSuggestionClick(event) {
  const target = event.target;
  if (!target || !target.dataset || !target.dataset.suggestion) return;
  elements.chatInput.value = target.dataset.suggestion;
  resizeTextarea();
  elements.chatInput.focus();
}

function openDetails() {
  elements.detailsDrawer.classList.add("drawer--open");
  elements.drawerBackdrop.classList.add("drawer-backdrop--open");
  elements.drawerBackdrop.hidden = false;
  elements.detailsDrawer.setAttribute("aria-hidden", "false");
}

function closeDetails() {
  elements.detailsDrawer.classList.remove("drawer--open");
  elements.drawerBackdrop.classList.remove("drawer-backdrop--open");
  elements.drawerBackdrop.hidden = true;
  elements.detailsDrawer.setAttribute("aria-hidden", "true");
}

function handleComposerKeydown(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.chatForm.requestSubmit();
  }
}

function init() {
  setStatus(false);
  elements.consoleMain.hidden = true;
  elements.sessionPanel.hidden = false;
  elements.stopButton.hidden = true;
  elements.detailsButton.disabled = true;
  renderThread();

  elements.loginButton.addEventListener("click", login);
  elements.importButton.addEventListener("click", importExisting);
  elements.createButtonLogin.addEventListener("click", () => createNewBloom(elements.createConfirmInputLogin));
  elements.chatForm.addEventListener("submit", handleChatSubmit);
  elements.chatInput.addEventListener("input", resizeTextarea);
  elements.chatInput.addEventListener("keydown", handleComposerKeydown);
  elements.chatSuggestions.addEventListener("click", handleSuggestionClick);
  elements.copyAddress.addEventListener("click", copyWallet);
  elements.stopButton.addEventListener("click", stopStreaming);
  elements.lockButton.addEventListener("click", lockAccount);
  elements.createButton.addEventListener("click", createNewBloomFromDrawer);
  elements.detailsButton.addEventListener("click", openDetails);
  elements.closeDetails.addEventListener("click", closeDetails);
  elements.drawerBackdrop.addEventListener("click", closeDetails);

  hydrateSession();
}

init();
