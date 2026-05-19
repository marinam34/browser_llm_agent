from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from uuid import uuid4

from app.agent.safety import SafetyGuard
from app.config import settings
from app.llm.planner import Planner
from app.models import ChatMessage, ExtensionChatTurnResponse, ToolAction

CONFIRM_TOKENS = {"подтверждаю", "подтвердить", "confirm", "approve", "ok", "да"}
CANCEL_TOKENS = {"отмена", "отменить", "cancel", "stop", "нет"}
TRANSACTION_TOKENS = {
    "корзин",
    "добавь",
    "куп",
    "оплат",
    "оформ",
    "заказ",
    "book",
    "booking",
    "checkout",
    "buy",
    "cart",
}
CHECKOUT_INTENT_TOKENS = {
    "оплат",
    "оформ",
    "заказ",
    "checkout",
    "payment",
    "buy now",
    "place order",
    "submit order",
    "book",
    "booking",
}
ADD_TO_CART_INTENT_TOKENS = {
    "в корзину",
    "add to cart",
}
OPEN_CART_REQUEST_TOKENS = {
    "открой корзин",
    "перейди в корзин",
    "покажи корзин",
    "open cart",
    "go to cart",
    "view cart",
    "show cart",
    "checkout",
}
CART_SURFACE_TOKENS = {"корзин", "cart", "basket", "bag"}
ADD_TO_CART_ACTION_TOKENS = {"добав", "add to cart", "to cart", "в корзину"}
OBSERVATION_WAIT_TIMEOUT_SEC = 18.0
SEARCH_INTENT_TOKENS = {
    "найди",
    "найти",
    "ищи",
    "поищи",
    "поиск",
    "search",
    "найд",
}
SEARCH_FIELD_TOKENS = {
    "search",
    "поиск",
    "найти",
    "query",
    "искать",
}


@dataclass
class ExtensionRunState:
    user_message: str
    planner_reply: str = ""
    execution_log: list[str] = field(default_factory=list)
    cycle: int = 0
    seen_signatures: set[str] = field(default_factory=set)
    cycle_had_executable_action: bool = False
    cycle_has_ask_user: bool = False


