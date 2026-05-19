const DEFAULT_BACKEND_BASE = "http://127.0.0.1:8000";
const BACKEND_STORAGE_KEY = "agent_backend_base_url";
const TAB_STATES_KEY = "agent_tab_states_v2";
const SNAPSHOT_MAX_ELEMENTS = 500;
const MAX_CHAT_MESSAGES = 300;
const API_TIMEOUT_MS = 25000;

const CONFIRM_TOKENS = ["подтверждаю", "подтвердить", "confirm", "approve", "ok", "да"];
const CANCEL_TOKENS = ["отмена", "отменить", "cancel", "stop", "нет"];

const ui = {
  statusText: document.querySelector("#statusText"),
  backendUrlInput: document.querySelector("#backendUrlInput"),
  saveBackendBtn: document.querySelector("#saveBackendBtn"),
  tabInfo: document.querySelector("#tabInfo"),
  chatLog: document.querySelector("#chatLog"),
  chatForm: document.querySelector("#chatForm"),
  userInput: document.querySelector("#userInput"),
  sendBtn: document.querySelector("#sendBtn"),
  approvalBar: document.querySelector("#approvalBar"),
  approvalText: document.querySelector("#approvalText"),
  approveBtn: document.querySelector("#approveBtn"),
  cancelBtn: document.querySelector("#cancelBtn")
};

const state = {
  tabId: null,
  tabTitle: "",
  backendBase: DEFAULT_BACKEND_BASE,
  sessionId: null,
  history: [],
  awaitingConfirmation: false,
  pendingActionLabel: "",
  isBusy: false
};

function setStatus(text) {
  if (ui.statusText) {
    ui.statusText.textContent = text;
  }
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return DEFAULT_BACKEND_BASE;
  }
  return trimmed.replace(/\/+$/, "");
}

function setBusy(isBusy) {
  state.isBusy = isBusy;
  ui.sendBtn.disabled = isBusy;
  ui.userInput.disabled = isBusy;
  ui.approveBtn.disabled = isBusy || !state.awaitingConfirmation;
  ui.cancelBtn.disabled = isBusy || !state.awaitingConfirmation;
}

function addBubble(role, text) {
  const node = document.createElement("div");
  node.className = `bubble ${role}`;
  node.textContent = text;
  ui.chatLog.appendChild(node);
  ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
}

function renderHistory() {
  ui.chatLog.innerHTML = "";
  if (!state.history.length) {
    addBubble("system", "Чат готов. Напиши задачу для текущей страницы.");
    return;
  }

  for (const item of state.history) {
    addBubble(item.role, item.content);
  }
}

function pushHistory(role, content) {
  if (!["user", "assistant", "system"].includes(role)) {
    return;
  }

  const normalized = String(content || "").trim();
  if (!normalized) {
    return;
  }

  state.history.push({ role, content: normalized });
  if (state.history.length > MAX_CHAT_MESSAGES) {
    state.history = state.history.slice(-MAX_CHAT_MESSAGES);
  }
}

function containsToken(text, tokens) {
  const lowered = String(text || "").toLowerCase();
  return tokens.some((token) => lowered.includes(token));
}

function setApprovalUI() {
  if (!state.awaitingConfirmation) {
    ui.approvalBar.classList.remove("visible");
    ui.approveBtn.disabled = true;
    ui.cancelBtn.disabled = true;
    ui.approvalText.textContent = "Ожидает подтверждения действия";
    return;
  }

  ui.approvalBar.classList.add("visible");
  ui.approvalText.textContent = state.pendingActionLabel
    ? `Для продолжения нужно подтверждение: ${state.pendingActionLabel}.`
    : "Для продолжения нужно подтверждение действия.";
  ui.approveBtn.disabled = state.isBusy;
  ui.cancelBtn.disabled = state.isBusy;
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(result || {});
    });
  });
}

function storageSet(payload) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(payload, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve();
    });
  });
}

async function queryActiveTab() {
  const tabs = await new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(result || []);
    });
  });

  const tab = tabs[0];
  if (!tab || typeof tab.id !== "number") {
    throw new Error("Не удалось получить активную вкладку");
  }
  return tab;
}

function sendMessageToTab(tabId, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}

