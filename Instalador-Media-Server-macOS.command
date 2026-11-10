#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  Midnight Media Server — Instalador visual para macOS
#
#  Diálogos nativos (AppleScript) + o instalador oficial
#  (install.sh) rodando na janela do Terminal, com a saída
#  colorida visível — a barra de progresso de verdade.
#
#  Uso: duplo clique no arquivo (ou: bash Instalador-Media-Server-macOS.command)
# ─────────────────────────────────────────────────────────────
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${MEDIA_SERVER_REPO:-ticianocorral/midnightmediaserver}"
REF=""     # resolver_ref(): ultima release (ou MEDIA_SERVER_REF)

# ─── Qual versao instalar ───────────────────────────────
# Fixa na ULTIMA RELEASE, nao na branch main: quem roda "curl | bash" executa o que estiver la, e a
# main muda a cada commit. MEDIA_SERVER_REF (tag ou branch) continua mandando quando definido.
# Sem rede/API do GitHub, cai na main avisando.
resolver_ref() {
    if [ -n "${MEDIA_SERVER_REF:-}" ]; then REF="$MEDIA_SERVER_REF"; return 0; fi
    local tag
    tag="$(curl -fsSL -m 10 "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
        | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)" || tag=""
    if [[ "$tag" =~ ^v[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
        REF="$tag"
    else
        REF="main"
        echo "  ! Nao consegui descobrir a ultima release; usando a branch main." >&2
    fi
}

aviso() {
    osascript -e "display dialog \"$1\" with title \"Midnight Media Server\" buttons {\"Continuar\"} default button 1 with icon note" >/dev/null
}

# ── Boas-vindas ──────────────────────────────────────────────
if ! osascript -e 'display dialog "🎬 Bem-vindo ao Midnight Media Server!

Seus filmes com cara de Netflix — self-hosted, leve e instantâneo.

O instalador vai:
  • verificar e instalar o rclone (se faltar)
  • instalar o app e o serviço que sobe com o login
  • abrir o navegador no final

 Continuar?" with title "Midnight Media Server — Instalador" buttons {"Cancelar", "Continuar"} default button 2 with icon note' 2>/dev/null | grep -q "Continuar"; then
    echo "Instalação cancelada."
    exit 0
fi

# ── Projeto ao lado ou baixar ────────────────────────────────
if [ ! -f "$DIR/install.sh" ]; then
    aviso "O instalador oficial (install.sh) não está junto deste arquivo. Vou baixá-lo do GitHub — se o repositório for privado, baixe o projeto e rode este arquivo de dentro da pasta."
    resolver_ref
    curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/install.sh" -o "$DIR/install.sh" \
        || { aviso "Não consegui baixar o install.sh (repositório privado?). Baixe o projeto e tente de novo."; exit 1; }
fi

# ── Instalar (saída visível no Terminal) ─────────────────────
clear 2>/dev/null || true
echo ""
echo "  🎬 Midnight Media Server — instalando..."
echo "  (esta janela mostra o progresso de verdade; pode deixar rodando)"
echo ""
chmod +x "$DIR/install.sh"
if ! bash "$DIR/install.sh"; then
    aviso "A instalação terminou com erro. Role a janela do Terminal para ver o que aconteceu — e rode de novo se quiser."
    exit 1
fi

# ── Encerramento ─────────────────────────────────────────────
RESPOSTA=$(osascript -e 'display dialog "✅ Instalação concluída!

O Midnight Media Server já está rodando e vai iniciar junto com o Mac.

Abra http://localhost:9187 — o código de instalação de 6 dígitos
apareceu na janela do Terminal acima (e no log).

Abrir o navegador agora?" with title "Midnight Media Server — Instalador" buttons {"Depois", "Abrir"} default button 2 with icon note' 2>/dev/null | grep -o "Abrir\|Depois" || echo "")
if [ "$RESPOSTA" = "Abrir" ]; then
    open "http://localhost:9187"
fi
