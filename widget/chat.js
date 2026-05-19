(() => {
  const ui = {
    chatTitle: document.querySelector("#chatTitle"),
    closeBtn: document.querySelector("#closeBtn"),
    chatLog: document.querySelector("#chatLog"),
    approvalBar: document.querySelector("#approvalBar"),
    approvalText: document.querySelector("#approvalText"),
    approveBtn: document.querySelector("#approveBtn"),
    cancelBtn: document.querySelector("#cancelBtn"),
    chatForm: document.querySelector("#chatForm"),
    userInput: document.querySelector("#userInput"),
    sendBtn: document.querySelector("#sendBtn")
  };

  const params = new URLSearchParams(window.location.search);
  const parentOrigin = params.get("parentOrigin") || "*";

  const state = {
    messages: [],
    busy: false,
    awaitingConfirmation: false,
    pendingActionLabel: ""
  };

  function postToParent(payload) {
    window.parent.postMessage(payload, parentOrigin);
  }

  function setBusy(isBusy) {
    state.busy = Boolean(isBusy);
    ui.userInput.disabled = state.busy;
    ui.sendBtn.disabled = state.busy;
    ui.approveBtn.disabled = state.busy || !state.awaitingConfirmation;
    ui.cancelBtn.disabled = state.busy || !state.awaitingConfirmation;
  }

  function renderMessages() {
    ui.chatLog.innerHTML = "";

    if (!state.messages.length) {
      const empty = document.createElement("div");
      empty.className = "bubble system";
      empty.textContent = "Чат готов. Напишите задачу по текущей странице.";
      ui.chatLog.appendChild(empty);
      return;
    }

    for (const item of state.messages) {
      const role = ["user", "assistant", "system"].includes(item.role) ? item.role : "assistant";
      const text = String(item.text || "").trim();
      if (!text) {
        continue;
      }
      const bubble = document.createElement("div");
      bubble.className = `bubble ${role}`;
      bubble.textContent = text;
      ui.chatLog.appendChild(bubble);
    }

    ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
  }

  function renderApproval() {
    if (!state.awaitingConfirmation) {
      ui.approvalBar.classList.remove("visible");
      return;
    }

    ui.approvalBar.classList.add("visible");
    ui.approvalText.textContent = state.pendingActionLabel
      ? `Для продолжения нужно подтверждение: ${state.pendingActionLabel}.`
      : "Для продолжения нужно подтверждение действия.";
  }

  function applyIncomingState(payload) {
    ui.chatTitle.textContent = String(payload.title || "Онлайн-помощник");
    state.messages = Array.isArray(payload.messages) ? payload.messages : [];
    state.awaitingConfirmation = Boolean(payload.awaiting_confirmation);
    state.pendingActionLabel = String(payload.pending_action_label || "");

    setBusy(Boolean(payload.busy));
    renderMessages();
    renderApproval();
  }

  window.addEventListener("message", (event) => {
    if (parentOrigin !== "*" && event.origin !== parentOrigin) {
      return;
    }

    const data = event.data && typeof event.data === "object" ? event.data : {};
    if (String(data.type || "") !== "ua_widget_state") {
      return;
    }

    applyIncomingState(data.payload || {});
  });

  ui.chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.busy) {
      return;
    }

    const message = String(ui.userInput.value || "").trim();
    if (!message) {
      return;
    }

    ui.userInput.value = "";
    postToParent({ type: "ua_widget_user_message", message });
  });

  ui.approveBtn.addEventListener("click", () => {
    if (state.busy) {
      return;
    }
    postToParent({ type: "ua_widget_confirm_pending" });
  });

  ui.cancelBtn.addEventListener("click", () => {
    if (state.busy) {
      return;
    }
    postToParent({ type: "ua_widget_cancel_pending" });
  });

  ui.closeBtn.addEventListener("click", () => {
    postToParent({ type: "ua_widget_close" });
  });

  postToParent({ type: "ua_widget_ready" });
})();