function executeScriptInTab(tabId, files) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve();
      }
    );
  });
}

async function ensureContentScript() {
  try {
    await sendMessageToTab(state.tabId, { type: "agent.ping" });
    return;
  } catch (_error) {
    await executeScriptInTab(state.tabId, ["content-script.js"]);
    await sendMessageToTab(state.tabId, { type: "agent.ping" });
  }
}

async function callTab(payload) {
  await ensureContentScript();
  const response = await sendMessageToTab(state.tabId, payload);
  if (!response || response.ok !== true) {
    throw new Error(response?.error || "Ошибка связи с контент-скриптом");
  }
  return response;
}

async function getSnapshot() {
  const response = await callTab({ type: "agent.snapshot", maxElements: SNAPSHOT_MAX_ELEMENTS });
  return response.snapshot;
}

async function runActionInTab(action) {
  const response = await callTab({ type: "agent.runAction", action });
  return String(response.observation || "");
}

function mapErrorToUserText(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (message.includes("request timeout") || message.includes("timeout")) {
    return "Сервер отвечает слишком долго. Попробуй еще раз.";
  }
  if (message.includes("failed to fetch") || message.includes("network")) {
    return "Не удалось связаться с сервером помощника. Проверь подключение и попробуй снова.";
  }
  if (message.includes("http 404") || message.includes("session not found")) {
    return "Сессия чата истекла. Закрой и снова открой расширение.";
  }
  if (message.includes("http 401") || message.includes("http 403")) {
    return "Нет доступа к серверу помощника. Проверь настройки.";
  }
  if (message.includes("http 5")) {
    return "Сервер помощника временно недоступен. Попробуй позже.";
  }
  return "Не получилось выполнить задачу. Попробуй переформулировать запрос.";
}

