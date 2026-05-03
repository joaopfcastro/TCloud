Use este template como guia obrigatório para qualquer plano, diagnóstico, correção, arquitetura, implementação ou estratégia deste projeto.

Regras globais obrigatórias:
- Mantenha exatamente os títulos principais abaixo.
- Ao gerar um plano real, substitua as instruções desta folha por conteúdo final específico do caso.
- Não escreva genericamente: cite arquivos, funções, componentes, endpoints, tipos, fluxos, estados e evidências reais sempre que existirem.
- Diferencie claramente o que foi observado no código, o que é inferência forte e o que ainda precisa validar.
- Toda proposta de mudança deve deixar explícitos: motivação, local da mudança, efeito esperado, risco principal, fallback e, quando fizer sentido, rollback.
- Feche decisões. O implementador não deve precisar adivinhar contratos, ordem de execução, critérios de aceite ou pontos de validação.
- Quando houver impacto em interface pública, cite explicitamente: API HTTP, schema, props, tipos, eventos, armazenamento, contrato nativo, comportamento visível ou compatibilidade.
- Não use placeholders vagos como "ajustar backend/frontend se necessário" ou "revisar depois".
- Sempre inclua validação, riscos e mitigação. Se o risco for moderado/alto, inclua também plano de rollback.

# 📌 RESUMO EXECUTIVO

Objetivo da seção:
- Resumir o problema e a direção da solução em 1 a 4 parágrafos curtos, com leitura rápida para quem precisa entender a decisão antes de entrar no detalhe.

Perguntas obrigatórias:
- Qual é o problema principal em uma frase?
- Qual é a causa raiz mais provável com base nas evidências disponíveis?
- Qual é o impacto real para o usuário, negócio ou operação?
- Qual é a direção da correção ou implementação proposta?

Formato recomendado:
- Parágrafo 1: problema + impacto.
- Parágrafo 2: causa raiz ou explicação técnica central.
- Parágrafo 3: direção da solução e por que ela é a escolha correta.

Alertas:
- Não transformar esta seção em lista de tarefas.
- Não repetir o pedido do usuário sem interpretar tecnicamente.
- Não afirmar causa raiz sem dizer em que evidência ela se apoia.

# 🧠 CONTEXTO INTERPRETADO

Objetivo da seção:
- Mostrar que o pedido foi entendido com base em fatos e que o plano parte do estado real do projeto, não de suposição abstrata.

Perguntas obrigatórias:
- O que exatamente o usuário pediu?
- Quais prints, logs, erros, sintomas ou anexos foram considerados?
- Quais arquivos, módulos, scripts ou planos anteriores foram lidos antes de concluir?
- Quais constatações objetivas foram encontradas no código?

Formato recomendado:
- Pedido do usuário.
- Evidências recebidas.
- Arquivos relevantes lidos.
- Constatações objetivas do código.

Alertas:
- Cite caminhos reais quando eles existirem.
- Separe fato observado de interpretação.
- Se houver lacunas, diga explicitamente o que ainda não foi validado.

# 🎯 OBJETIVO FINAL

Objetivo da seção:
- Definir o resultado final em termos verificáveis, para que qualquer pessoa saiba quando a entrega realmente terminou.

Perguntas obrigatórias:
- O que precisa estar funcionando ao final?
- Quais critérios de sucesso são verificáveis e não subjetivos?
- Quais comportamentos incorretos devem desaparecer?
- Quais limites ou restrições precisam ser preservados?

Formato recomendado:
- Uma frase de objetivo final.
- Lista de critérios objetivos de sucesso.

Alertas:
- Evite metas vagas como "melhorar UX" sem dizer como validar.
- Inclua compatibilidades importantes que não podem regredir.

# 🧠 INSIGHTS DO HISTÓRICO (RAG)

Objetivo da seção:
- Reaproveitar memória útil do projeto e registrar aprendizado novo de forma que futuras análises saiam mais fortes.

