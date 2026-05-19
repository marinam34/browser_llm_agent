from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


ToolName = Literal[
    "navigate",
    "click",
    "type",
    "press",
    "wait_for",
    "extract_text",
    "done",
    "ask_user",
]


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class ToolAction(BaseModel):
    tool: ToolName
    reason: str = ""
    args: dict[str, Any] = Field(default_factory=dict)


class PlanResult(BaseModel):
    assistant_reply: str
    actions: list[ToolAction] = Field(default_factory=list)


class SafetyDecision(BaseModel):
    allowed: bool
    reason: str
    code: Literal["ok", "final_action_blocked", "invalid_url_scheme", "blocked"] = "ok"


class ExtensionPlanRequest(BaseModel):
    user_message: str
    history: list[ChatMessage] = Field(default_factory=list)
    snapshot: dict[str, Any] = Field(default_factory=dict)
    site_id: str | None = None


class ExtensionPlanResponse(BaseModel):
    assistant_reply: str
    actions: list[ToolAction] = Field(default_factory=list)


class ExtensionFinalizeRequest(BaseModel):
    user_message: str
    planner_reply: str = ""
    execution_log: list[str] = Field(default_factory=list)
    snapshot: dict[str, Any] = Field(default_factory=dict)
    site_id: str | None = None


class ExtensionFinalizeResponse(BaseModel):
    assistant_message: str


class ExtensionSafetyValidateRequest(BaseModel):
    action: ToolAction
    element_meta: dict[str, Any] | None = None


class ExtensionChatStartRequest(BaseModel):
    site_id: str | None = None


class ExtensionChatStartResponse(BaseModel):
    session_id: str


class ExtensionChatTurnRequest(BaseModel):
    session_id: str
    message: str | None = None
    control: str | None = None
    snapshot: dict[str, Any] = Field(default_factory=dict)
    observations: list[str] = Field(default_factory=list)


class ExtensionChatTurnResponse(BaseModel):
    assistant_message: str = ""
    actions: list[ToolAction] = Field(default_factory=list)
    awaiting_confirmation: bool = False
    pending_action_label: str | None = None
    done: bool = True
