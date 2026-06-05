import asyncio
import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from rich.console import Console
from rich.layout import Layout
from rich.live import Live
from rich.panel import Panel
from rich.text import Text


@dataclass
class UIState:
    transcript_lines: list[str] = field(default_factory=list)
    suggestion_lines: list[str] = field(default_factory=list)
    status: str = "Starting..."
    connected: bool = False
    paused: bool = False
    segment_count: int = 0
    started_at: datetime = field(default_factory=datetime.now)
    meeting_title: str = ""


def _elapsed(started_at: datetime) -> str:
    delta = datetime.now() - started_at
    total = int(delta.total_seconds())
    return f"{total // 60:02d}:{total % 60:02d}"


def _make_layout() -> Layout:
    layout = Layout(name="root")
    layout.split_column(
        Layout(name="header", size=3),
        Layout(name="body"),
        Layout(name="footer", size=3),
    )
    layout["body"].split_row(
        Layout(name="transcript"),
        Layout(name="suggestions"),
    )
    return layout


def _render_header(ui_state: UIState) -> Panel:
    conn_indicator = "[bold green]● LIVE[/bold green]" if ui_state.connected else "[bold red]○ WAITING[/bold red]"
    paused = "  [bold yellow]⏸ PAUSED[/bold yellow]" if ui_state.paused else ""
    title = f"[bold cyan]EARBUD[/bold cyan]  │  {ui_state.meeting_title}  │  {conn_indicator}{paused}"
    elapsed = _elapsed(ui_state.started_at)
    status_line = f"[dim]{ui_state.status}[/dim]  │  [dim]{elapsed}[/dim]  │  [dim]{ui_state.segment_count} segments[/dim]"
    content = Text.from_markup(f"{title}\n{status_line}")
    return Panel(content, style="on black", border_style="dim")


def _render_transcript(lines: list[str]) -> Panel:
    visible = lines[-60:]
    text = Text()
    for line in visible:
        if line.startswith("[") and "]: " in line:
            bracket_end = line.index("]: ") + 1
            speaker = line[: bracket_end + 1]
            rest = line[bracket_end + 1 :]
            text.append(speaker, style="bold blue")
            text.append(rest + "\n", style="white")
        else:
            text.append(line + "\n", style="white")
    return Panel(text, title="[bold cyan]TRANSCRIPT[/bold cyan]", border_style="cyan")


def _render_suggestions(lines: list[str]) -> Panel:
    visible = lines[-30:]
    text = Text()
    for line in visible:
        text.append(line + "\n", style="bold yellow")
    if not visible:
        text.append("Waiting for conversation...", style="dim italic")
    return Panel(text, title="[bold yellow]SUGGESTED QUESTIONS[/bold yellow]", border_style="yellow")


def _render_footer(ui_state: UIState) -> Panel:
    controls = "[dim][P][/dim] Pause  [dim][E][/dim] Export  [dim][Q][/dim] Quit"
    content = Text.from_markup(controls)
    return Panel(content, style="on black", border_style="dim")


async def ui_refresh_loop(ui_state: UIState):
    layout = _make_layout()
    console = Console()
    with Live(layout, console=console, refresh_per_second=10, screen=True):
        while True:
            layout["header"].update(_render_header(ui_state))
            layout["transcript"].update(_render_transcript(ui_state.transcript_lines))
            layout["suggestions"].update(_render_suggestions(ui_state.suggestion_lines))
            layout["footer"].update(_render_footer(ui_state))
            await asyncio.sleep(0.1)


def export_session(ui_state: UIState, ctx) -> str:
    os.makedirs("exports", exist_ok=True)
    slug = ctx.meeting_type.lower().replace(" ", "-")[:20] if ctx.meeting_type else "meeting"
    filename = f"exports/earbud_{ctx.started_at.strftime('%Y-%m-%d_%H%M')}_{slug}.txt"

    elapsed = _elapsed(ctx.started_at)
    lines = [
        "EARBUD SESSION EXPORT",
        "=" * 40,
        f"Date:      {ctx.started_at.strftime('%Y-%m-%d %H:%M')}",
        f"Duration:  {elapsed}",
        f"Meeting:   {ctx.meeting_type}",
        "",
        "CONTEXT",
        "-" * 40,
        f"Type:      {ctx.meeting_type}",
        f"Client:    {ctx.client_background}",
        f"Goals:     {ctx.user_goals}",
        f"Topics:    {ctx.topics}",
        "",
        "TRANSCRIPT",
        "-" * 40,
        *ui_state.transcript_lines,
        "",
        "SUGGESTED QUESTIONS",
        "-" * 40,
        *ui_state.suggestion_lines,
        "",
    ]

    with open(filename, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    return filename