@dataclass
class ExtensionChatSession:
    session_id: str
    history: list[ChatMessage] = field(default_factory=list)
    pending_action: ToolAction | None = None
    pending_action_label: str | None = None
    run: ExtensionRunState | None = None
    awaiting_observations: bool = False
    awaiting_started_at: float | None = None
    confirming_pending: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class ExtensionSessionManager:
    def __init__(self, planner: Planner, safety_guard: SafetyGuard) -> None:
        self._planner = planner
        self._safety_guard = safety_guard
        self._sessions: dict[str, ExtensionChatSession] = {}

    def create_session(self) -> ExtensionChatSession:
        session_id = uuid4().hex
        session = ExtensionChatSession(session_id=session_id)
        self._sessions[session_id] = session
        return session

    def get(self, session_id: str) -> ExtensionChatSession | None:
        return self._sessions.get(session_id)

    async def handle_turn(
        self,
        session: ExtensionChatSession,
        snapshot: dict,
        message: str | None = None,
        control: str | None = None,
        observations: list[str] | None = None,
    ) -> ExtensionChatTurnResponse:
        async with session.lock:
            safe_snapshot = _normalize_snapshot(snapshot)
            safe_observations = [str(item).strip() for item in (observations or []) if str(item).strip()]
            normalized_message = (message or "").strip()
            normalized_control = (control or "").strip().lower()

            if safe_observations:
                observation_response = await self._handle_observations(session, safe_snapshot, safe_observations)
                if observation_response is not None:
                    return observation_response

            if normalized_control:
                return await self._handle_control(session, normalized_control, safe_snapshot)

            if normalized_message:
                return await self._handle_message(session, normalized_message, safe_snapshot)

            return self._current_state_response(session)

    async def _handle_message(
        self,
        session: ExtensionChatSession,
        user_message: str,
        snapshot: dict,
    ) -> ExtensionChatTurnResponse:
        lower = user_message.lower()

        if session.pending_action is not None:
            if _contains_any(lower, CONFIRM_TOKENS):
                return await self._handle_control(session, "confirm_pending", snapshot)
            if _contains_any(lower, CANCEL_TOKENS):
                return await self._handle_control(session, "cancel_pending", snapshot)
            text = "Есть ожидающее действие. Подтвердите или отмените его." 
            session.history.append(ChatMessage(role="assistant", content=text))
            return self._final_text_response(session, text)

        if session.awaiting_observations:
            if _is_observation_wait_stalled(session):
                _recover_stalled_observation_wait(session)
            else:
                text = "Подождите, выполняю предыдущий шаг."
                return self._final_text_response(session, text)

        run = ExtensionRunState(user_message=user_message)
        session.run = run
        session.history.append(ChatMessage(role="user", content=user_message))

        return await self._plan_and_prepare_actions(session, snapshot, user_message)

    async def _handle_control(
        self,
        session: ExtensionChatSession,
        control: str,
        snapshot: dict,
    ) -> ExtensionChatTurnResponse:
        if control in {"cancel_pending", "cancel", "reject_pending"}:
            if session.pending_action is None:
                text = "Сейчас нет действия, которое нужно отменять."
                return self._final_text_response(session, text)

            session.pending_action = None
            session.pending_action_label = None
            session.confirming_pending = False
            text = "Действие отменено."
            session.history.append(ChatMessage(role="assistant", content=text))
            return self._final_text_response(session, text)

        if control in {"confirm_pending", "confirm", "approve_pending"}:
            if session.pending_action is None:
                text = "Сейчас нет действия, которое нужно подтверждать."
                return self._final_text_response(session, text)

            session.confirming_pending = True
            session.awaiting_observations = True
            session.awaiting_started_at = time.monotonic()
            return ExtensionChatTurnResponse(
                assistant_message="",
                actions=[session.pending_action],
                awaiting_confirmation=True,
                pending_action_label=session.pending_action_label,
                done=False,
            )

        text = "Неизвестная команда управления действием."
        return self._final_text_response(session, text)

    async def _handle_observations(
        self,
        session: ExtensionChatSession,
        snapshot: dict,
        observations: list[str],
    ) -> ExtensionChatTurnResponse | None:
        if not session.awaiting_observations:
            return None

        run = session.run
        if run is None and not session.confirming_pending:
            session.awaiting_observations = False
            return None

        if session.confirming_pending:
            session.awaiting_observations = False
            session.awaiting_started_at = None
            session.confirming_pending = False

            last = observations[-1].lower()
            if any(token in last for token in ["error", "timeout", "not found", "unsupported"]):
                text = "Не получилось выполнить подтвержденное действие. Попробуйте еще раз."
                session.history.append(ChatMessage(role="assistant", content=text))
                return self._final_text_response(
                    session,
                    text,
                    awaiting_confirmation=session.pending_action is not None,
                )

            session.pending_action = None
            session.pending_action_label = None
            text = "Готово, действие подтверждено и выполнено."
            session.history.append(ChatMessage(role="assistant", content=text))
            return self._final_text_response(session, text)

        if run is None:
            session.awaiting_observations = False
            session.awaiting_started_at = None
            return None

        for observation in observations:
            run.execution_log.append(f"{len(run.execution_log) + 1}. {observation}")

        session.awaiting_observations = False
        session.awaiting_started_at = None

        if session.pending_action is not None:
            return await self._finalize_run(session, snapshot)

        if self._should_continue_autopilot(
            user_message=run.user_message,
            cycle=run.cycle,
            cycle_had_executable_action=run.cycle_had_executable_action,
            cycle_has_ask_user=run.cycle_has_ask_user,
            execution_log=run.execution_log,
        ):
            run.cycle += 1
            cycle_message = self._build_autopilot_message(run.user_message, run.execution_log)
            return await self._plan_and_prepare_actions(session, snapshot, cycle_message)

        return await self._finalize_run(session, snapshot)

    async def _plan_and_prepare_actions(
        self,
        session: ExtensionChatSession,
        snapshot: dict,
        planner_message: str,
    ) -> ExtensionChatTurnResponse:
        run = session.run
        if run is None:
            return self._current_state_response(session)

        plan = await self._planner.plan(
            user_message=planner_message,
            history=session.history,
            snapshot=snapshot,
        )

        if (
            _is_transaction_intent(run.user_message)
            and not _has_executable_actions(plan.actions)
            and (
                any(item.tool == "ask_user" for item in plan.actions)
                or _looks_like_confirmation_request(plan.assistant_reply)
            )
        ):
            reinforced_message = (
                f"{planner_message}\n\n"
                "IMPORTANT: Return at least one executable action. "
                "For checkout/payment/booking tasks, include the final irreversible action as the last action "
                "(click or press). For add-to-cart tasks, stop after item is added to cart unless user asked "
                "to open cart/checkout. Do not finish with only ask_user/done."
            )
            retry_plan = await self._planner.plan(
                user_message=reinforced_message,
                history=session.history,
                snapshot=snapshot,
            )
            if _has_executable_actions(retry_plan.actions):
                plan = retry_plan

        if plan.assistant_reply:
            run.planner_reply = plan.assistant_reply

        signature = _plan_signature(plan.actions)
        if signature in run.seen_signatures:
            run.execution_log.append(f"{len(run.execution_log) + 1}. autopilot: повторяющийся план, остановка.")
            return await self._finalize_run(session, snapshot)
        run.seen_signatures.add(signature)

        executable_actions: list[ToolAction] = []
        run.cycle_had_executable_action = False
        run.cycle_has_ask_user = False
        stop_after_cycle = False

        scoped_actions = plan.actions[: settings.max_actions_per_turn]
        for index, action in enumerate(scoped_actions):
            if action.tool == "ask_user":
                run.cycle_has_ask_user = True
            if action.tool not in {"done", "ask_user"}:
                run.cycle_had_executable_action = True

            if action.tool in {"done", "ask_user"}:
                if not executable_actions:
                    run.execution_log.append(
                        f"{len(run.execution_log) + 1}. {action.tool}: {action.reason or 'No browser action.'}"
                    )
                stop_after_cycle = True
                break

            element_meta = None
            if action.tool in {"click", "type", "press"}:
                selector = str(action.args.get("selector", "")).strip()
                if selector:
                    element_meta = _find_element_meta(snapshot, selector)
            if action.tool == "type":
                action = _build_type_action(action, element_meta)
                has_submit_after = _has_submit_like_after(scoped_actions, index)
                action = _ensure_search_submit_for_type(
                    action=action,
                    element_meta=element_meta,
                    user_message=run.user_message,
                    has_submit_after=has_submit_after,
                )

            if _should_skip_follow_up_cart_navigation(run.user_message, action, element_meta):
                run.execution_log.append(
                    f"{len(run.execution_log) + 1}. autopilot: корзина/checkout не открываются без явного запроса"
                )
                stop_after_cycle = True
                break

            decision = self._safety_guard.validate(action, element_meta)
            if not decision.allowed:
                if decision.code == "final_action_blocked":
                    session.pending_action = _build_pending_action(action, element_meta)
                    session.pending_action_label = _pending_action_label(session.pending_action)
                    run.execution_log.append(
                        f"{len(run.execution_log) + 1}. pending approval: финальное действие требует подтверждения"
                    )
                    if executable_actions:
                        stop_after_cycle = True
                        break
                    return await self._finalize_run(session, snapshot)

                run.execution_log.append(f"{len(run.execution_log) + 1}. blocked by safety")
                return await self._finalize_run(session, snapshot)

            executable_actions.append(action)

        if executable_actions:
            session.awaiting_observations = True
            session.awaiting_started_at = time.monotonic()
            return ExtensionChatTurnResponse(
                assistant_message="",
                actions=executable_actions,
                awaiting_confirmation=False,
                pending_action_label=None,
                done=False,
            )

        if stop_after_cycle:
            return await self._finalize_run(session, snapshot)

        return await self._finalize_run(session, snapshot)

    async def _finalize_run(self, session: ExtensionChatSession, snapshot: dict) -> ExtensionChatTurnResponse:
        run = session.run
        if run is None:
            return self._current_state_response(session)

        final_text = await self._planner.finalize_answer(
            user_message=run.user_message,
            planner_reply=run.planner_reply,
            execution_log=run.execution_log,
            snapshot=snapshot,
        )

        if session.pending_action is not None and session.pending_action_label:
            final_text = (
                f"{final_text}\n\n"
                f"Для продолжения нужно подтверждение: {session.pending_action_label}."
            )

        session.history.append(ChatMessage(role="assistant", content=final_text))
        session.run = None
        session.awaiting_observations = False
        session.awaiting_started_at = None

        return self._final_text_response(
            session,
            final_text,
            awaiting_confirmation=session.pending_action is not None,
        )

    def _final_text_response(
        self,
        session: ExtensionChatSession,
        text: str,
        awaiting_confirmation: bool | None = None,
    ) -> ExtensionChatTurnResponse:
        awaiting = session.pending_action is not None if awaiting_confirmation is None else awaiting_confirmation
        return ExtensionChatTurnResponse(
            assistant_message=text,
            actions=[],
            awaiting_confirmation=awaiting,
            pending_action_label=session.pending_action_label if awaiting else None,
            done=True,
        )

    def _current_state_response(self, session: ExtensionChatSession) -> ExtensionChatTurnResponse:
        return ExtensionChatTurnResponse(
            assistant_message="",
            actions=[],
            awaiting_confirmation=session.pending_action is not None,
            pending_action_label=session.pending_action_label,
            done=not session.awaiting_observations,
        )

    @staticmethod
    def _build_autopilot_message(user_message: str, execution_log: list[str]) -> str:
        recent = "\n".join(execution_log[-4:])
        if _is_add_to_cart_only_intent(user_message):
            objective = (
                "Продолжай выполнение задачи автоматически до добавления товара в корзину. "
                "После успешного добавления остановись и не открывай корзину/checkout без явной просьбы."
            )
        else:
            objective = (
                "Продолжай выполнение задачи автоматически до финального шага. "
                "Не останавливайся на поиске/фильтре, дойди до кнопки оформления действия."
            )
        return (
            f"{user_message}\n\n"
            f"{objective}\n"
            f"Последние наблюдения:\n{recent}"
        )

    @staticmethod
    def _should_continue_autopilot(
        user_message: str,
        cycle: int,
        cycle_had_executable_action: bool,
        cycle_has_ask_user: bool,
        execution_log: list[str],
    ) -> bool:
        if cycle + 1 >= settings.max_planning_cycles:
            return False
        if not _is_transaction_intent(user_message):
            return False
        if cycle_has_ask_user:
            return False
        if not cycle_had_executable_action:
            return False
        tail = [line.lower() for line in execution_log[-4:]]
        if any(
            (
                " timeout" in line
                or " error" in line
                or "not found" in line
                or "unsupported" in line
            )
            for line in tail
        ):
            return False
        if _is_add_to_cart_only_intent(user_message) and _has_add_to_cart_success(tail):
            return False
        return True


