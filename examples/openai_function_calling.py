# /// script
# requires-python = ">=3.11"
# dependencies = ["openai>=1.40", "requests>=2.31"]
# ///
"""
TeamBrain × OpenAI function calling
===================================

Exposes two TeamBrain REST endpoints as OpenAI tools and lets the model
decide when to call them, then executes the calls against the live REST
surface and feeds results back. Demonstrates that the same backend that
serves MCP clients is reachable by an OpenAI function-calling agent with
nothing more than the published OpenAPI contract.

Run (uv resolves the inline deps automatically):

    export OPENAI_API_KEY=sk-...
    export TEAMBRAIN_JWT='<access token from https://pr.fabric-testbed.net/>'
    uv run examples/openai_function_calling.py "what conventions have we set for timestamps?"

Optional env:
    TEAMBRAIN_BASE          default https://pr.fabric-testbed.net/functions/v1
    TEAMBRAIN_PROJECT_SLUG  default fabric-testbed/TeamBrain
    OPENAI_MODEL            default gpt-4o-mini
"""

import json
import os
import sys

import requests
from openai import OpenAI

BASE = os.environ.get("TEAMBRAIN_BASE", "https://pr.fabric-testbed.net/functions/v1")
PROJECT_SLUG = os.environ.get("TEAMBRAIN_PROJECT_SLUG", "fabric-testbed/TeamBrain")
MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
JWT = os.environ["TEAMBRAIN_JWT"]  # raises KeyError early if unset


# --- TeamBrain REST calls ---------------------------------------------------

def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {JWT}", "Content-Type": "application/json"}


def search_project_thoughts(query: str, limit: int = 5, threshold: float = 0.3) -> dict:
    r = requests.post(
        f"{BASE}/teambrain-rest/thoughts/search",
        headers=_headers(),
        json={"query": query, "project_slug": PROJECT_SLUG, "limit": limit, "threshold": threshold},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def capture_project_thought(content: str, type: str | None = None, tags: list[str] | None = None) -> dict:
    body = {"content": content, "scope": "project", "project_slug": PROJECT_SLUG, "tags": tags or []}
    if type:
        body["type"] = type
    r = requests.post(f"{BASE}/teambrain-rest/thoughts", headers=_headers(), json=body, timeout=30)
    r.raise_for_status()
    return r.json()


# Map tool name → python callable.
DISPATCH = {
    "search_project_thoughts": search_project_thoughts,
    "capture_project_thought": capture_project_thought,
}

# --- OpenAI tool definitions (subset of the OpenAPI request schemas) --------

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_project_thoughts",
            "description": (
                "Semantic search over the team's shared memory (TeamBrain). "
                "Call this before answering a question that may have been decided "
                "before, to avoid repeating prior discussion."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Natural-language search query."},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 5},
                    "threshold": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.3},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "capture_project_thought",
            "description": (
                "Capture a durable team memory (decision, convention, gotcha, etc.) "
                "into TeamBrain so future agents and teammates can find it."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "The memory text. Markdown OK."},
                    "type": {
                        "type": "string",
                        "enum": ["decision", "convention", "gotcha", "context", "preference", "runbook"],
                    },
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["content"],
            },
        },
    },
]


def main() -> None:
    user_prompt = " ".join(sys.argv[1:]) or "What conventions have we set for timestamps?"
    client = OpenAI()

    messages = [
        {
            "role": "system",
            "content": (
                "You are a developer assistant for the TeamBrain project. Use the "
                "TeamBrain tools to ground your answers in the team's shared memory. "
                "Search before asserting; cite what you find."
            ),
        },
        {"role": "user", "content": user_prompt},
    ]

    # Tool-call loop: keep going until the model returns a plain answer.
    for _ in range(5):
        resp = client.chat.completions.create(model=MODEL, messages=messages, tools=TOOLS)
        msg = resp.choices[0].message
        messages.append(msg)

        if not msg.tool_calls:
            print("\n=== assistant ===\n" + (msg.content or ""))
            return

        for call in msg.tool_calls:
            args = json.loads(call.function.arguments or "{}")
            print(f"\n→ tool call: {call.function.name}({json.dumps(args)})")
            try:
                result = DISPATCH[call.function.name](**args)
            except Exception as e:  # surface tool errors back to the model
                result = {"error": str(e)}
            messages.append({
                "role": "tool",
                "tool_call_id": call.id,
                "content": json.dumps(result),
            })

    print("Stopped after 5 tool-call rounds without a final answer.", file=sys.stderr)


if __name__ == "__main__":
    main()