async function apiPost(path, payload) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timerId = controller
      ? setTimeout(() => {
          try {
            controller.abort();
          } catch (_error) {}
        }, API_TIMEOUT_MS)
      : null;

  try {
    const response = await fetch(`${state.backendBase}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`HTTP ${response.status}: ${details}`);
    }
    return response.json();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Request timeout");
    }
    throw error;
  } finally {
    if (timerId) {
      clearTimeout(timerId);
    }
  }
}

async function ensureChatSession() {
  if (state.sessionId) {
    return state.sessionId;
  }

  const data = await apiPost("/api/extension/chat/start", {
    site_id: `tab-${state.tabId}`
  });

  state.sessionId = String(data.session_id || "").trim();
  if (!state.sessionId) {
    throw new Error("Empty session id");
  }

  await persistTabState();
  return state.sessionId;
}

async function loadBackendBase() {
  const stored = await storageGet([BACKEND_STORAGE_KEY]);
  state.backendBase = normalizeBaseUrl(stored[BACKEND_STORAGE_KEY] || DEFAULT_BACKEND_BASE);
  ui.backendUrlInput.value = state.backendBase;
}

async function saveBackendBase() {
  state.backendBase = normalizeBaseUrl(ui.backendUrlInput.value || DEFAULT_BACKEND_BASE);
  ui.backendUrlInput.value = state.backendBase;
  await storageSet({ [BACKEND_STORAGE_KEY]: state.backendBase });
}

async function loadTabState() {
  const payload = await storageGet([TAB_STATES_KEY]);
  const allStates = payload[TAB_STATES_KEY] && typeof payload[TAB_STATES_KEY] === "object"
    ? payload[TAB_STATES_KEY]
    : {};

  const current = allStates[String(state.tabId)] || {};
  state.history = Array.isArray(current.history) ? current.history.slice(-MAX_CHAT_MESSAGES) : [];
  state.sessionId = typeof current.sessionId === "string" ? current.sessionId : null;
  state.awaitingConfirmation = Boolean(current.awaitingConfirmation);
  state.pendingActionLabel = typeof current.pendingActionLabel === "string" ? current.pendingActionLabel : "";
}

async function persistTabState() {
  const payload = await storageGet([TAB_STATES_KEY]);
  const allStates = payload[TAB_STATES_KEY] && typeof payload[TAB_STATES_KEY] === "object"
    ? payload[TAB_STATES_KEY]
    : {};

  allStates[String(state.tabId)] = {
    history: state.history,
    sessionId: state.sessionId,
    awaitingConfirmation: state.awaitingConfirmation,
    pendingActionLabel: state.pendingActionLabel
  };

  await storageSet({ [TAB_STATES_KEY]: allStates });
}

async function processTurn({ message = null, control = null, observations = [] } = {}) {
  await ensureChatSession();
  const snapshot = await getSnapshot();

  const response = await apiPost("/api/extension/chat/turn", {
    session_id: state.sessionId,
    message,
    control,
    observations,
    snapshot
  });

  state.awaitingConfirmation = Boolean(response.awaiting_confirmation);
  state.pendingActionLabel = String(response.pending_action_label || "");

  const assistantMessage = String(response.assistant_message || "").trim();
  if (assistantMessage) {
    pushHistory("assistant", assistantMessage);
    addBubble("assistant", assistantMessage);
  }

  setApprovalUI();
  await persistTabState();

  const actions = Array.isArray(response.actions) ? response.actions : [];
  if (!actions.length) {
    return;
  }

  const observationsResult = [];
  for (const action of actions) {
    const tool = String(action?.tool || "action");
    const observation = await runActionInTab(action);
    observationsResult.push(`${tool}: ${observation}`);
  }

  await processTurn({ observations: observationsResult });
}

async function submitUserMessage(message) {
  pushHistory("user", message);
  addBubble("user", message);
  await persistTabState();

  setBusy(true);
  setStatus("Выполняю...");
  try {
    if (state.awaitingConfirmation) {
      if (containsToken(message, CONFIRM_TOKENS)) {
        await processTurn({ control: "confirm_pending" });
      } else if (containsToken(message, CANCEL_TOKENS)) {
        await processTurn({ control: "cancel_pending" });
      } else {
        await processTurn({ message });
      }
    } else {
      await processTurn({ message });
    }
    setStatus("Готово");
  } catch (error) {
    const text = mapErrorToUserText(error);
    pushHistory("assistant", text);
    addBubble("assistant", text);
    setStatus("Ошибка");
    await persistTabState();
  } finally {
    setBusy(false);
    setApprovalUI();
  }
}

async function sendControl(control) {
  setBusy(true);
  setStatus("Выполняю...");
  try {
    await processTurn({ control });
    setStatus("Готово");
  } catch (error) {
    const text = mapErrorToUserText(error);
    pushHistory("assistant", text);
    addBubble("assistant", text);
    setStatus("Ошибка");
    await persistTabState();
  } finally {
    setBusy(false);
    setApprovalUI();
  }
}

async function bootstrap() {
  setBusy(true);
  setStatus("Инициализация...");

  try {
    await loadBackendBase();

    const tab = await queryActiveTab();
    state.tabId = tab.id;
    state.tabTitle = String(tab.title || "");
    ui.tabInfo.textContent = `Активная вкладка: ${state.tabTitle || "-"}`;

    await loadTabState();
    renderHistory();
    setApprovalUI();

    await ensureContentScript();
    await callTab({ type: "agent.ping" });

    if (!state.history.length) {
      const hello = "Здравствуйте! Я помогу найти информацию на странице и выполнить нужные действия.";
      pushHistory("assistant", hello);
      addBubble("assistant", hello);
      await persistTabState();
    }

    setStatus("Готово");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addBubble("system", `Не удалось подключиться к вкладке: ${message}`);
    setStatus("Нет доступа");
  } finally {
    setBusy(false);
    setApprovalUI();
  }
}

ui.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.isBusy) {
    return;
  }

  const message = String(ui.userInput.value || "").trim();
  if (!message) {
    return;
  }

  ui.userInput.value = "";
  await submitUserMessage(message);
});

ui.saveBackendBtn.addEventListener("click", async () => {
  try {
    await saveBackendBase();
    addBubble("system", "Адрес сервера сохранен.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addBubble("system", `Не удалось сохранить адрес сервера: ${message}`);
  }
});

ui.approveBtn.addEventListener("click", async () => {
  if (state.isBusy) {
    return;
  }
  await sendControl("confirm_pending");
});

ui.cancelBtn.addEventListener("click", async () => {
  if (state.isBusy) {
    return;
  }
  await sendControl("cancel_pending");
});

bootstrap();
