#!/bin/bash
# install_orangepi.sh

set -e

echo "========================================="
echo " Iniciando instalacao TCloud (Orange Pi) "
echo "========================================="

# Garante que estamos rodando de dentro da pasta onde o script esta (deploy/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

INSTALL_DIR="$HOME/tcloud"

# Detect OS
if [ "$(uname -s)" != "Linux" ]; then
    echo "Erro: Este script deve ser executado em um ambiente Linux (Orange Pi)."
    exit 1
fi

# Detect Arch
ARCH=$(uname -m)
if [[ "$ARCH" != "aarch64" && "$ARCH" != "arm64" ]]; then
    echo "Aviso: Arquitetura ($ARCH) não é aarch64/arm64. Recomendado usar Orange Pi 3B."
fi

# Validar .env local
ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
    echo "Erro: Arquivo .env não encontrado dentro da pasta 'deploy'."
    echo "Por favor, preencha o arquivo .env nesta pasta antes de rodar a instalacao."
    exit 1
fi

echo "[+] Validando $ENV_FILE..."
REQUIRED_VARS=("MONGODB_URI" "DB_NAME" "API_ID" "API_HASH" "BOT_TOKENS" "CHAT_ID" "HTTP_PORT" "AUTH_ENABLED" "AUTH_USERNAME" "AUTH_PASSWORD" "JWT_SECRET")
for VAR in "${REQUIRED_VARS[@]}"; do
    if ! grep -q "^${VAR}=" "$ENV_FILE"; then
        echo "Erro: Variavel $VAR não encontrada no arquivo $ENV_FILE!"
        exit 1
    fi
    # Verificar se a variavel esta vazia
    VALOR=$(grep "^${VAR}=" "$ENV_FILE" | cut -d '=' -f2)
    if [ -z "$VALOR" ]; then
        echo "Erro: A variavel $VAR esta vazia no arquivo $ENV_FILE. Preencha os valores antes de continuar."
        exit 1
    fi
done
echo "[OK] .env valido!"

# Install Docker se nao existir
if ! command -v docker &> /dev/null; then
    echo "[+] Docker nao detectado. Instalando Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh || {
        echo "[!] O script oficial falhou (possível falha de pacotes no Ubuntu Focal)."
        echo "[+] Resolvendo manualmente via apt-get..."
        sudo apt-get update
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-ce-rootless-extras docker-buildx-plugin || sudo apt-get install -y docker.io docker-compose
    }
    rm -f get-docker.sh
    sudo usermod -aG docker "$USER" || true
    echo "[+] Docker instalado."
fi

# Install Docker Compose Plugin se nao existir
if ! docker compose version &> /dev/null; then
    echo "[+] Docker Compose nao detectado. Tentando instalar..."
    sudo apt-get update
    sudo apt-get install -y docker-compose-plugin
    echo "[+] Docker Compose instalado."
fi

echo "[+] Criando diretorio de instalacao principal em $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"

echo "[+] Criando diretorios de dados (staging, logs, sessions)..."
mkdir -p "$INSTALL_DIR/data/staging" "$INSTALL_DIR/data/logs" "$INSTALL_DIR/sessions"

echo "[+] Movendo arquivos de configuracao e pacote fonte para $INSTALL_DIR..."
cp docker-compose.yml "$INSTALL_DIR/"
cp "$ENV_FILE" "$INSTALL_DIR/"
cp -r scripts "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/scripts/"*.sh

# Mover o app source (a que esta embutida na propria pasta 'deploy/src')
if [ -d "src" ]; then
    echo "[+] Codigo do aplicativo encontrado embutido. Instalando codigo..."
    cp -r src "$INSTALL_DIR/"
else
    echo "[!] AVISO: Pasta 'src' (codigo fonte gerado) nao foi encontrada dentro de 'deploy/'. O Docker pode falhar se a imagem nao existir."
fi

# Saindo de deploy para a pasta oficial
cd "$INSTALL_DIR"

# Subindo
echo "[+] Subindo TCloud via Docker Compose em $INSTALL_DIR..."
docker compose --env-file .env up -d --build

# Configurar systemd
echo "[+] Configurando auto-start com systemd..."
SERVICE_PATH="/etc/systemd/system/tcloud-orangepi.service"

sudo cp "$SCRIPT_DIR/systemd/tcloud-orangepi.service" /tmp/tcloud-orangepi.service
sudo sed -i "s|WORKING_DIRECTORY_PLACEHOLDER|$INSTALL_DIR|g" /tmp/tcloud-orangepi.service
sudo mv /tmp/tcloud-orangepi.service "$SERVICE_PATH"
sudo chown root:root "$SERVICE_PATH"
sudo chmod 644 "$SERVICE_PATH"

sudo systemctl daemon-reload
sudo systemctl enable tcloud-orangepi.service
echo "[OK] Servico tcloud-orangepi ativado no boot."

# Resumo
HTTP_PORT=$(grep "^HTTP_PORT=" .env | cut -d '=' -f2)
HTTP_PORT=${HTTP_PORT:-8080}
IPV4=$(hostname -I | awk '{print $1}')

echo ""
echo "========================================="
echo "        INSTALACAO CONCLUIDA!            "
echo "========================================="
echo "A instalacao oficial esta agora em:"
echo " -> $INSTALL_DIR"
echo ""
echo "====> VOCE JA PODE EXCLUIR A PASTA 'deploy' ATUAL <===="
echo ""
if [ -d "src" ]; then
    echo "O TCloud esta rodando em background."
    echo "Acesso Web UI (Rede Local):"
    for IP in $IPV4; do
        echo "  http://${IP}:${HTTP_PORT}"
    done
    echo "Ou acesse remotamente usando seu IPv6 global."
else
    echo "AVISO: Houve falta do codigo fonte. O container pode nao estar de pe."
fi
echo ""
echo "Comandos uteis (execute dentro de $INSTALL_DIR):"
echo "  Verificar logs:   ./scripts/logs.sh"
echo "  Verificar status: ./scripts/status.sh"
echo "========================================="
