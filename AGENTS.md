# AGENTS.md

## Objetivo
Ajude no projeto TCloud de forma direta, evitando gerar arquivos, planos longos ou memória automática quando não for necessário.

## Regras gerais
- Responda no chat por padrão.
- Só crie plano em `.md` quando o usuário pedir explicitamente.
- Só use `agent-system/PLAN_TEMPLATE.md` quando o usuário pedir um plano formal.
- Só registre memória com `register_plan.py` quando o usuário pedir explicitamente.
- Antes de alterar código, leia apenas os arquivos diretamente relacionados ao problema.
- Evite respostas genéricas; seja objetivo e prático.

## Planos formais
Quando o usuário pedir explicitamente um plano formal:
1. Leia `agent-system/PLAN_TEMPLATE.md`.
2. Crie um único arquivo em `agent-system/final_md/`.
3. Use nome no formato `plano_<assunto_curto>.md`.
4. Inclua objetivo, arquivos envolvidos, passos, validação, riscos e fallback.
5. Só execute `register_plan.py` se o usuário pedir memória.

## Backups
- Crie backup apenas para mudanças grandes, arriscadas ou quando o usuário pedir.
- Para mudanças pequenas e localizadas, explique os arquivos alterados no final.

## Resposta final
Informe:
- o que foi alterado;
- os arquivos tocados;
- como validar.