import asyncio

from app.agent.extension_orchestrator import ExtensionSessionManager
from app.agent.safety import SafetyGuard
from app.models import PlanResult, ToolAction


class StubPlanner:
    def __init__(self, plans: list[PlanResult], final_text: str = "Готово.") -> None:
        self._plans = plans
        self._index = 0
        self._final_text = final_text

    async def plan(self, user_message: str, history: list, snapshot: dict) -> PlanResult:
        if self._index >= len(self._plans):
            return self._plans[-1]
        current = self._plans[self._index]
        self._index += 1
        return current

    async def finalize_answer(
        self,
        user_message: str,
        planner_reply: str,
        execution_log: list[str],
        snapshot: dict,
    ) -> str:
        return self._final_text


def test_executes_preparatory_inputs_before_pending_final_confirmation() -> None:
    planner = StubPlanner(
        plans=[
            PlanResult(
                assistant_reply="Заполняю поля и готовлю оплату.",
                actions=[
                    ToolAction(tool="type", reason="Fill recipient", args={"selector": "#recipientName", "text": "Марина"}),
                    ToolAction(tool="type", reason="Fill phone", args={"selector": "#recipientPhone", "text": "123456789"}),
                    ToolAction(tool="click", reason="Proceed to pay", args={"selector": "#payButton"}),
                    ToolAction(tool="done", reason="Prepared", args={}),
                ],
            )
        ]
    )
    manager = ExtensionSessionManager(planner=planner, safety_guard=SafetyGuard(allow_final_actions=False))
    session = manager.create_session()

    snapshot = {
        "url": "https://example.test/gift",
        "title": "Gift",
        "elements": [
            {"selector": "#recipientName", "text": "", "ariaLabel": "Имя получателя"},
            {"selector": "#recipientPhone", "text": "", "ariaLabel": "Телефон получателя"},
            {"selector": "#payButton", "text": "Оплатить • 5 000 ₽", "ariaLabel": "Оплатить"},
        ],
    }

    first = asyncio.run(
        manager.handle_turn(
            session=session,
            snapshot=snapshot,
            message="имя марина сумма подарка 10000 телефон 123-76-89-89",
        )
    )

    assert len(first.actions) == 2
    assert [item.tool for item in first.actions] == ["type", "type"]
    assert first.awaiting_confirmation is False
    assert first.done is False

    second = asyncio.run(
        manager.handle_turn(
            session=session,
            snapshot=snapshot,
            observations=[
                "type: typed into #recipientName",
                "type: typed into #recipientPhone",
            ],
        )
    )

    assert second.awaiting_confirmation is True
    assert second.pending_action_label is not None
    assert "Для продолжения нужно подтверждение" in second.assistant_message


def test_add_to_cart_intent_does_not_auto_open_cart() -> None:
    planner = StubPlanner(
        plans=[
            PlanResult(
                assistant_reply="Добавляю товар.",
                actions=[
                    ToolAction(tool="click", reason="Add product", args={"selector": "#addToCart"}),
                    ToolAction(tool="click", reason="Open cart", args={"selector": "#openCart"}),
                    ToolAction(tool="done", reason="Finished", args={}),
                ],
            )
        ]
    )
    manager = ExtensionSessionManager(planner=planner, safety_guard=SafetyGuard(allow_final_actions=False))
    session = manager.create_session()

    snapshot = {
        "url": "https://example.test/product",
        "title": "Product",
        "elements": [
            {"selector": "#addToCart", "text": "Добавить в корзину", "ariaLabel": "Добавить в корзину"},
            {"selector": "#openCart", "text": "Корзина", "ariaLabel": "Открыть корзину"},
        ],
    }

    first = asyncio.run(
        manager.handle_turn(
            session=session,
            snapshot=snapshot,
            message="добавь в корзину этот товар",
        )
    )

    assert len(first.actions) == 1
    assert first.actions[0].args.get("selector") == "#addToCart"
    assert first.done is False


def test_autopilot_stops_after_add_to_cart_success() -> None:
    should_continue = ExtensionSessionManager._should_continue_autopilot(
        user_message="добавь в корзину lacoste",
        cycle=0,
        cycle_had_executable_action=True,
        cycle_has_ask_user=False,
        execution_log=["1. click: clicked by text 'добавить в корзину'"],
    )

    assert should_continue is False
