# ☁️ TCloud — Telegram Cloud Storage via FTP & Web

Transforme o seu **Telegram em um serviço de armazenamento em nuvem ilimitado e robusto!** 
O TCloud é um servidor avançado que utiliza chats e canais do Telegram como "discos rígidos virtuais" (backend) operando em alta velocidade com MTProto, usando um banco de dados MongoDB para salvar as posições (metadados) dos seus arquivos gigantescos.

---

## ✨ Recursos Incríveis

- **Armazenamento Ilimitado:** Suba Terabytes de arquivos. O limite é o seu Telegram!
- **Interface Web App & Streaming:** Acesse `http://localhost:8080` de qualquer navegador. Nossa interface moderna permite que você envie arquivos, pause torrents, crie pastas e assista aos seus vídeos e escute músicas diretamente do navegador.
- **Chunking Inteligente:** Arquivos gigantescos superiores ao limite do Telegram (2GB) são fatiados silenciosamente em pedaços de 64MB~128MB.
- **Client WebTorrent Integrado:** Adicione links Magnet diretamente pela Interface Web e o TCloud baixa via torrent direto para a nuvem.
- **Multi-Bot e Velocidade Turbo:** Usa a biblioteca Telethon e faz balanceamento de carga (Round-robin) com seus vários bots, ignorando os limites bruscos da rede do Telegram.
- **FileZilla (FTP) & FUSE-T:** Acesse seus arquivos em velocidade da luz como se fossem pastas nativas montadas no seu computador no macOS.
- **Acesso Remoto Fácil (Ngrok):** Link seguro gratuito para você acessar seus arquivos de qualquer lugar do mundo pelo celular.

---

## 🏗️ Como Funciona a Arquitetura?

Trabalhando como uma verdadeira "Nuvem Privada", o TCloud tem o seguinte ciclo de vida:

```text
┌────────────────────────────────────────────────────────┐
│                   SEU COMPUTADOR OU APP                │
│  [Navegador Web UI] ─ [Aplicativo FileZilla FTP]       │
└──────────────────────┬─────────────────────────────────┘
                       │
┌──────────────────────▼─────────────────────────────────┐
│        TCloud Core Server (Upload/Download)            │
│  ┌──────────────────────────────────────────────────┐  │
│  │ • File Manager (Faz o corte/união de 64MB)       │  │
│  │ • Torrent Manager (Baixa arquivos Magnet na RAM) │  │
│  │ • Staging/LRU Cache (Guarda arquivos recentes)   │  │
│  └──────────────────────────────────────────────────┘  │
└──────────────────────┬─────────────────────────────────┘
                       │
          ┌────────────┴───────────┐
┌─────────▼────────┐     ┌─────────▼─────────────┐
│    MongoDB       │     │       Telegram        │
│(Catálogo/Pastas) │     │ (O Arquivo Físico)    │
└──────────────────┘     └───────────────────────┘
```
**Onde o arquivo fica na verdade?** O Telegram armazena o pedaço real da sua foto ou filme. Mas para você não ver aquele visual feio de "várias mensagens no Telegram", o MongoDB memoriza perfeitamente que a "Parte 1, Parte 2 e Parte 3" daquele filme pertencem à pasta "Meus Filmes".

---

## 🚀 Como instalar num Raspberry Pi (ou Casa Inteligente)

Para deixar o TCloud ligado **24/7** gastando pouca energia, a recomendação é rodar num **Raspberry Pi** via Docker. O sistema já está configurado para desligar serviços incompatíveis (como FUSE-T do macOS) quando detecta que está rodando em uma plaquinha.

### Passo 1: O Que Você Precisa Ter em Mãos
1. **API_ID e API_HASH:** Obtenha gratuitamente em [my.telegram.org](https://my.telegram.org).
2. **Tokens de Bot:** Crie um ou vários bots no Telegram conversando com o `@BotFather`.
3. **ID do Canal (Opcional, mas de preferência criar um Privado):** Adicione o seu robô ao canal como administrador. Use bots como `@userinfobot` para ver qual é o ID do chat (`-100...`).

### Passo 2: Copiar para a sua Placa (via Mac)
Do seu Mac, abra o terminal e envie todo o seu projeto limpo para a plaquinha (substitua o IP):
```bash
rsync -avz --exclude 'node_modules' --exclude 'venv' --exclude 'sessions' --exclude '.git' ./ pi@IP_DO_RASPBERRY:~/tcloud/
```

### Passo 3: Configurar o Motor
Lá no Raspberry Pi (via SSH ou direto nele), entre na pasta e crie sua configuração:
```bash
cd ~/tcloud
cp .env.example .env
nano .env
```
Preencha suas informações do `Passo 1` ali dentro. Se seu Raspberry Pi tiver **8GB de RAM**, configure `MAX_WORKERS=6` e `CHUNK_SIZE_MB=64` para o download voar! 

### Passo 4: Subir a Nuvem
Com o Docker já previamente instalado na sua placa, apenas digite:
```bash
docker compose up -d --build
```
> O serviço Web e MongoDB vão ser construídos pra arquitetura ARM automaticamente (Isso leva uns 10 minutos pro Raspberry processar o Node.js e Python!). 

Pode verificar os logs do primeiro sucesso com: `docker compose logs -f tcloud`.

---

## 🌐 Acesso Externo pelo Ngrok (Fora de Casa)

Se você estiver no 4G ou em viagem e quiser abrir o **Interface Web (Web App)** do TCloud pelo celular, usamos a conexão tunelada gratuita pelo Ngrok.

1. Acesse o site do [Ngrok](https://dashboard.ngrok.com/signup) e crie sua conta grátis.
2. Copie seu **Authtoken**.
3. No arquivo `.env` do seu Raspberry Pi, cole o código na variável `NGROK_AUTHTOKEN=seu_codigo_aqui`.
4. Atualize o servidor (`docker compose up -d`).

Com isso, o Ngrok criará um link secreto e criptografado permanente para você. Se quiser que ninguém logue na sua nuvem pelo link, basta editar o `.env` trocando `AUTH_ENABLED=true` e usando seu Login e Senha originais!

---

## 💻 Interface Modular e Extensões (Apps)
Dentro da página Web, o TCloud suporta mini-aplicativos visuais! 
Qualquer desenvolvedor HTML/JS pode criar plugins simplesmente jogando os arquivos (com um `manifest.json`) dentro da nossa pasta `/apps/`. Os aplicativos têm permissão e APIs para solicitar dados, rodar players de terceiros e listar arquivos do MongoDB de forma muito rápida.
*(Vide o guia `apps/README.md`)*.

---
**☁️ TCloud Storage** - Transformando limites em possibilidades.
