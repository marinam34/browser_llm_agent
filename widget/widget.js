(() => {
  if (window.__UNIVERSAL_AGENT_WIDGET_LOADED__) {
    return;
  }
  window.__UNIVERSAL_AGENT_WIDGET_LOADED__ = true;

  const SNAPSHOT_MAX_ELEMENTS = 500;
  const MAX_CHAT_MESSAGES = 300;
  const API_TIMEOUT_MS = 25000;

  const CONFIRM_TOKENS = ["подтверждаю", "подтвердить", "confirm", "approve", "ok", "да"];
  const CANCEL_TOKENS = ["отмена", "отменить", "cancel", "stop", "нет"];

  const SNAPSHOT_SELECTORS = [
    "a",
    "button",
    "input",
    "textarea",
    "select",
    "[role='button']",
    "[role='link']",
    "[role='textbox']",
    "[contenteditable='true']"
  ].join(",");

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function safeSlice(value, maxLen) {
    return normalizeText(value).slice(0, maxLen);
  }

  function cssEscapeValue(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function escapeAttrValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  }

  function querySelectorSafe(selector) {
    const normalized = String(selector || "").trim();
    if (!normalized) {
      return null;
    }
    try {
      return document.querySelector(normalized);
    } catch (_error) {
      return null;
    }
  }

  function querySelectorAllSafe(selector) {
    const normalized = String(selector || "").trim();
    if (!normalized) {
      return [];
    }
    try {
      return Array.from(document.querySelectorAll(normalized));
    } catch (_error) {
      return [];
    }
  }

  function selectorIsUnique(selector) {
    return querySelectorAllSafe(selector).length === 1;
  }

  function nthOfTypeIndex(el) {
    let index = 1;
    let prev = el.previousElementSibling;
    while (prev) {
      if (prev.tagName === el.tagName) {
        index += 1;
      }
      prev = prev.previousElementSibling;
    }
    return index;
  }

  function buildDomPathSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += `#${cssEscapeValue(node.id)}`;
        parts.unshift(part);
        break;
      }

      part += `:nth-of-type(${nthOfTypeIndex(node)})`;
      parts.unshift(part);

      if (node === document.body) {
        break;
      }
      node = node.parentElement;
    }

    return parts.join(" > ");
  }

  function buildSelector(el) {
    if (!el) {
      return "";
    }
    if (el.id) {
      const byId = `#${cssEscapeValue(el.id)}`;
      if (selectorIsUnique(byId)) {
        return byId;
      }
    }

    const testId = el.getAttribute("data-testid");
    if (testId) {
      const byTestId = `[data-testid="${escapeAttrValue(testId)}"]`;
      if (selectorIsUnique(byTestId)) {
        return byTestId;
      }
    }

    const name = el.getAttribute("name");
    if (name && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) {
      const byName = `${el.tagName.toLowerCase()}[name="${escapeAttrValue(name)}"]`;
      if (selectorIsUnique(byName)) {
        return byName;
      }
    }

    const classList = Array.from(el.classList || []).slice(0, 2).map((item) => cssEscapeValue(item));
    if (classList.length > 0) {
      const byClass = `${el.tagName.toLowerCase()}.${classList.join(".")}`;
      if (selectorIsUnique(byClass)) {
        return byClass;
      }
    }

    const domPath = buildDomPathSelector(el);
    if (domPath) {
      return domPath;
    }
    return el.tagName.toLowerCase();
  }

  function describeElement(el, selector) {
    return {
      selector: selector || buildSelector(el),
      tag: (el.tagName || "").toLowerCase(),
      type: el.getAttribute("type") || "",
      text: safeSlice(el.innerText || el.value || el.textContent || "", 180),
      placeholder: safeSlice(el.getAttribute("placeholder") || "", 120),
      ariaLabel: safeSlice(el.getAttribute("aria-label") || "", 120),
      name: safeSlice(el.getAttribute("name") || "", 80),
      id: safeSlice(el.id || "", 80),
      label: getAssociatedLabelText(el)
    };
  }

  function collectSnapshot(maxElements = SNAPSHOT_MAX_ELEMENTS) {
    const candidates = Array.from(document.querySelectorAll(SNAPSHOT_SELECTORS));
    return {
      url: window.location.href,
      title: document.title,
      elements: candidates.slice(0, maxElements).map((el) => describeElement(el, buildSelector(el)))
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isVisible(el) {
    if (!el) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    const style = window.getComputedStyle(el);
    if (!style) {
      return true;
    }
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function getAssociatedLabelText(el) {
    if (!el) {
      return "";
    }

    const chunks = [];
    const closestLabel = el.closest("label");
    if (closestLabel) {
      chunks.push(closestLabel.innerText || closestLabel.textContent || "");
    }

    if (el.id) {
      for (const label of querySelectorAllSafe(`label[for="${escapeAttrValue(el.id)}"]`)) {
        chunks.push(label.innerText || label.textContent || "");
      }
    }

    const labels = el.labels;
    if (labels && typeof labels.length === "number") {
      for (const label of Array.from(labels)) {
        chunks.push(label.innerText || label.textContent || "");
      }
    }

    return safeSlice(chunks.join(" "), 140);
  }

  function inputMetaText(el) {
    const text = normalizeText(el.innerText || el.textContent || el.value || "");
    const placeholder = normalizeText(el.getAttribute("placeholder") || "");
    const aria = normalizeText(el.getAttribute("aria-label") || "");
    const name = normalizeText(el.getAttribute("name") || "");
    const id = normalizeText(el.id || "");
    const label = normalizeText(getAssociatedLabelText(el));
    return normalizeText([text, placeholder, aria, name, id, label].join(" "));
  }

  function findInputByHint(hint) {
    const normalizedHint = normalizeText(hint).toLowerCase();
    if (!normalizedHint || normalizedHint.length < 2) {
      return null;
    }

    const selector = [
      "input",
      "textarea",
      "select",
      "[role='textbox']",
      "[contenteditable='true']"
    ].join(",");
    const candidates = querySelectorAllSafe(selector);

    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      if (!isVisible(el)) {
        continue;
      }
      const meta = inputMetaText(el).toLowerCase();
      if (!meta) {
        continue;
      }

      let score = 0;
      if (meta === normalizedHint) {
        score = 1000;
      } else if (meta.includes(normalizedHint)) {
        score = 700;
      } else if (normalizedHint.includes(meta) && meta.length > 3) {
        score = 350;
      } else {
        const tokens = normalizedHint.split(/\s+/).filter(Boolean);
        score = tokens.reduce((acc, token) => (meta.includes(token) ? acc + 60 : acc), 0);
      }

      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }

    if (bestScore < 120) {
      return null;
    }
    return best;
  }

  async function resolveInputElement(args) {
    const selector = String(args.selector || "").trim();
    const timeoutMs = Number(args.timeout_ms || 10000);

    const bySelector = await waitForElement(selector, timeoutMs);
    if (bySelector) {
      return bySelector;
    }

    const hints = [
      args.field_hint,
      args.text_hint,
      args.placeholder_hint,
      args.aria_label_hint,
      args.name_hint,
      args.label_hint,
      args.selector
    ];
    for (const hint of hints) {
      const byHint = findInputByHint(hint);
      if (byHint) {
        return byHint;
      }
    }

    return null;
  }

  async function waitForElement(selector, timeoutMs) {
    const normalizedSelector = String(selector || "").trim();
    if (!normalizedSelector) {
      return null;
    }

    const timeout = Number.isFinite(Number(timeoutMs)) ? Math.max(200, Number(timeoutMs)) : 10000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      const el = querySelectorSafe(normalizedSelector);
      if (el) {
        return el;
      }
      await sleep(120);
    }
    return null;
  }

  function setInputValue(el, nextValue) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, nextValue);
      } else {
        el.value = nextValue;
      }
    } catch (_error) {
      el.value = nextValue;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function dispatchKeyEvents(el, key) {
    const isEnter = key === "Enter";
    const eventInit = {
      key,
      code: isEnter ? "Enter" : key,
      keyCode: isEnter ? 13 : 0,
      which: isEnter ? 13 : 0,
      charCode: isEnter ? 13 : 0,
      bubbles: true,
      cancelable: true,
      composed: true
    };
    el.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    el.dispatchEvent(new KeyboardEvent("keypress", eventInit));
    el.dispatchEvent(new KeyboardEvent("keyup", eventInit));
  }

  function isSearchLikeInput(el, args) {
    const candidates = [
      String(args?.field_hint || ""),
      String(args?.placeholder_hint || ""),
      String(args?.aria_label_hint || ""),
      String(args?.name_hint || ""),
      String(args?.label_hint || ""),
      String(args?.selector || ""),
      String(el?.getAttribute?.("placeholder") || ""),
      String(el?.getAttribute?.("aria-label") || ""),
      String(el?.getAttribute?.("name") || ""),
      String(el?.id || ""),
      String(el?.className || ""),
      String(el?.closest?.("label")?.innerText || "")
    ];

    const exactNameQ = String(args?.name_hint || "").trim().toLowerCase() === "q"
      || String(el?.getAttribute?.("name") || "").trim().toLowerCase() === "q";
    if (exactNameQ) {
      return true;
    }

    const haystack = normalizeText(candidates.join(" ")).toLowerCase();
    if (!haystack) {
      return false;
    }
    const tokens = ["search", "поиск", "найти", "искать", "query"];
    return tokens.some((token) => haystack.includes(token));
  }

  function findSearchSubmitButton(root) {
    const searchButtonSelector = [
      "button[type='submit']",
      "input[type='submit']",
      "button[aria-label*='search' i]",
      "button[aria-label*='поиск' i]",
      "[role='button'][aria-label*='search' i]",
      "[role='button'][aria-label*='поиск' i]",
      "button[name*='search' i]",
      "button[id*='search' i]",
      "button[class*='search' i]",
      "[data-testid*='search' i]"
    ].join(",");
    const scope = root && typeof root.querySelectorAll === "function" ? root : document;
    for (const btn of querySelectorAllSafe(searchButtonSelector)) {
      if (!scope.contains(btn)) {
        continue;
      }
      if (!isVisible(btn)) {
        continue;
      }
      return btn;
    }
    return null;
  }

  function triggerSearchSubmit(el) {
    const form = el?.form || el?.closest?.("form") || null;
    if (form) {
      const submitBtn = findSearchSubmitButton(form);
      if (submitBtn) {
        try {
          submitBtn.click();
          return "search submitted via submit button";
        } catch (_error) {}
      }

      try {
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
          return "search submitted via form.requestSubmit()";
        }
      } catch (_error) {}

      try {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        return "search submitted via submit event";
      } catch (_error) {}
    }

    const searchRegion = el?.closest?.("[role='search'], header, [class*='search' i], [id*='search' i]") || document;
    const fallbackBtn = findSearchSubmitButton(searchRegion);
    if (fallbackBtn) {
      try {
        fallbackBtn.click();
        return "search submitted via nearby button";
      } catch (_error) {}
    }

    return "search submit fallback unavailable";
  }

  async function clickUsingHint(hint, timeoutMs) {
    const normalizedHint = normalizeText(hint).toLowerCase();
    if (!normalizedHint || normalizedHint.length < 2) {
      return false;
    }

    const selector = [
      "button",
      "a",
      "[role='button']",
      "[role='link']",
      "input[type='button']",
      "input[type='submit']"
    ].join(",");

    const candidates = Array.from(document.querySelectorAll(selector));
    for (const el of candidates) {
      const text = normalizeText(el.innerText || el.textContent || el.value || "").toLowerCase();
      const aria = normalizeText(el.getAttribute("aria-label") || "").toLowerCase();
      if (!text.includes(normalizedHint) && !aria.includes(normalizedHint)) {
        continue;
      }
      if (!isVisible(el)) {
        continue;
      }
      try {
        el.scrollIntoView({ block: "center", inline: "nearest" });
      } catch (_error) {}
      await sleep(50);
      el.click();
      return true;
    }

    await sleep(Math.min(240, Number(timeoutMs) || 240));
    return false;
  }

  async function runAction(action) {
    const tool = String(action?.tool || "").trim();
    const args = action?.args && typeof action.args === "object" ? action.args : {};

    try {
      if (tool === "navigate") {
        const url = String(args.url || "").trim();
        if (!url) {
          return "navigate: missing url";
        }
        window.location.href = url;
        return `navigated to ${url}`;
      }

      if (tool === "click") {
        const selector = String(args.selector || "").trim();
        if (!selector) {
          return "click: missing selector";
        }

        const timeoutMs = Number(args.timeout_ms || 10000);
        const textHint = String(args.text_hint || "").trim();
        const ariaHint = String(args.aria_label_hint || "").trim();

        if (textHint) {
          const clickedByText = await clickUsingHint(textHint, timeoutMs);
          if (clickedByText) {
            return "clicked by text hint";
          }
        }
        if (ariaHint) {
          const clickedByAria = await clickUsingHint(ariaHint, timeoutMs);
          if (clickedByAria) {
            return "clicked by aria hint";
          }
        }

        const el = await waitForElement(selector, timeoutMs);
        if (!el) {
          return `click: element not found (${selector})`;
        }

        try {
          el.scrollIntoView({ block: "center", inline: "nearest" });
        } catch (_error) {}
        await sleep(50);

        try {
          el.click();
          return `clicked ${selector}`;
        } catch (_error) {
          return "click: error";
        }
      }

      if (tool === "type") {
        const selector = String(args.selector || "").trim();
        const text = String(args.text || "");
        const clear = Boolean(args.clear ?? true);
        const hasHint = [
          args.field_hint,
          args.text_hint,
          args.placeholder_hint,
          args.aria_label_hint,
          args.name_hint,
          args.label_hint
        ].some((item) => normalizeText(item).length > 0);

        if (!selector && !hasHint) {
          return "type: missing selector or hint";
        }

        const el = await resolveInputElement(args);
        if (!el) {
          return `type: element not found (${selector || "hint"})`;
        }

        try {
          el.scrollIntoView({ block: "center", inline: "nearest" });
          el.focus();
        } catch (_error) {}

        const currentValue = "value" in el ? String(el.value || "") : "";
        const nextValue = clear ? text : `${currentValue}${text}`;
        setInputValue(el, nextValue);

        if (Boolean(args.press_enter)) {
          dispatchKeyEvents(el, "Enter");
          if (Boolean(args.search_submit) || isSearchLikeInput(el, args)) {
            const submitObservation = triggerSearchSubmit(el);
            const resolvedSelector = buildSelector(el);
            return `typed into ${resolvedSelector || selector}; ${submitObservation}`;
          }
        }

        const resolvedSelector = buildSelector(el);
        return `typed into ${resolvedSelector || selector}`;
      }

      if (tool === "press") {
        const selector = String(args.selector || "").trim();
        const key = String(args.key || "Enter").trim() || "Enter";
        if (!selector) {
          return "press: missing selector";
        }

        const el = await waitForElement(selector, Number(args.timeout_ms || 10000));
        if (!el) {
          return `press: element not found (${selector})`;
        }

        try {
          el.focus();
        } catch (_error) {}
        dispatchKeyEvents(el, key);
        return `pressed ${key} on ${selector}`;
      }

      if (tool === "wait_for") {
        const selector = String(args.selector || "").trim();
        if (!selector) {
          return "wait_for: missing selector";
        }

        const el = await waitForElement(selector, Number(args.timeout_ms || 10000));
        if (!el || !isVisible(el)) {
          return `wait_for: timeout (${selector})`;
        }
        return `selector visible: ${selector}`;
      }

      if (tool === "extract_text") {
        const selector = String(args.selector || "body").trim() || "body";
        const maxChars = Number(args.max_chars || 1500);
        const el = document.querySelector(selector);
        if (!el) {
          return `extract_text: element not found (${selector})`;
        }

        let text = normalizeText(el.innerText || el.textContent || "");
        if (Number.isFinite(maxChars) && maxChars > 0 && text.length > maxChars) {
          text = `${text.slice(0, maxChars)}...`;
        }

        return `extract_text ${selector}: ${text}`;
      }

      if (tool === "done" || tool === "ask_user") {
        return "no browser action needed";
      }

      return `unsupported tool: ${tool || "unknown"}`;
    } catch (_error) {
      return `${tool || "action"}: error`;
    }
  }

  function containsToken(text, tokens) {
    const lowered = String(text || "").toLowerCase();
    return tokens.some((token) => lowered.includes(token));
  }

  function normalizeBaseUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function safeOrigin(url, fallbackOrigin) {
    try {
      return new URL(url).origin;
    } catch (_error) {
      return fallbackOrigin;
    }
  }

  function mapErrorToUserText(error) {
    const message = String(error?.message || error || "").toLowerCase();
    if (message.includes("request timeout") || message.includes("timeout")) {
      return "Сервер отвечает слишком долго. Попробуйте еще раз.";
    }
    if (message.includes("failed to fetch") || message.includes("network")) {
      return "Не удалось связаться с сервером помощника. Проверьте подключение и попробуйте снова.";
    }
    if (message.includes("http 401") || message.includes("http 403")) {
      return "Доступ к серверу помощника запрещен. Проверьте настройки доступа.";
    }
    if (message.includes("http 404") || message.includes("session not found")) {
      return "Сессия чата истекла. Перезапустите чат.";
    }
    if (message.includes("http 5")) {
      return "Сервер помощника временно недоступен. Попробуйте чуть позже.";
    }
    return "Не получилось выполнить задачу. Попробуйте переформулировать запрос.";
  }

  function resolveConfig() {
    const globalConfig = window.UniversalAgentConfig && typeof window.UniversalAgentConfig === "object"
      ? window.UniversalAgentConfig
      : {};

    const scriptEl = document.currentScript;
    const dataset = scriptEl?.dataset || {};

    let defaultBackend = window.location.origin;
    try {
      if (scriptEl?.src) {
        defaultBackend = new URL(scriptEl.src, window.location.href).origin;
      }
    } catch (_error) {
      defaultBackend = window.location.origin;
    }

    return {
      backendBase: normalizeBaseUrl(globalConfig.backendUrl || dataset.backendUrl || defaultBackend),
      siteId: String(globalConfig.siteId || dataset.siteId || "default-site"),
      buttonLabel: String(globalConfig.buttonLabel || dataset.buttonLabel || "Помощник"),
      title: String(globalConfig.title || dataset.title || "Онлайн-помощник")
    };
  }

  const config = resolveConfig();
  const iframeUrl = `${config.backendBase}/embed/chat?parentOrigin=${encodeURIComponent(window.location.origin)}`;
  const iframeOrigin = safeOrigin(iframeUrl, "*");

  const state = {
    sessionId: null,
    busy: false,
    isOpen: false,
    messages: [],
    awaitingConfirmation: false,
    pendingActionLabel: ""
  };

  function pushMessage(role, text) {
    const content = normalizeText(text);
    if (!content) {
      return;
    }
    state.messages.push({ role, text: content });
    if (state.messages.length > MAX_CHAT_MESSAGES) {
      state.messages = state.messages.slice(-MAX_CHAT_MESSAGES);
    }
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
      const response = await fetch(`${config.backendBase}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-Site": config.siteId
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

  async function ensureSession() {
    if (state.sessionId) {
      return state.sessionId;
    }
    const data = await apiPost("/api/extension/chat/start", { site_id: config.siteId });
    state.sessionId = String(data.session_id || "").trim();
    if (!state.sessionId) {
      throw new Error("Empty session id");
    }
    return state.sessionId;
  }

  let ui = null;

  function syncStateToIframe() {
    if (!ui || !ui.iframe || !ui.iframe.contentWindow) {
      return;
    }

    ui.iframe.contentWindow.postMessage(
      {
        type: "ua_widget_state",
        payload: {
          title: config.title,
          messages: state.messages,
          busy: state.busy,
          awaiting_confirmation: state.awaitingConfirmation,
          pending_action_label: state.pendingActionLabel
        }
      },
      iframeOrigin
    );
  }

  function setBusy(isBusy) {
    state.busy = Boolean(isBusy);
    syncStateToIframe();
  }

  async function processTurn({ message = null, control = null, observations = [] } = {}) {
    try {
      await ensureSession();
      const response = await apiPost("/api/extension/chat/turn", {
        session_id: state.sessionId,
        message,
        control,
        observations,
        snapshot: collectSnapshot(SNAPSHOT_MAX_ELEMENTS)
      });

      state.awaitingConfirmation = Boolean(response.awaiting_confirmation);
      state.pendingActionLabel = String(response.pending_action_label || "");

      const assistantMessage = normalizeText(response.assistant_message || "");
      if (assistantMessage) {
        pushMessage("assistant", assistantMessage);
      }
      syncStateToIframe();

      const actions = Array.isArray(response.actions) ? response.actions : [];
      if (!actions.length) {
        return;
      }

      const observationsResult = [];
      for (const action of actions) {
        const tool = String(action?.tool || "action");
        const observation = await runAction(action);
        observationsResult.push(`${tool}: ${observation}`);
      }

      await processTurn({ observations: observationsResult });
    } catch (error) {
      pushMessage("assistant", mapErrorToUserText(error));
      syncStateToIframe();
    }
  }

  function createRootElements() {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = config.buttonLabel;
    button.setAttribute("aria-label", config.buttonLabel);
    Object.assign(button.style, {
      position: "fixed",
      right: "20px",
      bottom: "20px",
      zIndex: "2147483646",
      border: "none",
      borderRadius: "999px",
      padding: "12px 18px",
      fontSize: "14px",
      fontWeight: "600",
      fontFamily: "Segoe UI, Tahoma, sans-serif",
      color: "#ffffff",
      background: "linear-gradient(120deg, #0f766e 0%, #0ea5a4 100%)",
      boxShadow: "0 10px 28px rgba(15,118,110,0.34)",
      cursor: "pointer"
    });

    const panel = document.createElement("div");
    Object.assign(panel.style, {
      position: "fixed",
      right: "20px",
      bottom: "80px",
      width: "min(420px, calc(100vw - 28px))",
      height: "min(670px, calc(100vh - 110px))",
      background: "#ffffff",
      borderRadius: "16px",
      overflow: "hidden",
      boxShadow: "0 20px 44px rgba(15,23,42,0.28)",
      zIndex: "2147483646",
      display: "none",
      border: "1px solid rgba(148,163,184,0.35)"
    });

    const iframe = document.createElement("iframe");
    iframe.src = iframeUrl;
    iframe.title = config.title;
    iframe.setAttribute("loading", "eager");
    iframe.setAttribute("referrerpolicy", "no-referrer-when-downgrade");
    Object.assign(iframe.style, {
      width: "100%",
      height: "100%",
      border: "0"
    });

    panel.appendChild(iframe);
    document.body.appendChild(panel);
    document.body.appendChild(button);

    return { button, panel, iframe };
  }

  function toggleOpen(forceOpen) {
    if (!ui) {
      return;
    }
    const nextOpen = typeof forceOpen === "boolean" ? forceOpen : !state.isOpen;
    state.isOpen = nextOpen;
    ui.panel.style.display = nextOpen ? "block" : "none";
    ui.button.textContent = nextOpen ? "Скрыть чат" : config.buttonLabel;
    if (nextOpen) {
      syncStateToIframe();
    }
  }

  async function onUserMessage(text) {
    const message = normalizeText(text);
    if (!message) {
      return;
    }

    if (state.busy) {
      return;
    }

    pushMessage("user", message);
    syncStateToIframe();

    setBusy(true);
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
    } finally {
      setBusy(false);
    }
  }

  async function onControl(control) {
    if (state.busy) {
      return;
    }
    setBusy(true);
    try {
      await processTurn({ control });
    } finally {
      setBusy(false);
    }
  }

  function handleIframeMessage(event) {
    if (!ui || !ui.iframe || !ui.iframe.contentWindow) {
      return;
    }
    if (event.source !== ui.iframe.contentWindow) {
      return;
    }
    if (iframeOrigin !== "*" && event.origin !== iframeOrigin) {
      return;
    }

    const data = event.data && typeof event.data === "object" ? event.data : {};
    const type = String(data.type || "");

    if (type === "ua_widget_ready") {
      if (!state.messages.length) {
        pushMessage("assistant", "Здравствуйте! Я помогу найти информацию на странице и выполнить действия по вашему запросу.");
      }
      syncStateToIframe();
      return;
    }

    if (type === "ua_widget_user_message") {
      void onUserMessage(String(data.message || ""));
      return;
    }

    if (type === "ua_widget_confirm_pending") {
      void onControl("confirm_pending");
      return;
    }

    if (type === "ua_widget_cancel_pending") {
      void onControl("cancel_pending");
      return;
    }

    if (type === "ua_widget_close") {
      toggleOpen(false);
    }
  }

  function bootstrap() {
    if (ui || !document.body) {
      return;
    }

    ui = createRootElements();
    window.addEventListener("message", handleIframeMessage);
    ui.button.addEventListener("click", () => {
      toggleOpen();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
