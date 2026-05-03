#!/bin/bash
set -e

PROJECT_DIR="$(pwd)"
AGENT_DIR="$PROJECT_DIR/agent-system"

echo "=============================================="
echo "  Setup final: Codex gera .md e alimenta memória"
echo "=============================================="

mkdir -p "$AGENT_DIR/output"
mkdir -p "$AGENT_DIR/final_md"
mkdir -p "$AGENT_DIR/vector_store"

cat > "$AGENT_DIR/requirements.txt" <<'EOF'
chromadb
python-dotenv
EOF

cat > "$AGENT_DIR/.env.example" <<'EOF'
# opcional para uso futuro
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4
EOF

cat > "$AGENT_DIR/memory.json" <<'EOF'
{
  "version": "1.0",
  "history": []
}
EOF

cat > "$AGENT_DIR/config.py" <<'EOF'
import os
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MEMORY_FILE = os.path.join(BASE_DIR, "memory.json")
VECTOR_DIR = os.path.join(BASE_DIR, "vector_store")
FINAL_MD_DIR = os.path.join(BASE_DIR, "final_md")
EOF

cat > "$AGENT_DIR/rag.py" <<'EOF'
import chromadb
from config import VECTOR_DIR

client = chromadb.PersistentClient(path=VECTOR_DIR)
collection = client.get_or_create_collection(name="agent_memory")

def add_memory(document, metadata):
    doc_id = str(abs(hash(document + str(metadata))))
    collection.upsert(
        ids=[doc_id],
        documents=[document],
        metadatas=[metadata]
    )

def search_memory(query, n_results=5):
    try:
        results = collection.query(query_texts=[query], n_results=n_results)
        docs = results.get("documents", [])
        if docs and len(docs) > 0:
            return docs[0]
        return []
    except Exception:
        return []
EOF

cat > "$AGENT_DIR/memory_store.py" <<'EOF'
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
EOF

cat > "$AGENT_DIR/register_plan.py" <<'EOF'
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
EOF

cat > "$AGENT_DIR/archive_feedback.py" <<'EOF'
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
EOF

cat > "$AGENT_DIR/PLAN_TEMPLATE.md" <<'EOF'
# 📌 RESUMO EXECUTIVO

# 🧠 CONTEXTO INTERPRETADO

# 🎯 OBJETIVO FINAL

# 🧠 INSIGHTS DO HISTÓRICO (RAG)

# 🧠 ESTRATÉGIA GLOBAL

# 🗺️ PLANO ESTRUTURADO

# 🛠️ EXECUÇÃO DETALHADA

# 🔗 USO DE TOOLS NO ANTIGRAVITY

# 🔍 VALIDAÇÃO

# 🚨 RISCOS E MITIGAÇÕES

# 📊 SCORE DE QUALIDADE

# 🧠 CONFIANÇA DO MODELO

# 🧬 MEMÓRIA GERADA
EOF

cat > "$PROJECT_DIR/AGENTS.md" <<'EOF'
# AGENTS.md

## Objetivo
Quando o usuário pedir um plano, diagnóstico, arquitetura, correção, implementação ou estratégia para este projeto, gere um arquivo `.md` completo e alimente a memória do sistema automaticamente.

## Arquivos obrigatórios
- Template do plano: `agent-system/PLAN_TEMPLATE.md`
- Saída final: `agent-system/final_md/`
- Registro de memória: `agent-system/register_plan.py`
- Histórico local: `agent-system/memory.json`

## Instruções obrigatórias para Codex
1. Leia `agent-system/PLAN_TEMPLATE.md` antes de criar qualquer plano.
2. Crie sempre um único arquivo `.md` em `agent-system/final_md/`.
3. Nome do arquivo:
   - `plano_<assunto_curto>.md`
   - use snake_case
4. O conteúdo deve seguir a estrutura do template e ser completo.
5. Considere prints, logs e arquivos anexados pelo usuário.
6. Se existirem arquivos relevantes no projeto, leia-os antes de escrever o plano.
7. Após salvar o `.md`, execute este comando para alimentar a memória:
   - `cd agent-system && ./.venv/bin/python register_plan.py --file "../agent-system/final_md/NOME_DO_ARQUIVO.md" --problem "RESUMO_CURTO_DO_PROBLEMA"`
8. No final da resposta ao usuário:
   - informe o caminho do `.md` criado
   - informe que a memória foi atualizada

## Se o usuário trouxer resultado da execução
Se o usuário disser o que aconteceu depois de executar o plano, registre com:
`cd agent-system && ./.venv/bin/python archive_feedback.py --file "../agent-system/final_md/NOME_DO_ARQUIVO.md" --execution_result "RESULTADO" --lessons "LIÇÕES"`

## Regras de escrita
- não seja genérico
- não responda só no chat se a tarefa pedir plano
- a entrega principal deve ser o arquivo `.md`
- inclua fallback, validação e riscos
EOF

cat > "$AGENT_DIR/README_USO.md" <<'EOF'
# Como usar

## Primeira vez
1. Rode `./setup.sh`
2. Entre em `agent-system`
3. Ative o ambiente se quiser verificar manualmente:
   - `source .venv/bin/activate`

## Depois
No Codex, basta pedir o problema e anexar prints/logs.
O AGENTS.md instruirá o Codex a:
- criar o .md em `agent-system/final_md/`
- registrar o plano na memória
EOF

cd "$AGENT_DIR"
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo ""
echo "✅ Setup concluído."
echo "Arquivos criados:"
echo "- AGENTS.md"
echo "- agent-system/PLAN_TEMPLATE.md"
echo "- agent-system/register_plan.py"
echo "- agent-system/archive_feedback.py"
echo "- agent-system/memory.json"
echo ""
echo "Próximo passo:"
echo "1. Abra o Codex nesta pasta do projeto"
echo "2. Descreva o problema e anexe prints/logs"
echo "3. O Codex deve gerar o .md em agent-system/final_md/ e registrar na memória"