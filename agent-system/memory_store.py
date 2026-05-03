import json
import os
from config import MEMORY_FILE

def load_memory():
    if not os.path.exists(MEMORY_FILE):
        return {"version": "1.0", "history": []}
    with open(MEMORY_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

def save_memory(memory):
    with open(MEMORY_FILE, "w", encoding="utf-8") as f:
        json.dump(memory, f, indent=2, ensure_ascii=False)

def append_memory(entry):
    memory = load_memory()
    memory.setdefault("history", []).append(entry)
    save_memory(memory)
