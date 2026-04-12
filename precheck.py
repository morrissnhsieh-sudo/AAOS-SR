import os

base = r"c:\Users\User\Code\AAOS"
dirs = [
    "src/auth", "src/tools", "src/plugins", "src/memory", "src/skills",
    "src/acp", "src/mcp", "src/nodes", "src/agent", "src/channel", "src/heartbeat",
    "tests/auth", "tests/tools", "tests/plugins", "tests/memory", "tests/skills",
    "tests/acp", "tests/mcp", "tests/nodes", "tests/agent", "tests/channel", "tests/heartbeat",
]

for d in dirs:
    os.makedirs(os.path.join(base, d), exist_ok=True)