Perguntas obrigatórias:
- Quais planos, feedbacks ou memórias anteriores são relevantes?
- Que padrão recorrente este caso repete?
- Que insight novo este caso adiciona?
- Que memória curta e reaproveitável deve ser registrada depois?

Formato recomendado:
- Histórico consultado.
- Aprendizados reaproveitados.
- Insight novo deste caso.
- Memória útil a registrar.

Alertas:
- Não citar histórico só por citar; relacione com a decisão atual.
- Se não houver histórico útil, diga isso explicitamente.

# 🧠 ESTRATÉGIA GLOBAL

Objetivo da seção:
- Fechar a abordagem principal e explicar por que ela é melhor do que alternativas óbvias ou atalhos perigosos.

Perguntas obrigatórias:
- Qual abordagem foi escolhida?
- Por que ela resolve a causa raiz em vez de só mascarar o sintoma?
- Quais decisões ficam fechadas aqui para evitar ambiguidade na implementação?
- Quais alternativas foram descartadas e por quê?

Formato recomendado:
- Explicação curta da linha mestra.
- Lista numerada ou blocos por frente de atuação.
- Decisão central e trade-offs.

Alertas:
- Não listar soluções concorrentes sem escolher uma.
- Se houver compatibilidade, migração ou rollout, cite a estratégia.

# 🗺️ PLANO ESTRUTURADO

Objetivo da seção:
- Organizar a execução em fases claras, com propósito, dependência e entregável de cada etapa.

Perguntas obrigatórias:
- Quais são as fases numeradas da execução?
- O que cada fase resolve?
- Quais dependências existem entre as fases?
- Qual é o resultado esperado ao final de cada etapa?

Formato recomendado:
- Fase 1, Fase 2, Fase 3...
- Em cada fase: objetivo, principal mudança e entregável esperado.

Alertas:
- Não criar fases genéricas demais.
- Se a ordem importa, explique por que.
- Se alguma fase puder ser omitida em cenário específico, diga a condição.

# 🛠️ EXECUÇÃO DETALHADA

Objetivo da seção:
- Descrever exatamente o que deve ser alterado para que outro implementador consiga executar sem decidir arquitetura no meio do caminho.

Perguntas obrigatórias:
- Quais arquivos, funções, componentes, endpoints, tipos ou fluxos serão alterados?
- O comportamento atual é qual e qual será o comportamento depois?
- Quais contratos ou interfaces públicas serão afetados?
- Quais estados intermediários, casos de borda, erros e fallbacks precisam existir?
- Qual é a ordem recomendada de implementação?

Formato recomendado:
- Divida por fluxo, subsistema ou mudança principal.
- Para cada bloco, descreva explicitamente:
  - motivação;
  - local da mudança;
  - mudança proposta;
  - efeito esperado;
  - risco principal;
  - fallback/rollback quando aplicável.

Alertas:
- Cite nomes reais de arquivos e símbolos quando existirem.
- Não use "ajustar lógica" sem descrever a lógica.
- Se a solução depender de telemetria, logs, migration, compat layer ou feature flag, diga isso claramente.
- Se houver mudança em API ou schema, descreva formato esperado, compatibilidade e impacto.

# 🔗 USO DE TOOLS NO ANTIGRAVITY

Objetivo da seção:
- Indicar ferramentas, integrações ou automações que ajudam a executar ou validar o plano, com finalidade concreta.

Perguntas obrigatórias:
- Quais tools são úteis para implementar, validar ou observar este caso?
- Em que etapa cada tool entra?
- Que evidência objetiva cada tool deve produzir?
- Quais limitações ou riscos existem no uso dessas tools?

Formato recomendado:
- Para cada tool ou integração, informar:
  - nome;
  - etapa;
  - objetivo;
  - saída/evidência esperada;
  - limitação ou cuidado.

Alertas:
- Não citar tools de forma decorativa.
- Se nenhuma tool específica for necessária, diga isso e explique por que.

# 🔍 VALIDAÇÃO

Objetivo da seção:
- Tornar verificável que a implementação funciona, não regrediu comportamento adjacente e cobre os cenários importantes.

