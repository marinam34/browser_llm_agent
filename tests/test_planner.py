from app.llm.planner import Planner


def test_parse_plan_from_plain_json() -> None:
    raw = """
    {
      "assistant_reply": "Done",
      "actions": [
        {"tool": "extract_text", "reason": "Need data", "args": {"selector": "body"}}
      ]
    }
    """
    result = Planner.parse_plan(raw)
    assert result.assistant_reply == "Done"
    assert result.actions[0].tool == "extract_text"


def test_parse_plan_from_markdown_fence() -> None:
    raw = """```json
    {
      "assistant_reply": "OK",
      "actions": [{"tool": "done", "reason": "Finished", "args": {}}]
    }
    ```"""
    result = Planner.parse_plan(raw)
    assert result.actions[0].tool == "done"


def test_heuristic_finalize_answer_detects_dermatologist() -> None:
    answer = Planner._heuristic_finalize_answer(
        user_message="Есть ли в больнице дерматолог?",
        planner_reply="",
        execution_log=[
            "1. extract_text: extract_text body: Врач-дерматовенеролог Иванов Иван Иванович принимает по записи."
        ],
    )
    assert answer.startswith("Да")
    assert "Иванов Иван Иванович" in answer
