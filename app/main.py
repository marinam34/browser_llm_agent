from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.agent.extension_orchestrator import ExtensionSessionManager
from app.agent.safety import SafetyGuard
from app.config import settings
from app.llm.planner import Planner
from app.models import (
    ExtensionChatStartRequest,
    ExtensionChatStartResponse,
    ExtensionChatTurnRequest,
    ExtensionChatTurnResponse,
    ExtensionFinalizeRequest,
    ExtensionFinalizeResponse,
    ExtensionPlanRequest,
    ExtensionPlanResponse,
    ExtensionSafetyValidateRequest,
    SafetyDecision,
)

ROOT_DIR = Path(__file__).resolve().parent.parent
WIDGET_DIR = ROOT_DIR / "widget"

app = FastAPI(
    title="Universal Browser LLM Agent",
    description="Widget/extension backend for DOM-based browser assistant with LLM planning and safety guards.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=WIDGET_DIR), name="static")

planner = Planner()
extension_safety_guard = SafetyGuard(allow_final_actions=settings.allow_final_actions)
extension_sessions = ExtensionSessionManager(planner=planner, safety_guard=extension_safety_guard)


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await planner.close()


@app.get("/")
async def index() -> dict[str, str]:
    return {"status": "ok", "mode": "widget-extension-only"}


@app.get("/widget.js")
async def widget_loader() -> FileResponse:
    return FileResponse(WIDGET_DIR / "widget.js")


@app.get("/embed/chat")
async def embed_chat() -> FileResponse:
    return FileResponse(WIDGET_DIR / "chat.html")


@app.post("/api/extension/chat/start", response_model=ExtensionChatStartResponse)
async def extension_chat_start(_payload: ExtensionChatStartRequest) -> ExtensionChatStartResponse:
    session = extension_sessions.create_session()
    return ExtensionChatStartResponse(session_id=session.session_id)


@app.post("/api/extension/chat/turn", response_model=ExtensionChatTurnResponse)
async def extension_chat_turn(payload: ExtensionChatTurnRequest) -> ExtensionChatTurnResponse:
    session = extension_sessions.get(payload.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    return await extension_sessions.handle_turn(
        session=session,
        snapshot=payload.snapshot,
        message=payload.message,
        control=payload.control,
        observations=payload.observations,
    )


@app.post("/api/extension/plan", response_model=ExtensionPlanResponse)
async def extension_plan(payload: ExtensionPlanRequest) -> ExtensionPlanResponse:
    user_message = payload.user_message.strip()
    if not user_message:
        raise HTTPException(status_code=400, detail="Message must be non-empty")

    plan = await planner.plan(
        user_message=user_message,
        history=payload.history,
        snapshot=payload.snapshot,
    )
    return ExtensionPlanResponse(
        assistant_reply=plan.assistant_reply,
        actions=plan.actions,
    )


@app.post("/api/extension/finalize", response_model=ExtensionFinalizeResponse)
async def extension_finalize(payload: ExtensionFinalizeRequest) -> ExtensionFinalizeResponse:
    user_message = payload.user_message.strip()
    if not user_message:
        raise HTTPException(status_code=400, detail="Message must be non-empty")

    assistant_message = await planner.finalize_answer(
        user_message=user_message,
        planner_reply=payload.planner_reply,
        execution_log=payload.execution_log,
        snapshot=payload.snapshot,
    )
    return ExtensionFinalizeResponse(assistant_message=assistant_message)


@app.post("/api/extension/safety/validate", response_model=SafetyDecision)
async def extension_validate_action(payload: ExtensionSafetyValidateRequest) -> SafetyDecision:
    return extension_safety_guard.validate(
        action=payload.action,
        element_meta=payload.element_meta,
    )


def run() -> None:
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )


if __name__ == "__main__":
    run()
