from app.agent.safety import SafetyGuard
from app.models import ToolAction


def test_blocks_final_click_when_guard_enabled() -> None:
    guard = SafetyGuard(allow_final_actions=False)
    action = ToolAction(tool="click", reason="Submit form", args={"selector": "button[type='submit']"})

    result = guard.validate(action, element_meta={"text": "Подтвердить запись"})

    assert result.allowed is False


def test_allows_regular_click() -> None:
    guard = SafetyGuard(allow_final_actions=False)
    action = ToolAction(tool="click", reason="Open menu", args={"selector": "button.menu"})

    result = guard.validate(action, element_meta={"text": "Меню"})

    assert result.allowed is True

