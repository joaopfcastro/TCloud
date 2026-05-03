# Guia de Instalação do TCloud no Orange Pi

Este guia descreve os passos exatos para transferir o pacote de deploy para o seu Orange Pi e realizar a instalação automatizada.

## Passo 1: Transferir a Pasta de Deploy para o Orange Pi

A pasta `deploy` é **autossuficiente** (contém todo o código fonte e configurações). Você só precisa dela no Orange Pi para começar.

1. No Terminal do seu Mac, navegue até a pasta do projeto:
   ```bash
   cd /Users/joaopauloferreiracastro/TCloud
   ```
2. Copie a pasta `deploy` para o Orange Pi:
   ```bash
   scp -r deploy root@192.168.0.84:/root/
   ```

## Passo 2: Acessar o Orange Pi e Instalar

1. Acesse o Orange Pi via SSH:
   ```bash
   ssh root@192.168.0.84
   ```
2. Entre na pasta e execute o instalador:
   ```bash
   cd /root/deploy
   chmod +x install_orangepi.sh
   ./install_orangepi.sh
   ```

> **O que o script faz?**
> - Instala Docker/Compose (com correção para Ubuntu Focal).
> - Cria a pasta definitiva em `~/tcloud` e move o código e o `.env` para lá.
> - Inicia o TCloud em background e configura o início automático no boot (*systemd*).

3. Ao final, o terminal exibirá o endereço local de acesso (ex: `http://192.168.0.84:8080`).

4. **Limpeza**: Após a confirmação de que o sistema subiu, você já pode apagar a pasta de instalação temporária:
   ```bash
   rm -rf /root/deploy
   ```

---

## Comandos Úteis (na pasta ~/tcloud)

Execute estes comandos de dentro da pasta `~/tcloud` para gerenciar o serviço:

- **Ver Logs**: `./scripts/logs.sh`
- **Ver Status**: `./scripts/status.sh`
- **Rebuild Completo**: `./scripts/rebuild.sh`
- **Parar**: `docker compose down`
- **Iniciar**: `docker compose up -d`
- **Reiniciar**: `docker compose restart`

**Importante**: `docker compose restart` apenas reinicia o container atual. Se você alterou código Python/HTML/CSS/JS ou adicionou dependências como `PyMuPDF`, use `./scripts/rebuild.sh` ou `docker compose up -d --build` para recriar a imagem.

**Nota**: Certifique-se de que o seu arquivo `.env` dentro da pasta `deploy` esteja devidamente preenchido antes de iniciar a instalação.

As configurações ajustadas pelo app Web `Configurações` ficam persistidas no runtime do deploy em `./data/staging/config/managed_settings.json`, montado no container como `/app/data/staging`.
