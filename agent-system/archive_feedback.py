import argparse
import os
from datetime import datetime

from memory_store import append_memory
from rag import add_memory

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    parser.add_argument("--execution_result", required=True)
    parser.add_argument("--lessons", required=True)
    args = parser.parse_args()

    if not os.path.exists(args.file):
        raise FileNotFoundError(f"Arquivo não encontrado: {args.file}")

    with open(args.file, "r", encoding="utf-8") as f:
        content = f.read()

    entry = {
        "timestamp": datetime.now().isoformat(),
        "type": "execution_feedback",
        "file": os.path.basename(args.file),
        "execution_result": args.execution_result,
        "lessons": args.lessons
    }
    append_memory(entry)

    doc = f"""Arquivo: {os.path.basename(args.file)}
Resultado da execução: {args.execution_result}
Lições aprendidas: {args.lessons}

Conteúdo:
{content[:12000]}
"""
    add_memory(doc, {"type": "execution_feedback", "execution_result": args.execution_result})

    print("Feedback registrado com sucesso.")

if __name__ == "__main__":
    main()
