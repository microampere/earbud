import asyncio
import json
import websockets
from websockets.server import WebSocketServerProtocol


async def run_websocket_server(transcript_buffer, ui_state, host="localhost", port=8765):
    async def handler(websocket: WebSocketServerProtocol):
        ui_state.connected = True
        ui_state.status = "Extension connected"
        try:
            async for raw in websocket:
                try:
                    segment = json.loads(raw)
                    # Expected: { "speaker": "...", "text": "...", "timestamp": "..." }
                    speaker = segment.get("speaker", "")
                    text = segment.get("text", "").strip()
                    if text:
                        transcript_buffer.append(speaker, text)
                        ui_state.segment_count += 1
                except (json.JSONDecodeError, KeyError):
                    pass  # malformed segment — skip
        except websockets.exceptions.ConnectionClosedOK:
            pass
        except websockets.exceptions.ConnectionClosedError:
            pass
        finally:
            ui_state.connected = False
            ui_state.status = "Waiting for extension..."

    ui_state.status = "Waiting for extension..."
    async with websockets.serve(handler, host, port):
        await asyncio.Future()  # run forever