def _normalize_snapshot(snapshot: dict | None) -> dict:
    if not isinstance(snapshot, dict):
        return {"url": "", "title": "", "elements": []}
    elements = snapshot.get("elements", [])
    if not isinstance(elements, list):
        elements = []
    return {
        "url": str(snapshot.get("url", "")),
        "title": str(snapshot.get("title", "")),
        "elements": elements,
    }


def _find_element_meta(snapshot: dict, selector: str) -> dict | None:
    for item in snapshot.get("elements", []):
        if not isinstance(item, dict):
            continue
        if str(item.get("selector", "")).strip() == selector:
            return item
    return None


def _contains_any(text: str, tokens: set[str]) -> bool:
    return any(token in text for token in tokens)


def _is_observation_wait_stalled(session: ExtensionChatSession) -> bool:
    if not session.awaiting_observations:
        return False
    if session.awaiting_started_at is None:
        return False
    return (time.monotonic() - session.awaiting_started_at) >= OBSERVATION_WAIT_TIMEOUT_SEC


def _recover_stalled_observation_wait(session: ExtensionChatSession) -> None:
    session.awaiting_observations = False
    session.awaiting_started_at = None
    session.run = None
    if session.confirming_pending:
        session.confirming_pending = False
        session.pending_action = None
        session.pending_action_label = None


