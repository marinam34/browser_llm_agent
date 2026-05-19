(() => {
  if (window.__UNIVERSAL_LLM_AGENT_CONTENT_SCRIPT__) {
    return;
  }
  window.__UNIVERSAL_LLM_AGENT_CONTENT_SCRIPT__ = true;

  const DEFAULT_MAX_ELEMENTS = 500;
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

  function isVisible(el) {
    if (!el) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return false;
    }
    const style = window.getComputedStyle(el);
    if (!style) {
      return true;
    }
    return style.visibility !== "hidden" && style.display !== "none";
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

  function collectSnapshot(maxElements = DEFAULT_MAX_ELEMENTS) {
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
    const keyboardEventInit = {
      key,
      code: isEnter ? "Enter" : key,
      keyCode: isEnter ? 13 : 0,
      which: isEnter ? 13 : 0,
      charCode: isEnter ? 13 : 0,
      bubbles: true,
      cancelable: true,
      composed: true
    };
    el.dispatchEvent(new KeyboardEvent("keydown", keyboardEventInit));
    el.dispatchEvent(new KeyboardEvent("keypress", keyboardEventInit));
    el.dispatchEvent(new KeyboardEvent("keyup", keyboardEventInit));
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
    for (const btn of querySelectorAllSafe.call(null, searchButtonSelector)) {
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
      return null;
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
      await sleep(40);
      el.click();
      return `clicked by text '${normalizeText(hint)}'`;
    }

    await sleep(Math.min(200, Number(timeoutMs) || 200));
    return null;
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
            return clickedByText;
          }
        }
        if (ariaHint) {
          const clickedByAria = await clickUsingHint(ariaHint, timeoutMs);
          if (clickedByAria) {
            return clickedByAria;
          }
        }

        const el = await waitForElement(selector, timeoutMs);
        if (!el) {
          return `click: element not found (${selector})`;
        }

        try {
          el.scrollIntoView({ block: "center", inline: "nearest" });
        } catch (_error) {}
        await sleep(40);

        try {
          el.click();
          return `clicked ${selector}`;
        } catch (error) {
          if (textHint) {
            const textFallback = await clickUsingHint(textHint, timeoutMs);
            if (textFallback) {
              return textFallback;
            }
          }
          if (ariaHint) {
            const ariaFallback = await clickUsingHint(ariaHint, timeoutMs);
            if (ariaFallback) {
              return ariaFallback;
            }
          }

          return `click: error: ${error instanceof Error ? error.message : String(error)}`;
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
    } catch (error) {
      return `${tool || "action"}: error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function handleMessage(message) {
    const type = String(message?.type || "");

    if (type === "agent.ping") {
      return { ok: true, url: window.location.href, title: document.title };
    }

    if (type === "agent.snapshot") {
      const maxElements = Number(message?.maxElements || DEFAULT_MAX_ELEMENTS);
      return { ok: true, snapshot: collectSnapshot(maxElements) };
    }

    if (type === "agent.describeElement") {
      const selector = String(message?.selector || "").trim();
      if (!selector) {
        return { ok: true, element: null };
      }
      const el = document.querySelector(selector);
      if (!el) {
        return { ok: true, element: null };
      }
      return { ok: true, element: describeElement(el, selector) };
    }

    if (type === "agent.runAction") {
      const observation = await runAction(message?.action || {});
      return { ok: true, observation };
    }

    return { ok: false, error: `Unsupported message type: ${type}` };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message)
      .then((response) => sendResponse(response))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    return true;
  });
})();
