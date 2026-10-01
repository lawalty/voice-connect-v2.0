#!/usr/bin/env python3
"""Verify real Library result payloads in an isolated native QA conversation.

OpenClaw can record isError=false even when a plugin returned error text.
Require valid, nonempty Library JSON, not just tool calls or outer status flags.
Run on the VC host with its Python 3.14 runtime after an isolated QA turn.
"""
import argparse
import json
from pathlib import Path
import re
import sqlite3


def library_data(message):
    name = message.get("toolName", "")
    if name not in {"vc_library_groups", "vc_library_documents", "vc_library_search"}:
        return None
    assert not message.get("isError"), name + " failed"
    text = [p["text"] for p in message.get("content", []) if p.get("type") == "text"]
    assert len(text) == 1, name + " returned an unexpected payload"
    try:
        value = json.loads(text[0])
    except (ValueError, TypeError):
        raise AssertionError(name + " returned non-JSON text instead of Library data") from None
    if name == "vc_library_search":
        assert isinstance(value, dict) and isinstance(value.get("hits"), list) and value["hits"], "Search returned no source passages"
        assert all(hit.get("document_id") and hit.get("content") and isinstance(hit.get("chunk_index"), int) for hit in value["hits"]), "Search result lacks source evidence"
    else:
        assert isinstance(value, list) and value, name + " returned no items"
        required = "slug" if name == "vc_library_groups" else "filename"
        assert all(isinstance(item, dict) and item.get("id") and item.get(required) for item in value), name + " returned invalid items"
    return value


def main():
    from compression import zstd
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("conversation")
    parser.add_argument("--document", help="Require this document in listing and retrieved passages")
    args = parser.parse_args()
    assert re.fullmatch(r"[a-f0-9-]{36}", args.conversation)
    with sqlite3.connect("file:/opt/voice-connect-v2/state/voice-connect.sqlite?mode=ro", uri=True) as db:
        row = db.execute("select session_key,session_id from conversations where id=?", (args.conversation,)).fetchone()
    assert row and row[1], "Native session is missing"
    agent = row[0].split(":")[1]
    assert re.fullmatch(r"[A-Za-z0-9_-]+", agent)
    path = Path("/root/.openclaw/agents") / agent / "agent/openclaw-agent.sqlite"
    with sqlite3.connect("file:" + str(path) + "?mode=ro", uri=True) as db:
        events = db.execute("select event_json,event_zstd from transcript_events where session_id=? order by seq", (row[1],)).fetchall()
    counts, listed, retrieved = {}, set(), set()
    for plain, compressed in events:
        event = json.loads(plain if plain is not None else zstd.decompress(compressed).decode())
        message = event.get("message", {})
        if message.get("role") != "toolResult":
            continue
        data = library_data(message)
        if data is None:
            continue
        name = message["toolName"]
        counts[name] = counts.get(name, 0) + 1
        if name == "vc_library_documents":
            listed.update(item["id"] for item in data)
        if name == "vc_library_search":
            retrieved.update(item["document_id"] for item in data["hits"])
    assert set(counts) == {"vc_library_groups", "vc_library_documents", "vc_library_search"}, "Required Library tools were not proven"
    if args.document:
        assert args.document in listed and args.document in retrieved, "Requested document was not both listed and retrieved"
    print(json.dumps({"verified_payloads": counts, "listed_documents": len(listed), "retrieved_documents": len(retrieved), "requested_document_verified": bool(args.document)}))


if __name__ == "__main__":
    main()