def _is_transaction_intent(user_message: str) -> bool:
    lowered = user_message.lower()
    return any(token in lowered for token in TRANSACTION_TOKENS)


def _is_add_to_cart_only_intent(user_message: str) -> bool:
    lowered = user_message.lower()
    has_add_to_cart = any(token in lowered for token in ADD_TO_CART_INTENT_TOKENS) or (
        ("корзин" in lowered or "cart" in lowered) and ("добав" in lowered or "add" in lowered)
    )
    if not has_add_to_cart:
        return False
    if any(token in lowered for token in CHECKOUT_INTENT_TOKENS):
        return False
    if any(token in lowered for token in OPEN_CART_REQUEST_TOKENS):
        return False
    return True


def _has_add_to_cart_success(log_tail: list[str]) -> bool:
    return any(
        (
            "в корзин" in line
            or "add to cart" in line
            or "to cart" in line
            or "added to bag" in line
        )
        for line in log_tail
    )


def _should_skip_follow_up_cart_navigation(
    user_message: str,
    action: ToolAction,
    element_meta: dict | None,
) -> bool:
    if action.tool not in {"click", "press", "navigate"}:
        return False
    if not _is_add_to_cart_only_intent(user_message):
        return False

    text_parts = [
        str(action.args.get("selector", "")),
        str(action.args.get("text_hint", "")),
        str(action.args.get("aria_label_hint", "")),
        str(action.args.get("ui_label", "")),
        str(action.reason or ""),
    ]
    if element_meta:
        text_parts.extend(
            [
                str(element_meta.get("text", "")),
                str(element_meta.get("ariaLabel", "")),
                str(element_meta.get("id", "")),
                str(element_meta.get("name", "")),
                str(element_meta.get("label", "")),
            ]
        )
    merged = " ".join(part.lower() for part in text_parts if part)
    if not merged:
        return False

    if any(token in merged for token in CHECKOUT_INTENT_TOKENS):
        return True

    has_cart_surface = any(token in merged for token in CART_SURFACE_TOKENS)
    if not has_cart_surface:
        return False

    if any(token in merged for token in ADD_TO_CART_ACTION_TOKENS):
        return False

    return True


