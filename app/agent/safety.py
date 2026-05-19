from __future__ import annotations

from urllib.parse import urlparse

from app.models import SafetyDecision, ToolAction

FINAL_ACTION_KEYWORDS = {
    "pay",
    "payment",
    "checkout",
    "buy now",
    "buy",
    "place order",
    "submit order",
    "book appointment",
    "confirm booking",
    "finalize booking",
    "подтвердить заказ",
    "оформить заказ",
    "купить",
    "подтвердить запись",
    "записаться",
    "оплат",
}

NON_FINAL_ACTION_HINTS = {
    "search",
    "find",
    "поиск",
    "найти",
    "filter",
    "фильтр",
    "sort",
    "сорт",
    "open",
    "view",
    "перейти",
    "страница",
    "каталог",
}


def _contains_any_token(text: str, tokens: set[str]) -> bool:
    return any(token in text for token in tokens)


class SafetyGuard:
    def __init__(self, allow_final_actions: bool = False) -> None:
        self.allow_final_actions = allow_final_actions

    def validate(self, action: ToolAction, element_meta: dict | None = None) -> SafetyDecision:
        if action.tool == "navigate":
            url = str(action.args.get("url", "")).strip()
            parsed = urlparse(url)
            if parsed.scheme not in {"http", "https"}:
                return SafetyDecision(
                    allowed=False,
                    reason=f"Blocked non-web URL scheme: {parsed.scheme}",
                    code="invalid_url_scheme",
                )

        if action.tool in {"click", "press"}:
            selector = str(action.args.get("selector", ""))
            text_bits = [selector]
            if element_meta:
                text_bits.append(str(element_meta.get("text", "")))
                text_bits.append(str(element_meta.get("ariaLabel", "")))
                text_bits.append(str(element_meta.get("type", "")))
            merged = " ".join(text_bits).lower()

            has_final_keyword = _contains_any_token(merged, FINAL_ACTION_KEYWORDS)
            has_non_final_hint = _contains_any_token(merged, NON_FINAL_ACTION_HINTS)

            if not self.allow_final_actions and has_final_keyword and not has_non_final_hint:
                return SafetyDecision(
                    allowed=False,
                    reason=(
                        "Potential final/irreversible action detected. "
                        "Agent is configured to stop before final confirmation."
                    ),
                    code="final_action_blocked",
                )

        return SafetyDecision(allowed=True, reason="Allowed", code="ok")