Perguntas obrigatórias:
- Qual é o cenário feliz principal?
- Quais regressões prováveis precisam ser testadas?
- Quais casos de borda ou recovery precisam ser validados?
- Que evidência objetiva prova que a correção funcionou?
- O que precisa ser testado manualmente e o que pode ser automatizado?

Formato recomendado:
- Matriz ou lista de cenários com:
  - ação;
  - resultado esperado;
  - evidência esperada;
  - risco coberto.
- Separar, quando aplicável:
  - testes manuais;
  - testes automatizados;
  - observabilidade/logs;
  - critérios de aceite final.

Alertas:
- Não pare em "testar fluxo principal".
- Inclua pelo menos um cenário de falha, um de regressão e um de borda quando o caso justificar.
- Se não for possível automatizar, explique o motivo.

# 🚨 RISCOS E MITIGAÇÕES

Objetivo da seção:
- Antecipar os principais modos de falha e definir como reduzir impacto, detectar regressão e recuperar o sistema.

Perguntas obrigatórias:
- Quais são os riscos técnicos, funcionais e operacionais mais importantes?
- O que pode quebrar direta ou indiretamente?
- Como cada risco será mitigado?
- Qual é o fallback e, se necessário, o rollback?
- Que sinal ou gatilho indicará que o risco aconteceu?

Formato recomendado:
- Lista por risco contendo:
  - risco;
  - impacto;
  - gatilho/sinal;
  - mitigação;
  - fallback/rollback.

Alertas:
- Não escreva apenas "baixo risco" sem justificar.
- Se a mudança toca fluxo crítico, compatibilidade ou dados, trate rollback como obrigatório.

# 📊 SCORE DE QUALIDADE

Objetivo da seção:
- Avaliar a qualidade do próprio plano com critérios objetivos antes de considerá-lo pronto para implementação.

Perguntas obrigatórias:
- O plano está específico o suficiente para execução direta?
- Há rastreabilidade entre problema, evidência e solução?
- Os critérios de validação estão completos?
- O risco está bem coberto?
- A chance de regressão está explicitamente tratada?

Formato recomendado:
- Atribuir nota de 0 a 5 para cada critério abaixo e justificar brevemente:
  - especificidade técnica;
  - rastreabilidade ao código/evidência;
  - clareza de execução;
  - cobertura de validação;
  - gestão de risco/regressão.
- Fechar com score geral e motivo.

Alertas:
- Não invente nota alta sem justificar.
- Se algum critério estiver abaixo de 4, diga o que falta para fortalecer o plano.

# 🧠 CONFIANÇA DO MODELO

Objetivo da seção:
- Explicitar o nível de confiança com base em evidência real e deixar claro o que ainda é hipótese ou depende de validação.

Perguntas obrigatórias:
- Qual é o nível de confiança geral?
- Em quais leituras, evidências ou padrões essa confiança se apoia?
- O que ainda pode invalidar parte da solução?
- Quais trechos do plano dependem mais de confirmação em execução?

Formato recomendado:
- Percentual ou faixa de confiança.
- Justificativa curta baseada em evidências.
- Lista de incertezas remanescentes.

Alertas:
- Não use percentual solto sem justificar.
- Alta confiança sem leitura suficiente é pior do que média confiança bem explicada.

# 🧬 MEMÓRIA GERADA

Objetivo da seção:
- Produzir um resumo curto, indexável e reutilizável pelo sistema de memória/RAG sem depender do restante do plano.

Perguntas obrigatórias:
- Qual era o problema em uma frase?
- Qual foi a causa raiz ou hipótese principal?
- Qual solução foi escolhida?
- Qual risco principal ficou mapeado?
- Qual lição reaproveitável este caso deixa?

Formato recomendado:
- Texto curto ou lista curta pronta para indexação.
- Priorize:
  - problema;
  - causa raiz;
  - solução proposta;
  - risco principal;
  - lição reutilizável.

Alertas:
- Não florear.
- Não repetir o plano inteiro.
- Escreva de forma que outro caso semelhante possa ser recuperado pela busca semântica.