def _is_search_intent(user_message: str) -> bool:
    lowered = user_message.lower()
    return any(token in lowered for token in SEARCH_INTENT_TOKENS)


def _has_executable_actions(actions: list[ToolAction]) -> bool:
    return any(item.tool not in {"done", "ask_user"} for item in actions)


def _looks_like_confirmation_request(text: str) -> bool:
    lowered = text.lower()
    tokens = ("подтверд", "confirm", "approve", "разреш", "явное подтверждение")
    return any(token in lowered for token in tokens)


def _has_submit_like_after(actions: list[ToolAction], current_index: int) -> bool:
    for item in actions[current_index + 1 :]:
        if item.tool == "press":
            return True
        if item.tool == "click":
            return True
    return False


def _ensure_search_submit_for_type(
    action: ToolAction,
    element_meta: dict | None,
    user_message: str,
    has_submit_after: bool,
) -> ToolAction:
    if action.tool != "type":
        return action

    if has_submit_after:
        return action

    args = dict(action.args)

    field_parts = [
        str(args.get("selector", "")),
        str(args.get("field_hint", "")),
        str(args.get("text_hint", "")),
        str(args.get("placeholder_hint", "")),
        str(args.get("aria_label_hint", "")),
        str(args.get("name_hint", "")),
        str(args.get("label_hint", "")),
    ]
    if element_meta:
        field_parts.extend(
            [
                str(element_meta.get("selector", "")),
                str(element_meta.get("text", "")),
                str(element_meta.get("placeholder", "")),
                str(element_meta.get("ariaLabel", "")),
                str(element_meta.get("name", "")),
                str(element_meta.get("id", "")),
                str(element_meta.get("label", "")),
            ]
        )

    haystack = " ".join(part.lower() for part in field_parts if part)
    exact_name_q = str(args.get("name_hint", "")).strip().lower() == "q"
    if element_meta and str(element_meta.get("name", "")).strip().lower() == "q":
        exact_name_q = True

    is_search_field = exact_name_q or any(token in haystack for token in SEARCH_FIELD_TOKENS)
    if bool(args.get("press_enter")):
        if is_search_field and not bool(args.get("search_submit")):
            args["search_submit"] = True
            return ToolAction(tool=action.tool, reason=action.reason, args=args)
        return action

    if not (_is_search_intent(user_message) or _is_transaction_intent(user_message)):
        return action

    if is_search_field:
        args["press_enter"] = True
        args["search_submit"] = True
        return ToolAction(tool=action.tool, reason=action.reason, args=args)

    return action


