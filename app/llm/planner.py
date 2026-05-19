from __future__ import annotations

import json
import re
from typing import Any

import httpx
from pydantic import ValidationError

from app.config import settings
from app.models import ChatMessage, PlanResult, ToolAction
from app.llm.prompts import FINAL_ANSWER_PROMPT, SYSTEM_PROMPT


class Planner:
    def __init__(self) -> None:
        self._client = httpx.AsyncClient(timeout=60.0)

    async def close(self) -> None:
        await self._client.aclose()

    async def plan(
        self,
        user_message: str,
        history: list[ChatMessage],
        snapshot: dict[str, Any],
    ) -> PlanResult:
        if not settings.openrouter_api_key:
            return self._heuristic_plan(
                user_message,
                planner_issue=(
                    "OPENROUTER_API_KEY is missing. "
                    "Set it in .env and restart the server."
                ),
            )

        try:
            return await self._plan_with_openrouter(user_message, history, snapshot)
        except Exception as exc:
            issue = str(exc).strip() or "unknown OpenRouter error"
            issue = issue.replace("\n", " ")
            if len(issue) > 220:
                issue = issue[:220] + "..."
            return self._heuristic_plan(
                user_message,
                planner_issue=f"OpenRouter request failed: {issue}",
            )

    async def finalize_answer(
        self,
        user_message: str,
        planner_reply: str,
        execution_log: list[str],
        snapshot: dict[str, Any],
    ) -> str:
        if not settings.openrouter_api_key:
            return self._heuristic_finalize_answer(user_message, planner_reply, execution_log)

        try:
            return await self._finalize_with_openrouter(
                user_message=user_message,
                planner_reply=planner_reply,
                execution_log=execution_log,
                snapshot=snapshot,
            )
        except Exception:
            return self._heuristic_finalize_answer(user_message, planner_reply, execution_log)

    async def _plan_with_openrouter(
        self,
        user_message: str,
        history: list[ChatMessage],
        snapshot: dict[str, Any],
    ) -> PlanResult:
        prompt = self._build_user_prompt(user_message, history, snapshot)
        response = await self._client.post(
            f"{settings.openrouter_base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {settings.openrouter_api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": settings.openrouter_referer,
                "X-Title": settings.openrouter_app_title,
            },
            json={
                "model": settings.openrouter_model,
                "temperature": 0.1,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
            },
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        return self.parse_plan(content)

    async def _finalize_with_openrouter(
        self,
        user_message: str,
        planner_reply: str,
        execution_log: list[str],
        snapshot: dict[str, Any],
    ) -> str:
        prompt = self._build_final_answer_prompt(
            user_message=user_message,
            planner_reply=planner_reply,
            execution_log=execution_log,
            snapshot=snapshot,
        )
        response = await self._client.post(
            f"{settings.openrouter_base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {settings.openrouter_api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": settings.openrouter_referer,
                "X-Title": settings.openrouter_app_title,
            },
            json={
                "model": settings.openrouter_model,
                "temperature": 0.2,
                "messages": [
                    {"role": "system", "content": FINAL_ANSWER_PROMPT},
                    {"role": "user", "content": prompt},
                ],
            },
        )
        response.raise_for_status()
        content = str(response.json()["choices"][0]["message"]["content"]).strip()
        if not content:
            raise ValueError("Empty final answer from model")
        return content

    @staticmethod
    def parse_plan(raw_text: str) -> PlanResult:
        payload = _extract_json(raw_text)
        data = json.loads(payload)
        assistant_reply = str(data.get("assistant_reply", "Готово."))
        actions: list[ToolAction] = []
        for item in data.get("actions", []):
            try:
                actions.append(ToolAction(**item))
            except ValidationError:
                continue

        if not actions:
            actions = [
                ToolAction(
                    tool="ask_user",
                    reason="Planner returned no valid executable actions",
                    args={},
                )
            ]
        return PlanResult(assistant_reply=assistant_reply, actions=actions)

    @staticmethod
    def _build_user_prompt(
        user_message: str,
        history: list[ChatMessage],
        snapshot: dict[str, Any],
    ) -> str:
        history_items = history[-6:]
        history_text = "\n".join(f"- {item.role}: {item.content}" for item in history_items)

        elements = snapshot.get("elements", [])[:300]
        element_lines = []
        for idx, el in enumerate(elements, start=1):
            selector = el.get("selector", "")
            tag = el.get("tag", "")
            el_type = el.get("type", "")
            text = el.get("text", "")
            placeholder = el.get("placeholder", "")
            aria_label = el.get("ariaLabel", "")
            name = el.get("name", "")
            el_id = el.get("id", "")
            label = el.get("label", "")
            element_lines.append(
                f"{idx}. selector='{selector}' tag='{tag}' type='{el_type}' text='{text}' "
                f"placeholder='{placeholder}' aria='{aria_label}' "
                f"name='{name}' id='{el_id}' label='{label}'"
            )

        return (
            f"User message:\n{user_message}\n\n"
            f"Conversation history:\n{history_text or '- (empty)'}\n\n"
            f"Page:\nURL: {snapshot.get('url', '')}\nTitle: {snapshot.get('title', '')}\n\n"
            f"Interactive elements:\n{chr(10).join(element_lines) or '- (none)'}"
        )

    @staticmethod
    def _build_final_answer_prompt(
        user_message: str,
        planner_reply: str,
        execution_log: list[str],
        snapshot: dict[str, Any],
    ) -> str:
        logs_text = "\n".join(f"- {line}" for line in execution_log[-12:]) or "- (no observations)"
        return (
            f"User message:\n{user_message}\n\n"
            f"Planner draft:\n{planner_reply}\n\n"
            f"Execution observations:\n{logs_text}\n\n"
            f"Current page:\nURL: {snapshot.get('url', '')}\nTitle: {snapshot.get('title', '')}"
        )

    @staticmethod
    def _heuristic_plan(user_message: str, planner_issue: str | None = None) -> PlanResult:
        lower = user_message.lower()

        match_url = re.search(r"https?://\\S+", user_message)
        if match_url is not None:
            return PlanResult(
                assistant_reply="Переход на указанный URL.",
                actions=[
                    ToolAction(
                        tool="navigate",
                        reason="User explicitly provided target URL",
                        args={"url": match_url.group(0)},
                    ),
                    ToolAction(tool="done", reason="Navigation requested", args={}),
                ],
            )

        type_match = re.search(
            r"(?:введи|напиши)\s+[\"']([^\"']+)[\"']\s+(?:в|во)\s+[\"']([^\"']+)[\"']",
            user_message,
            flags=re.IGNORECASE,
        )
        if type_match is not None:
            text = type_match.group(1)
            selector = type_match.group(2)
            return PlanResult(
                assistant_reply="Заполняю поле на странице.",
                actions=[
                    ToolAction(
                        tool="type",
                        reason="User requested text input",
                        args={"selector": selector, "text": text, "clear": True},
                    ),
                    ToolAction(tool="done", reason="Field update requested", args={}),
                ],
            )

        click_match = re.search(
            r"(?:кликни|нажми)\s+[\"']([^\"']+)[\"']",
            user_message,
            flags=re.IGNORECASE,
        )
        if click_match is not None:
            selector = click_match.group(1)
            return PlanResult(
                assistant_reply="Нажимаю нужный элемент на странице.",
                actions=[
                    ToolAction(tool="click", reason="User requested a click", args={"selector": selector}),
                    ToolAction(tool="done", reason="Action executed", args={}),
                ],
            )

        if _is_search_request(user_message):
            query = _extract_search_query(user_message)
            return PlanResult(
                assistant_reply="Запускаю поиск на сайте.",
                actions=[
                    ToolAction(
                        tool="type",
                        reason="Search request",
                        args={
                            "selector": "",
                            "text": query,
                            "clear": True,
                            "field_hint": "поиск",
                            "placeholder_hint": "поиск",
                            "aria_label_hint": "поиск",
                            "name_hint": "q",
                            "press_enter": True,
                            "search_submit": True,
                        },
                    ),
                    ToolAction(tool="done", reason="Search started", args={}),
                ],
            )

        if any(word in lower for word in {"найди", "информац", "что написано", "покажи"}):
            return PlanResult(
                assistant_reply="Собираю текст со страницы и вернусь с ответом.",
                actions=[
                    ToolAction(
                        tool="extract_text",
                        reason="Information lookup request",
                        args={"selector": "body", "max_chars": 1800},
                    ),
                    ToolAction(tool="done", reason="Extraction completed", args={}),
                ],
            )

        return PlanResult(
            assistant_reply=(
                "Чтобы выполнить задачу, нужно чуть больше деталей. "
                "Напиши, что именно сделать на странице."
            ),
            actions=[
                ToolAction(
                    tool="ask_user",
                    reason=planner_issue or "Need exact actionable instruction",
                    args={},
                )
            ],
        )

    @staticmethod
    def _heuristic_finalize_answer(
        user_message: str,
        planner_reply: str,
        execution_log: list[str],
    ) -> str:
        extracted_chunks: list[str] = []
        for line in execution_log:
            match = re.search(r"extract_text[^:]*:\s*(.*)$", line, flags=re.IGNORECASE)
            if match:
                extracted_chunks.append(match.group(1).strip())

        merged = " ".join(extracted_chunks)
        merged_lower = merged.lower()
        question_lower = user_message.lower()

        if any(word in question_lower for word in {"дерматолог", "дерматовенеролог"}):
            if any(word in merged_lower for word in {"дерматолог", "дерматовенеролог"}):
                names = _extract_russian_names(merged)
                if names:
                    head = ", ".join(names[:3])
                    return f"Да, в больнице есть профильный специалист. Найденные ФИО: {head}."
                return "Да, на странице есть упоминание профильного специалиста (дерматолог/дерматовенеролог)."
            return "По текущим данным на странице упоминание дерматолога не найдено."

        if merged:
            snippet = " ".join(merged.split())
            if len(snippet) > 280:
                snippet = snippet[:280] + "..."
            return f"Нашла на странице следующее: {snippet}"

        logs_lower = "\n".join(execution_log).lower()
        has_success_observation = any(
            token in logs_lower
            for token in (
                "typed into",
                "clicked ",
                "pressed ",
                "selector visible",
                "navigated to",
                "extract_text ",
            )
        )
        has_failure_observation = any(
            token in logs_lower
            for token in (
                "not found",
                "timeout",
                " error",
                "unsupported",
                "blocked by safety",
            )
        )
        has_pending_approval = "pending approval" in logs_lower

        if has_pending_approval and not has_success_observation:
            return "Подготовила следующий шаг. Для продолжения нужно подтверждение."
        if has_failure_observation and not has_success_observation:
            return "Не получилось подтвердить выполнение действия на странице. Уточните поле или кнопку, и я повторю."

        return planner_reply.strip() or "Готово."


