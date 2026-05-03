# Guia de Implantação: TCloud via Docker no Orange Pi 3B com HD Externo e Acesso IPv6

Este guia detalha o processo para configurar e implantar o **TCloud** no seu Orange Pi 3B usando **Docker** e **Docker Compose**. O uso do Docker facilita a instalação do Node.js, FFmpeg e outras dependências sem "sujar" o sistema, além de manter a aplicação rodando de forma isolada e segura.

Também abordaremos a montagem do HD externo USB e o acesso externo via **IPv6** (contornando o CGNAT do IPv4).

---

## 1. Acesso Inicial via SSH

1. **Acesso Local**
   - Conecte o Orange Pi 3B à sua rede local e acesse via SSH no IP \`192.168.0.84\`.
   - **Atenção:** Se o login com \`root\` estiver falhando (Permission denied), tente usar o usuário padrão do sistema que você instalou (geralmente \`orangepi\`, \`ubuntu\` ou \`debian\`).
     ```bash
     ssh seu_usuario@192.168.0.84
     ```
   
2. **Atualização do Sistema**
   - Sempre mantenha o sistema atualizado:
     ```bash
     sudo apt update && sudo apt upgrade -y
     ```

## 2. Configuração do HD Externo via USB

O contêiner Docker vai precisar mapear a pasta do HD externo para salvar os arquivos do TCloud.

1. **Conectar e Identificar o HD**
   - Conecte o HD Externo em uma das portas USB 3.0 (azuis) do Orange Pi 3B.
   - Liste os discos conectados para identificar o caminho do HD (ex: \`/dev/sda1\`):
     ```bash
     sudo lsblk
     ```

2. **Criar Ponto de Montagem**
   - Crie a pasta onde o TCloud vai salvar os dados:
     ```bash
     sudo mkdir -p /mnt/tcloud_hd
     ```

3. **Descobrir o UUID e Configurar a Montagem Automática**
   - Descubra o UUID da partição do HD:
     ```bash
     sudo blkid
     ```
   - Edite o arquivo fstab para montar sozinho ao reiniciar:
     ```bash
     sudo nano /etc/fstab
     ```
   - Adicione ao final do arquivo:
     ```text
     UUID=SEU_UUID_AQUI   /mnt/tcloud_hd   ext4   defaults,nofail   0   0
     ```
   - Teste montando o disco e ajustando as permissões:
     ```bash
     sudo mount -a
     sudo chown -R $USER:$USER /mnt/tcloud_hd
     ```

## 3. Instalação do Docker e Docker Compose

O Orange Pi sendo baseado em arquitetura ARM requer a instalação oficial do Docker.

1. **Instalar o Docker via Script Oficial**
   ```bash
   curl -fsSL https://get.docker.com -o get-docker.sh
   sudo sh get-docker.sh
   ```

2. **Permitir que seu usuário execute comandos Docker (sem \`sudo\`)**
   ```bash
   sudo usermod -aG docker $USER
   ```
   *(Pode ser necessário sair \`exit\` e entrar via SSH novamente para aplicar).*

3. **Instalar o Docker Compose**
   ```bash
   sudo apt install -y docker-compose-plugin
   ```

## 4. Implantação do TCloud via Docker Compose

1. **Criar a pasta do projeto no Orange Pi**
   ```bash
   mkdir -p ~/TCloud-Deploy
   cd ~/TCloud-Deploy
   ```

2. **Criar o arquivo \`docker-compose.yml\`**
   - Crie e edite o arquivo primário de orquestração:
     ```bash
     nano docker-compose.yml
     ```
   - Cole o exemplo abaixo (ajuste a imagem base do seu projeto ou use o \`Dockerfile\` se for construir na hora):
     ```yaml
     version: '3.8'

     services:
       tcloud-api:
         # Se você tiver publicado a imagem no DockerHub ou GitHub Container Registry:
         # image: seu-usuario/tcloud:latest 
         
         # Caso queira fazer build a partir do código fonte local (descomente as 2 linhas abaixo):
         # build: 
         #   context: .
         
         container_name: tcloud_backend
         restart: unless-stopped
         ports:
           - "8080:8080" # Porta HTTP
           - "2121:2121" # Porta FTP (se estiver usando)
         volumes:
           # Mapeia o HD externo para dentro do contêiner DOCKER (onde o TCloud espera salvar)
           - /mnt/tcloud_hd:/app/storage
         environment:
           - PORT=8080
           # A API precisa saber onde salvar os arquivos dentro do contêiner
           - STORAGE_PATH=/app/storage
           - NODE_ENV=production
     ```

3. **Subir os Contêineres**
   - Se estiver usando código local, certifique-se de que os arquivos do backend e um \`Dockerfile\` (preparando Node + FFmpeg baseados em alpine/debian) estejam presentes na mesma pasta.
   - Execute o comando para baixar/construir e rodar em background (\`-d\`):
     ```bash
     docker compose up -d
     ```
   - Você pode acompanhar os logs do TCloud com:
     ```bash
     docker compose logs -f
     ```

## 5. Configuração de Rede: Acesso Externo via IPv6

Como você quer acessar seu TCloud via internet num modem com CGNAT para IPv4, o foco é liberar o IP-V6 (GUA).

1. **Descubra o IPv6 do Orange Pi 3B**
   ```bash
   ip -6 addr show
   ```
   *Anote o endereço que se assemelha a \`2804:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx\` (Escopo Global).*

2. **Configuração do Modem Technicolor TC3102**
   - Acesse o modem pelo seu roteador padrão (ex. \`192.168.0.1\`).
   - Vá na seção **Firewall / Port Forwarding IPv6**.
   - Crie uma regra redirecionando as conexões de entrada na porta **8080** e **2121** (se aplicável) diretamente para o **Endereço IPv6 Global GUA** do Orange Pi.
   - Alternativamente, se o aparelho continuar bloqueando, teste inserir o IPv6 do Orange na seção **DMZ IPv6** do modem para permitir tráfego total (com a devida proteção de ter apenas portas configuradas rodando no servidor).

3. **Como acessar**
   - De um celular Android/iOS (fora do Wi-Fi, na rede 4G/5G que possua IPv6) acesse:
     ```text
     http://[2804:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx]:8080
     ```

Qualquer alteração na aplicação Node.js do TCloud agora se baseia apenas no comando do Docker! Se precisar parar a rede toda, basta executar \`docker compose down\`.
