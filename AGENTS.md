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

## Regra global de backup antes de edição
- Antes de editar qualquer arquivo do projeto, crie uma cópia de segurança do estado atual.
- Salve o backup dentro de `deploy/` com nome descritivo e timestamp, por exemplo:
  - `deploy/backup_pre_<assunto>_YYYYMMDD_HHMMSS/`
- Copie para esse diretório todos os arquivos que serão alterados na tarefa.
- Depois de criar o backup, não edite o conteúdo desse backup.
- Essa regra vale para qualquer tarefa com modificação de arquivo, mesmo quando o usuário não pedir explicitamente.

## Se o usuário trouxer resultado da execução
Se o usuário disser o que aconteceu depois de executar o plano, registre com:
`cd agent-system && ./.venv/bin/python archive_feedback.py --file "../agent-system/final_md/NOME_DO_ARQUIVO.md" --execution_result "RESULTADO" --lessons "LIÇÕES"`

## Regras de escrita
- não seja genérico
- não responda só no chat se a tarefa pedir plano
- a entrega principal deve ser o arquivo `.md`
- inclua fallback, validação e riscos