def _plan_signature(actions: list[ToolAction]) -> str:
    if not actions:
        return "empty"
    parts: list[str] = []
    for item in actions[:8]:
        selector = str(item.args.get("selector", ""))
        text = str(item.args.get("text", ""))
        url = str(item.args.get("url", ""))
        parts.append(f"{item.tool}|{selector}|{text}|{url}")
    return "||".join(parts)


def _normalize_final_button_hint(raw: str) -> str:
    value = " ".join(raw.split()).strip()
    lower = value.lower()

    canonical_pairs = [
        ("в корзину", "в корзину"),
        ("add to cart", "add to cart"),
        ("checkout", "checkout"),
        ("оплат", "оплатить"),
        ("купить", "купить"),
        ("оформ", "оформить заказ"),
        ("записаться", "записаться"),
        ("book", "book"),
        ("submit", "submit"),
    ]
    for needle, normalized in canonical_pairs:
        if needle in lower:
            return normalized

    if len(value) > 80:
        return value[:80]
    return value


def _build_pending_action(action: ToolAction, element_meta: dict | None) -> ToolAction:
    args = dict(action.args)
    args.setdefault("timeout_ms", 7000)

    if not args.get("ui_label"):
        text_label = ""
        if element_meta:
            text_label = str(element_meta.get("text", "")).strip()
        if text_label:
            args["ui_label"] = f"нажать «{text_label[:60]}»"
        else:
            args["ui_label"] = "подтвердить завершающее действие"

    if element_meta:
        text_hint = _normalize_final_button_hint(str(element_meta.get("text", "")).strip())
        aria_hint = _normalize_final_button_hint(str(element_meta.get("ariaLabel", "")).strip())
        if text_hint and not args.get("text_hint"):
            args["text_hint"] = text_hint
        if aria_hint and not args.get("aria_label_hint"):
            args["aria_label_hint"] = aria_hint
    else:
        selector_hint = _normalize_final_button_hint(str(args.get("selector", "")))
        if selector_hint and not args.get("text_hint"):
            args["text_hint"] = selector_hint

    return ToolAction(tool=action.tool, reason=action.reason, args=args)


def _build_type_action(action: ToolAction, element_meta: dict | None) -> ToolAction:
    args = dict(action.args)

    selector_hint = str(args.get("selector", "")).strip()
    if selector_hint and not args.get("field_hint"):
        args["field_hint"] = selector_hint

    if element_meta:
        placeholder = str(element_meta.get("placeholder", "")).strip()
        aria_label = str(element_meta.get("ariaLabel", "")).strip()
        name_attr = str(element_meta.get("name", "")).strip()
        label = str(element_meta.get("label", "")).strip()
        element_id = str(element_meta.get("id", "")).strip()
        text = str(element_meta.get("text", "")).strip()

        if placeholder and not args.get("placeholder_hint"):
            args["placeholder_hint"] = placeholder
        if aria_label and not args.get("aria_label_hint"):
            args["aria_label_hint"] = aria_label
        if name_attr and not args.get("name_hint"):
            args["name_hint"] = name_attr
        if label and not args.get("label_hint"):
            args["label_hint"] = label
        if text and not args.get("field_hint"):
            args["field_hint"] = text
        if element_id and not args.get("field_hint"):
            args["field_hint"] = element_id

    return ToolAction(tool=action.tool, reason=action.reason, args=args)


def _pending_action_label(action: ToolAction | None) -> str | None:
    if action is None:
        return None

    ui_label = str(action.args.get("ui_label", "")).strip()
    if ui_label:
        return ui_label

    if action.tool == "click":
        return "подтвердить нажатие кнопки"
    if action.tool == "press":
        return "подтвердить завершающее действие"
    return "подтвердить действие на странице"