def _extract_json(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        lines = [line for line in cleaned.splitlines() if not line.strip().startswith("```")]
        cleaned = "\n".join(lines).strip()

    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("No JSON object detected in planner response")
    return cleaned[start : end + 1]


def _extract_russian_names(text: str) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    for match in re.finditer(r"\b[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){1,2}\b", text):
        candidate = " ".join(match.group(0).split())
        if candidate in seen:
            continue
        seen.add(candidate)
        found.append(candidate)
        if len(found) >= 6:
            break
    return found


def _is_search_request(user_message: str) -> bool:
    lowered = user_message.lower()
    info_only_tokens = {"информац", "что написано", "какая информация", "покажи информацию"}
    if any(token in lowered for token in info_only_tokens):
        return False

    search_tokens = {"найди", "найти", "ищи", "поищи", "поиск", "search"}
    transaction_tokens = {"корзин", "добавь", "куп", "checkout", "buy", "cart"}
    return any(token in lowered for token in search_tokens | transaction_tokens)


def _extract_search_query(user_message: str) -> str:
    text = " ".join(str(user_message).strip().split())
    if not text:
        return ""

    quoted_match = re.search(r"[\"'«](.+?)[\"'»]", text)
    if quoted_match:
        quoted = quoted_match.group(1).strip()
        if quoted:
            return quoted

    patterns = [
        r"(?:в\s+корзин\w*\s+)(.+)$",
        r"(?:найди|найти|ищи|поищи|поиск|search)\s+(?:мне\s+)?(.+)$",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if not match:
            continue
        candidate = match.group(1).strip(" .,!?:;")
        candidate = re.sub(r"^(?:товар|товары|продукт|продукты)\s+", "", candidate, flags=re.IGNORECASE)
        if candidate:
            return candidate

    candidate = re.sub(
        r"\b(?:добавь|добавьте|мне|в|корзину|найди|найти|ищи|поищи|поиск|search)\b",
        " ",
        text,
        flags=re.IGNORECASE,
    )
    candidate = " ".join(candidate.split()).strip(" .,!?:;")
    return candidate or text
