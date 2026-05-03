import argparse
import os
from datetime import datetime

from memory_store import append_memory
from rag import add_memory

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True, help="Caminho do .md gerado")
    parser.add_argument("--problem", required=True, help="Resumo curto do problema")
    parser.add_argument("--result", default="plan_generated", help="Estado inicial")
    args = parser.parse_args()

    file_path = args.file
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Arquivo não encontrado: {file_path}")

    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    entry = {
        "timestamp": datetime.now().isoformat(),
        "type": "plan_generated",
        "problem": args.problem,
        "file": os.path.basename(file_path),
        "result": args.result
    }
    append_memory(entry)

    doc = f"""Problema: {args.problem}

Arquivo: {os.path.basename(file_path)}

Resultado: {args.result}

Conteúdo do plano:
{content[:12000]}
"""
    add_memory(doc, {"type": "plan_generated", "result": args.result})

    print("Plano registrado com sucesso.")
    print(file_path)

if __name__ == "__main__":
    main()
