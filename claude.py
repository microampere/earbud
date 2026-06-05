import asyncio
import os
import time

import anthropic

DEFAULT_MODEL = "claude-haiku-4-5-20251001"
TRIGGER_WORDS = int(os.getenv("EARBUD_TRIGGER_WORDS", "50"))
TRIGGER_SECS = int(os.getenv("EARBUD_TRIGGER_SECS", "30"))
WINDOW_SEGMENTS = 30  # how many recent segments to send to Claude


class TranscriptBuffer:
    def __init__(self):
        self._segments: list[dict] = []
        self._words_since_last_call: int = 0
        self._last_call_time: float = time.monotonic()

    def append(self, speaker: str, text: str):
        self._segments.append({"speaker": speaker, "text": text, "ts": time.monotonic()})
        self._words_since_last_call += len(text.split())

    def should_trigger(self) -> bool:
        if not self._segments:
            return False
        elapsed = time.monotonic() - self._last_call_time
        return self._words_since_last_call >= TRIGGER_WORDS or elapsed >= TRIGGER_SECS

    def reset_counter(self):
        self._words_since_last_call = 0
        self._last_call_time = time.monotonic()

    def get_window(self) -> str:
        recent = self._segments[-WINDOW_SEGMENTS:]
        lines = []
        for seg in recent:
            prefix = f"[{seg['speaker']}]: " if seg["speaker"] else ""
            lines.append(f"{prefix}{seg['text']}")
        return "\n".join(lines)

    def get_full_transcript(self) -> list[dict]:
        return list(self._segments)


async def generate_questions(
    window: str,
    system_prompt: str,
    model: str | None = None,
) -> list[str]:
    model = model or os.getenv("EARBUD_MODEL", DEFAULT_MODEL)
    client = anthropic.AsyncAnthropic()

    user_message = f"Here is the recent meeting transcript:\n\n{window}"

    try:
        response = await client.messages.create(
            model=model,
            max_tokens=512,
            system=system_prompt,
            messages=[{"role": "user", "content": user_message}],
        )
        text = response.content[0].text if response.content else ""
        questions = [
            line.strip()
            for line in text.splitlines()
            if line.strip().startswith("→")
        ]
        return questions
    except Exception as e:
        return [f"→ [Claude error: {e}]"]


async def question_loop(transcript_buffer: TranscriptBuffer, ui_state, system_prompt: str):
    while True:
        await asyncio.sleep(5)
        if ui_state.paused:
            continue
        if transcript_buffer.should_trigger():
            window = transcript_buffer.get_window()
            transcript_buffer.reset_counter()
            ui_state.status = "Thinking..."
            questions = await generate_questions(window, system_prompt)
            if questions:
                ui_state.suggestion_lines.extend(questions)
            ui_state.status = "Listening..." if ui_state.connected else "Waiting for extension..."
