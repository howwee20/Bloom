const SESSION_KEY = "bloom_console_session_v1";

const state = {
  session: null,
  messages: [],
  pendingQuotes: [],
  stepUp: null,
  stepUpError: "",
  refreshTimer: null,
  refreshInFlight: false,
  isStreaming: false,
  streamAbort: null,
  lastActivity: [],
  highlightRecordId: null
};

const elements = {
  statusBadge: document.getElementById("statusBadge"),
  sessionPanel: document.getElementById("sessionPanel"),
  consoleMain: document.getElementById("consoleMain"),
  passwordInput: document.getElementById("passwordInput"),
  bootstrapTokenWrap: document.getElementById("bootstrapTokenWrap"),
  bootstrapTokenInput: document.getElementById("bootstrapTokenInput"),
  loginButton: document.getElementById("loginButton"),
  logoutButton: document.getElementById("logoutButton"),
  sessionError: document.getElementById("sessionError"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
  chatMessages: document.getElementById("chatMessages"),
  pendingQuotes: document.getElementById("pendingQuotes"),
  availableValue: document.getElementById("availableValue"),
  confirmedValue: document.getElementById("confirmedValue"),
  reservedValue: document.getElementById("reservedValue"),
  walletAddress: document.getElementById("walletAddress"),
  copyAddress: document.getElementById("copyAddress"),
  fundingHint: document.getElementById("fundingHint"),
  receiptsList: document.getElementById("receiptsList"),
  accountMeta: document.getElementById("accountMeta"),
  stopButton: document.getElementById("stopButton"),
  sendButton: document.getElementById("sendButton"),
  freezeButton: document.getElementById("freezeButton"),
  stepUpModal: document.getElementById("stepUpModal"),
  stepUpCode: document.getElementById("stepUpCode"),
  stepUpApprove: document.getElementById("stepUpApprove"),
  stepUpCancel: document.getElementById("stepUpCancel"),
  stepUpStatus: document.getElementById("stepUpStatus")
};

function setStatus(connected) {
  elements.statusBadge.textContent = connected ? "Connected" : "Disconnected";
  elements.statusBadge.classList.toggle("status--ok", connected);
}

function formatMoney(cents) {
  if (!Number.isFinite(cents)) return "—";
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function shortenAddress(address, prefix = 6, suffix = 4) {
  const trimmed = String(address ?? "").trim();
  if (!trimmed) return trimmed;
  if (trimmed.length <= prefix + suffix + 1) return trimmed;
  return `${trimmed.slice(0, prefix)}…${trimmed.slice(-suffix)}`;
}

function formatExpires(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp * 1000);
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function parseTransferCommand(text) {
  const pattern = /\b(send|transfer)\b\s+\$?\s*([0-9]+(?:\.[0-9]{1,2})?)\s*(?:usdc|usd|dollars)?\s+to\s+(0x[0-9a-fA-F]+)/i;
  const match = String(text ?? "").match(pattern);
  if (!match) return null;
  const amountCents = parseAmountToCents(match[2]);
  if (!amountCents || amountCents <= 0) return null;
  return {
    amountCents,
    toAddress: match[3]
  };
}

function parseAmountToCents(value) {
  const raw = String(value ?? "").trim().replace(/,/g, "");
  if (!raw) return null;
  const match = raw.match(/^(\d+)(\.(\d{1,2}))?$/);
  if (!match) return null;
  const dollars = Number(match[1]);
  const cents = match[3] ? Number(match[3].padEnd(2, "0")) : 0;
  if (!Number.isFinite(dollars) || !Number.isFinite(cents)) return null;
  return dollars * 100 + cents;
}

function isTransferQuote(quote) {
  return quote?.intent_type === "usdc_transfer" || quote?.action === "usdc_transfer";
}

function showError(message) {
  elements.sessionError.textContent = message;
}

function clearError() {
  elements.sessionError.textContent = "";
}

function setStreaming(active) {
  state.isStreaming = active;
  elements.stopButton.disabled = !active;
  elements.chatInput.disabled = active;
  elements.sendButton.disabled = active;
  if (!active) {
    state.streamAbort = null;
  }
}

function renderMessages() {
  elements.chatMessages.innerHTML = "";
  state.messages.forEach((msg) => {
    const div = document.createElement("div");
    div.className = `message message--${msg.role}${msg.streaming ? " message--streaming" : ""}`;
    div.textContent = msg.content;
    elements.chatMessages.appendChild(div);
  });
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function renderPendingQuotes() {
  elements.pendingQuotes.innerHTML = "";
  if (!state.session?.agent_id) return;
  if (!state.pendingQuotes.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No approvals waiting.";
    elements.pendingQuotes.appendChild(empty);
    return;
  }

  state.pendingQuotes.forEach((quote) => {
    const card = document.createElement("div");
    card.className = `pending-card${quote.allowed ? "" : " pending-card--declined"}`;

    const title = document.createElement("h4");
    const isTransfer = isTransferQuote(quote);
    if (isTransfer && Number.isFinite(quote.amount_cents)) {
      title.textContent = `Send ${formatMoney(quote.amount_cents)}`;
    } else {
      title.textContent = quote.allowed ? "Approval required" : "Declined";
    }

    const summary = document.createElement("p");
    if (isTransfer && quote.to_address) {
      summary.textContent = `to ${shortenAddress(quote.to_address)}`;
    } else {
      summary.textContent = quote.summary || quote.reason || "Quote created";
    }

    card.appendChild(title);
    card.appendChild(summary);

    if (quote.reason && !quote.allowed) {
      const reason = document.createElement("p");
      reason.className = "pending-meta";
      reason.textContent = `Reason: ${quote.reason}`;
      card.appendChild(reason);
    }

    if (quote.expires_at) {
      const expires = document.createElement("p");
      expires.className = "pending-meta";
      expires.textContent = `Expires ${formatExpires(quote.expires_at)}`;
      card.appendChild(expires);
    }

    if (quote.allowed) {
      const actionRow = document.createElement("div");
      actionRow.className = "pending-actions";

      const btn = document.createElement("button");
      btn.className = "btn btn--primary";
      btn.textContent = quote.requires_step_up ? "Approve (Step-Up)" : "Approve";
      btn.addEventListener("click", () => handleApproval(quote));
      actionRow.appendChild(btn);

      const cancelBtn = document.createElement("button");
      cancelBtn.className = "btn btn--ghost";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", () => cancelQuote(quote));
      actionRow.appendChild(cancelBtn);

      card.appendChild(actionRow);
    }

    elements.pendingQuotes.appendChild(card);
  });
}

function renderReceipts(activity) {
  elements.receiptsList.innerHTML = "";
  state.lastActivity = activity || [];
  if (!activity || activity.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No receipts yet.";
    elements.receiptsList.appendChild(empty);
    return;
  }

  activity.forEach((item) => {
    const row = document.createElement("div");
    row.className = "receipt__item";

    const headline = document.createElement("strong");
    headline.textContent = item.line;

    const meta = document.createElement("div");
    meta.className = "receipt__meta";
    meta.textContent = item.when;

    row.appendChild(headline);
    row.appendChild(meta);

    if (item.summary && item.summary.length) {
      const summary = document.createElement("div");
      summary.className = "receipt__meta";
      summary.textContent = item.summary.join(" · ");
      row.appendChild(summary);
    }

    elements.receiptsList.appendChild(row);
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
    const reserved = (spend.reserved_outgoing_cents || 0) + (spend.reserved_holds_cents || 0);

    elements.availableValue.textContent = formatMoney(spend.effective_spend_power_cents);
    elements.confirmedValue.textContent = formatMoney(spend.confirmed_balance_cents);
    elements.reservedValue.textContent = formatMoney(reserved);

    const walletAddress = overview?.state?.observation?.wallet_address;
    elements.walletAddress.value = walletAddress || "Not available";
    elements.copyAddress.disabled = !walletAddress;
    elements.fundingHint.textContent = walletAddress
      ? "Add funds by sending USDC to this address."
      : "This environment does not expose an address.";

    if (state.session?.agent_id) {
      const expires = state.session.expires_at
        ? ` · session expires ${formatExpires(state.session.expires_at)}`
        : "";
      elements.accountMeta.textContent = `agent_id=${state.session.agent_id}${expires}`;
    }

    renderReceipts(overview?.activity || []);
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
  renderMessages();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const applyToken = (token) => {
    const msg = state.messages[streamingIndex];
    if (!msg) return;
    msg.content += token;
    renderMessages();
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
    renderMessages();
    renderPendingQuotes();
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
  renderMessages();
  setStreaming(false);
}

async function handleChatSubmit(event) {
  event.preventDefault();
  const text = elements.chatInput.value.trim();
  if (!text || !state.session?.agent_id) return;
  if (state.isStreaming) return;

  const transferCommand = parseTransferCommand(text);
  state.messages.push({ role: "user", content: text });
  elements.chatInput.value = "";
  renderMessages();

  if (transferCommand) {
    await handleTransferQuote(transferCommand);
    return;
  }

  try {
    await streamChat(state.messages);
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
      renderMessages();
      return;
    }
    state.messages.push({ role: "assistant", content: `Error: ${err.message}` });
    renderMessages();
    setStreaming(false);
  }
}

async function handleTransferQuote(command) {
  setStreaming(true);
  try {
    const response = await consoleFetch("/console/actions/transfer/quote", {
      method: "POST",
      body: JSON.stringify({
        amount_cents: command.amountCents,
        to_address: command.toAddress
      })
    });

    const quote = {
      ...response,
      summary: response?.summary || response?.reason || "Quote created"
    };
    state.pendingQuotes = [...state.pendingQuotes, quote];

    const toLabel = shortenAddress(quote.to_address ?? command.toAddress);
    const assistantText = quote.allowed
      ? `Review and approve the transfer to ${toLabel}.`
      : response?.reason || "Transfer not approved by policy.";
    state.messages.push({ role: "assistant", content: assistantText });

    renderMessages();
    renderPendingQuotes();
    await refreshOverview();
  } catch (err) {
    state.messages.push({ role: "assistant", content: `Error: ${err.message}` });
    renderMessages();
  } finally {
    setStreaming(false);
  }
}

function finalizeTransferExecution(quote, result) {
  const amountLabel = formatMoney(quote?.amount_cents ?? 0);
  const toLabel = shortenAddress(quote?.to_address ?? "");
  const txHash = result?.tx_hash;
  const hashLabel = txHash ? shortenAddress(txHash, 10, 8) : "";
  const message = txHash
    ? `Sent ${amountLabel} to ${toLabel}. Tx ${hashLabel}.`
    : `Sent ${amountLabel} to ${toLabel}.`;

  state.messages.push({ role: "assistant", content: message });
}

async function handleApproval(quote) {
  if (!quote) return;
  try {
    if (isTransferQuote(quote)) {
      const result = await consoleFetch("/console/actions/transfer/approve", {
        method: "POST",
        body: JSON.stringify({ quote_id: quote.quote_id })
      });
      if (result?.status === "step_up_required") {
        state.stepUp = {
          flow: "transfer",
          step_up_id: result.step_up_id,
          quote_id: quote.quote_id,
          code: result.code || ""
        };
        openStepUpModal(result.code);
        return;
      }
      state.pendingQuotes = state.pendingQuotes.filter((item) => item.quote_id !== quote.quote_id);
      finalizeTransferExecution(quote, result);
      renderMessages();
      renderPendingQuotes();
      await refreshOverview();
      return;
    }
    if (quote.requires_step_up) {
      const stepUp = await consoleFetch("/console/step_up/request", {
        method: "POST",
        body: JSON.stringify({ agent_id: state.session.agent_id, quote_id: quote.quote_id })
      });
      state.stepUp = { ...stepUp, quote_id: quote.quote_id, idempotency_key: quote.idempotency_key };
      openStepUpModal(stepUp.code);
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
  renderPendingQuotes();
  refreshOverview();
}

async function cancelQuote(quote) {
  if (!quote) return;
  if (isTransferQuote(quote)) {
    try {
      await consoleFetch("/console/actions/transfer/cancel", {
        method: "POST",
        body: JSON.stringify({ quote_id: quote.quote_id })
      });
    } catch (err) {
      console.error(err);
    }
  }
  state.pendingQuotes = state.pendingQuotes.filter((item) => item.quote_id !== quote.quote_id);
  renderPendingQuotes();
}

function openStepUpModal(code) {
  if (!state.session?.agent_id) return;
  elements.stepUpCode.textContent = code || "—";
  elements.stepUpStatus.textContent = code ? "" : "No active step-up challenge.";
  elements.stepUpModal.hidden = false;
}

function closeStepUpModal() {
  elements.stepUpModal.hidden = true;
  elements.stepUpStatus.textContent = "";
  state.stepUp = null;
  state.stepUpError = "";
}

async function confirmStepUp() {
  if (!state.stepUp) return;
  elements.stepUpStatus.textContent = "Approving...";
  try {
    if (state.stepUp.flow === "transfer") {
      const result = await consoleFetch("/console/actions/step_up/confirm", {
        method: "POST",
        body: JSON.stringify({
          step_up_id: state.stepUp.step_up_id,
          code: state.stepUp.code
        })
      });
      const quote = state.pendingQuotes.find((item) => item.quote_id === state.stepUp.quote_id);
      if (quote) {
        state.pendingQuotes = state.pendingQuotes.filter((item) => item.quote_id !== quote.quote_id);
        finalizeTransferExecution(quote, result);
      }
      closeStepUpModal();
      renderMessages();
      renderPendingQuotes();
      await refreshOverview();
      return;
    }
    const result = await consoleFetch("/console/step_up/confirm", {
      method: "POST",
      body: JSON.stringify({
        challenge_id: state.stepUp.challenge_id,
        code: state.stepUp.code,
        decision: "approve"
      })
    });
    const token = result?.step_up_token;
    if (!token) throw new Error("No step-up token returned.");
    await executeQuote(state.stepUp.quote_id, state.stepUp.idempotency_key, token);
    closeStepUpModal();
  } catch (err) {
    elements.stepUpStatus.textContent = `Failed: ${err.message}`;
  }
}

async function freezeAgent() {
  if (!state.session?.agent_id) return;
  const confirmFreeze = window.confirm("Freeze this account? This stops new actions until unfrozen.");
  if (!confirmFreeze) return;
  try {
    await consoleFetch("/console/freeze", {
      method: "POST",
      body: JSON.stringify({ reason: "console_freeze" })
    });
    alert("Account frozen. You can unfreeze by updating policy on the backend.");
  } catch (err) {
    alert(err.message);
  }
}

async function login() {
  clearError();
  const password = elements.passwordInput.value.trim();
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
    setSession(session);
    onConnected();
  } catch (err) {
    if (err.code === "bootstrap_token_required") {
      elements.bootstrapTokenWrap.hidden = false;
      showError("Enter the bootstrap code to create a Bloom account.");
      return;
    }
    if (err.code === "console_password_required") {
      showError("Console password required or incorrect.");
      return;
    }
    showError(err.message);
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
  refreshOverview();
  scheduleRefresh();
  seedWelcome();
}

function disconnect() {
  setStatus(false);
  elements.consoleMain.hidden = true;
  elements.sessionPanel.hidden = false;
  state.session = null;
  state.messages = [];
  state.pendingQuotes = [];
  closeStepUpModal();
  renderMessages();
  renderPendingQuotes();
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
  const value = elements.walletAddress.value;
  if (!value || value === "Not available") return;
  navigator.clipboard.writeText(value).then(() => {
    elements.copyAddress.textContent = "Copied";
    setTimeout(() => (elements.copyAddress.textContent = "Copy"), 1500);
  });
}

function seedWelcome() {
  if (state.messages.length) return;
  state.messages.push({
    role: "assistant",
    content: "Ask me about your balance or propose a transfer. I'll ask for approval before anything moves."
  });
  renderMessages();
}

function init() {
  setStatus(false);
  elements.consoleMain.hidden = true;
  elements.sessionPanel.hidden = false;
  closeStepUpModal();
  elements.loginButton.addEventListener("click", login);
  elements.logoutButton.addEventListener("click", logout);
  elements.chatForm.addEventListener("submit", handleChatSubmit);
  elements.copyAddress.addEventListener("click", copyWallet);
  elements.stopButton.addEventListener("click", stopStreaming);
  elements.freezeButton.addEventListener("click", freezeAgent);
  elements.stepUpCancel.addEventListener("click", closeStepUpModal);
  elements.stepUpApprove.addEventListener("click", confirmStepUp);

  hydrateSession();
}

init();
