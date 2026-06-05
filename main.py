import asyncio
import os
import sys
from datetime import datetime

from dotenv import load_dotenv
from rich.console import Console

from claude import TranscriptBuffer, question_loop
from prompts import MeetingContext, build_system_prompt
from server import run_websocket_server
from ui import UIState, export_session, ui_refresh_loop

WS_PORT = int(os.getenv("EARBUD_WS_PORT", "8765"))


def gather_meeting_context() -> MeetingContext:
    console = Console()
    console.print("\n[bold cyan]EARBUD — Meeting Copilot[/bold cyan]")
    console.print("[dim]Press Ctrl+C at any time to cancel setup[/dim]\n")

    meeting_type = input("Meeting type (discovery/QBR/demo/status/other): ").strip() or "general"
    client_background = input("Client background (1-2 sentences): ").strip()
    user_goals = input("Your goals for this meeting: ").strip()
    topics = input("Topics to cover (comma-separated, or Enter to skip): ").strip()

    console.print(f"\n[green]Starting session...[/green]")
    console.print(f"[dim]Make sure the Chrome extension is loaded and you've joined the meeting.[/dim]\n")

    return MeetingContext(
        meeting_type=meeting_type,
        client_background=client_background,
        user_goals=user_goals,
        topics=topics,
        started_at=datetime.now(),
    )


def setup_keyboard(event_queue: asyncio.Queue, loop):
    try:
        import keyboard as kb

        def on_key(event):
            if event.name in ("p", "e", "q"):
                loop.call_soon_threadsafe(event_queue.put_nowait, event.name)

        kb.on_press(on_key)
        return True
    except Exception:
        return False


async def keyboard_handler(event_queue: asyncio.Queue, ui_state: UIState, ctx: MeetingContext):
    while True:
        key = await event_queue.get()
        if key == "p":
            ui_state.paused = not ui_state.paused
            ui_state.status = "Paused" if ui_state.paused else (
                "Listening..." if ui_state.connected else "Waiting for extension..."
            )
        elif key == "e":
            filename = export_session(ui_state, ctx)
            ui_state.status = f"Exported → {filename}"
        elif key == "q":
            raise SystemExit(0)


async def run_meeting(ctx: MeetingContext, system_prompt: str, event_queue: asyncio.Queue):
    transcript_buffer = TranscriptBuffer()
    ui_state = UIState(
        meeting_title=f"{ctx.meeting_type.title()} — {ctx.client_background[:40] if ctx.client_background else ''}",
        started_at=ctx.started_at,
    )

    # Wire transcript buffer → UI transcript lines
    original_append = transcript_buffer.append

    def append_and_display(speaker: str, text: str):
        original_append(speaker, text)
        prefix = f"[{speaker}]: " if speaker else ""
        ui_state.transcript_lines.append(f"{prefix}{text}")

    transcript_buffer.append = append_and_display

    await asyncio.gather(
        run_websocket_server(transcript_buffer, ui_state, port=WS_PORT),
        question_loop(transcript_buffer, ui_state, system_prompt),
        ui_refresh_loop(ui_state),
        keyboard_handler(event_queue, ui_state, ctx),
    )


def main():
    load_dotenv()
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY not set. Copy .env.example to .env and add your key.")
        sys.exit(1)

    try:
        ctx = gather_meeting_context()
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(0)

    system_prompt = build_system_prompt(ctx)
    loop = asyncio.new_event_loop()
    event_queue: asyncio.Queue = asyncio.Queue()

    kb_active = setup_keyboard(event_queue, loop)
    if not kb_active:
        print("[dim]Note: keyboard hotkeys unavailable. Use Ctrl+C to exit.[/dim]")

    ui_state_ref: list[UIState] = []

    try:
        loop.run_until_complete(run_meeting(ctx, system_prompt, event_queue))
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        loop.close()
        # Offer export if we have transcript data (best effort — ui_state may not be accessible here)
        # The user can also press E before quitting


if __name__ == "__main__":
    main()
