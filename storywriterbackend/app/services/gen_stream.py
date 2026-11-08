"""Shared pieces of the reply streams (Roleplay Chat and Adventure).

The browser reads these as SSE. Each generation runs as a background task that
outlives the browser's connection (the phone locking just closes the socket),
writes chunks and event dicts to an asyncio.Queue, and ends with None.
"""
import asyncio
import json
import re

# The browser treats 45 s without a byte as a dropped connection and fetches
# the finished reply instead. A reply can go quiet for longer than that while
# the model reasons or a follow-up call runs, so send an SSE comment every
# 15 s; the browser's parser skips anything that isn't a `data:` line.
SSE_HEARTBEAT_SECONDS = 15
SSE_PING = object()


async def next_or_ping(queue):
    try:
        return await asyncio.wait_for(queue.get(), timeout=SSE_HEARTBEAT_SECONDS)
    except asyncio.TimeoutError:
        return SSE_PING


async def sse_from_queue(queue):
    """Turn a generation queue into SSE: str items are chunks, dicts are
    events, an Exception is sent as an error, None ends the stream."""
    try:
        while True:
            item = await next_or_ping(queue)
            if item is SSE_PING:
                yield ": ping\n\n"
                continue
            if item is None:
                break
            if isinstance(item, Exception):
                yield f"data: {json.dumps({'type': 'error', 'message': str(item)})}\n\n"
                break
            if isinstance(item, dict):
                yield f"data: {json.dumps(item)}\n\n"
                continue
            yield f"data: {json.dumps({'type': 'chunk', 'content': item})}\n\n"
        yield f"data: {json.dumps({'type': 'done'})}\n\n"
    except asyncio.CancelledError:
        # The browser went away (phone locked); the generation task carries on.
        pass


def close_open_think(text: str) -> str:
    """A reply cut off inside its reasoning has an unclosed <think>; close it so
    history stripping removes the block instead of feeding raw planning back."""
    if "<think>" in text and "</think>" not in text:
        return text.rstrip() + "\n</think>\n"
    return text


def trim_cut_reply(text: str) -> str:
    """Cut a reply that hit max_tokens back to its last sentence end, keeping
    the think block. Left alone if that would drop more than half the prose."""
    head, sep, prose = text.rpartition("</think>")
    if not sep:
        head, prose = "", text
    ends = [m.end() for m in re.finditer(r'[.!?…]["”’)\]*_]*(?=\s|$)', prose)]
    if ends and ends[-1] >= len(prose) * 0.5:
        return head + sep + prose[:ends[-1]].rstrip()
    return text
