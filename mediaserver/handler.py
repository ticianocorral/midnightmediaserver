"""Handler HTTP: roteamento, gate de autenticacao e streaming de midia."""

import http.server
import json
import os
import socket
import ssl
import subprocess
import urllib.parse
import urllib.request
import urllib.error
import mimetypes
import threading
import sys
import gzip
import hashlib
import re
import hmac
import time
import shutil
import io
import zipfile
from pathlib import Path

from .config import (
    PROJECT_ROOT,
    PORT,
    HTTPS_PORT_BASE,
    BACKUP_FOLDER,
    NOME_DB_BACKUP,
    PREFIXO_BACKUP,
    RCLONE_SERVE_PORT,
    FRONTEND_PATH,
    DB_PATH,
    IMAGE_CACHE_DIR,
    SUBS_CACHE_DIR,
    IMAGE_EXTENSIONS,
    SUBTITLE_EXTENSIONS,
    MAX_RESTORE_BYTES,
    MAX_JSON_BODY_BYTES,
    WRITE_ROUTES,
    PUBLIC_PATHS,
    TOKEN_PATHS,
    ADMIN_PATHS,
    ACCOUNT_PATHS,
    SESSION_COOKIE,
    SESSION_MAX_AGE,
)
from .netsec import (
    host_allowed as _host_allowed,
    origin_allowed as _origin_allowed,
    origin_mesmo_servidor as _origin_mesmo_servidor,
)
from .paths import (
    CaminhoInvalido,
    destino_backup,
    destinos_backup,
    rc_remote as _rc_remote,
    serve_path as _serve_path,
)
from . import keepawake
from . import prepare
from .db import (
    partir_caminho,
    get_db,
    perfil_atual,
    set_perfil_atual,
    adotar_progresso_orfao,
    apagar_progresso_do_perfil,
    log_notification as _log_notification,
    looks_like_media_server_db as _looks_like_media_server_db,
)
from .auth import (
    _setup_code_value,
    _auth_configured,
    _norm_username,
    AVATARES,
    MAX_PERFIS,
    GERENCIAR_SEGUNDOS,
    _list_profiles,
    _get_profile,
    _create_account,
    _create_profile,
    _update_profile,
    _delete_profile,
    _set_pin,
    _pin_confere,
    _check_credentials,
    _revoke_all_sessions,
    _issue_session,
    _session_info,
    _session_user,
    _issue_media_token,
    _valid_media_token,
    _login_blocked,
    _record_login_failure,
    _clear_login_failures,
)
from .templates import _login_page, _profiles_page
from .netutil import (
    _get_local_ip,
    _primary_local_hostname,
    active_https_port,
)
from .rclone import (
    run_rclone_cmd,
    _mark_file_cached,
    restart_rclone_serve,
    start_rclone_webgui,
    stop_rclone_webgui,
)
from . import scanner as _scanner
from . import scraper as _scraper
from . import organizador as _organizador
from . import sources as _sources
from . import branding as _branding
from . import nuvem as _nuvem
from . import thumbs as _thumbs
from .branding import NOME_PADRAO
from .queries import (
    cached_get_file_info,
    cached_source_counts,
    cached_algum_infantil,
)

# Sentinela do cache de usuario por requisicao (ver _reset_request_state).
_UNSET = object()


# Buffer do streaming: 64 KB fazia o loop Python de _serve_real_file rodar
# ~3000 vezes por filme; 1 MB corta o mesmo trajeto em ~64x menos laços e
# syscalls, sem inflar a memoria por conexao (so 1 MB a mais por stream).
_STREAM_BUFFER = 1024 * 1024


# O mimetypes do Python nao conhece .webmanifest, e sem o tipo certo o
# navegador ignora o manifesto e nao oferece instalar o app.
mimetypes.add_type("application/manifest+json", ".webmanifest")


def _bust_asset_cache(html):
    """Carimba os estaticos com o mtime do arquivo: /static/app.js?v=1787778.

    Eles sao servidos com max-age=3600. Sem isso, uma atualizacao do frontend
    so chegaria ao navegador uma hora depois — ou com refresh forcado. Usa o
    mtime, e nao a versao do app, para quebrar o cache sempre que o conteudo
    muda de fato, inclusive entre releases.
    """
    for asset in ("/static/app.js", "/static/styles.css",
                  "/static/tv.js", "/static/tv.css"):
        try:
            stamp = int((PROJECT_ROOT / asset.lstrip("/")).stat().st_mtime)
        except OSError:
            continue
        html = html.replace(f'"{asset}"', f'"{asset}?v={stamp}"')
    return html


# static/ comprimido em gzip, por (arquivo, mtime, tamanho): o app.js tem 300 KB.
_GZIP_ESTATICOS = {}


def _chave_de_cache(prefixo, path):
    """Nome de arquivo de cache derivado do path, sem nada do path em si.

    Antes era o path com '/' trocado por '_': no Windows '\\' continuava
    valendo como separador e 'x\\..\\..\\auth.json' escapava da pasta de cache.
    O hash nao tem separador nenhum; a extensao fica so pra facilitar a leitura.
    """
    ext = Path(str(path)).suffix.lower()
    if not ext[1:].isalnum():
        ext = ""
    return prefixo + "_" + hashlib.sha256(str(path).encode("utf-8")).hexdigest() + ext


def _zip_member_ok(z, name):
    """Membro de imagem/legenda dentro do teto do restore: um zip de poucos
    KB pode expandir pra gigabytes (zip-bomb) e derrubar a maquina aqui."""
    try:
        return z.getinfo(name).file_size <= MAX_RESTORE_BYTES
    except (KeyError, zipfile.BadZipFile):
        return False


from .rotas.sistema import SistemaRotas
from .rotas.admin import AdminRotas
from .rotas.cache import CacheRotas
from .rotas.catalogo import CatalogoRotas
from .rotas.midia import MidiaRotas


class MediaServerHandler(SistemaRotas, AdminRotas, CacheRotas, CatalogoRotas, MidiaRotas, http.server.BaseHTTPRequestHandler):
    # HTTP/1.1 liga o keep-alive: sem isso o navegador abria conexao nova (e
    # handshake TLS completo) a cada requisicao — a home dispara dezenas. Em
    # troca, TODA resposta precisa delimitar o corpo com Content-Length, senao
    # o cliente fica preso esperando o fim: ver _send_json/_send_html, os 303
    # e os caminhos que escrevem direto no wfile.
    protocol_version = "HTTP/1.1"

    def version_string(self):
        # Nao anuncia Python/BaseHTTP: e a primeira coisa que um scanner de
        # rede le e nao ajuda ninguem que usa o app.
        return "Midnight Media Server"

    def handle_one_request(self):
        """Queda de cliente no meio do stream e rotina, nao bug: TV desligada,
        celular fora do Wi-Fi, player abortando o Range. As excecoes que sobravam
        disso (BrokenPipe, ConnectionReset, SSLError, o ValueError de "I/O
        operation on closed file" do wfile) viravam traceback inteiro no log —
        225 BrokenPipe + 22 SSL + 10 reset ate agora — afogando os erros de
        verdade. Aqui viram uma linha e a conexao fecha."""
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError,
                TimeoutError, ssl.SSLError, socket.timeout) as e:
            self.close_connection = True
            sys.stderr.write("[Midnight Media Server] conexao encerrada pelo cliente "
                             "(%s) em %s\n"
                             % (type(e).__name__, getattr(self, "path", "?")))
        except ValueError as e:
            if "closed file" not in str(e):
                raise
            self.close_connection = True

    def end_headers(self):
        # Impede a pagina de ser embutida em iframe de outro site (clickjacking).
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        self.send_header("Referrer-Policy", "same-origin")
        super().end_headers()

    def log_message(self, format, *args):
        # O http.server chama isto com aridades diferentes: log_request manda
        # 3 argumentos, send_error manda 2. O acesso fixo a args[2] estourava
        # IndexError dentro do proprio tratamento de erro — a resposta nunca
        # saia e o cliente ficava com a conexao fechada, sem nada. Era o que
        # acontecia com qualquer HEAD (nao existia do_HEAD).
        try:
            linha = " ".join(str(a) for a in args)
            # O token de midia (?t=) e uma credencial por arquivo: nao vai pro log.
            linha = re.sub(r"([?&]t=)[^&\s\"]+", r"\1***", linha)
            sys.stderr.write("[Midnight Media Server] " + linha + "\n")
        except Exception:
            pass

    def _reset_request_state(self):
        """A instancia do handler e reaproveitada em conexoes keep-alive —
        sem isso, cookies e usuario vazariam de uma requisicao para a seguinte."""
        self._pending_cookies = []
        self._user_cache = _UNSET
        self._info_cache = _UNSET
        set_perfil_atual("")
        # HEAD roda os mesmos caminhos do GET; esta flag e o que impede os
        # corpos de sairem (ver do_HEAD).
        self._head_only = False
        # Quanto do corpo do POST ja foi lido por esta rota — o que sobrar e
        # drenado no fim (ver _sobra_do_corpo).
        self._body_lido = 0

    def _cookies(self):
        jar = {}
        for part in (self.headers.get("Cookie") or "").split(";"):
            if "=" in part:
                k, v = part.split("=", 1)
                jar[k.strip()] = v.strip()
        return jar

    def _session_info(self):
        """Sessao da conta: {'account','profile','manage'} ou None. 'profile'
        e None enquanto a pessoa ainda nao escolheu quem esta assistindo."""
        if getattr(self, "_info_cache", _UNSET) is _UNSET:
            self._info_cache = _session_info(self._cookies().get(SESSION_COOKIE))
        return self._info_cache

    def _current_user(self):
        """O perfil escolhido (ou None). E o que o resto do servidor chama de
        usuario: papel, infantil e o dono do progresso de exibicao."""
        if getattr(self, "_user_cache", _UNSET) is _UNSET:
            self._user_cache = _session_user(
                self._cookies().get(SESSION_COOKIE))
            set_perfil_atual(self._user_cache["id"] if self._user_cache else "")
        return self._user_cache

    def _requisicao_local(self):
        """True quando a pagina esta sendo aberta no proprio computador: cliente
        em loopback e endereco localhost (nao o IP da rede)."""
        cliente = self.client_address[0] if self.client_address else ""
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        # Atras de nginx/caddy/cloudflared na mesma maquina todo cliente chega
        # como 127.0.0.1 com Host "localhost": qualquer um da internet veria o
        # codigo de instalacao e criaria o admin. Header de proxy = nao e local.
        for h in ("X-Forwarded-For", "X-Forwarded-Host", "Forwarded", "X-Real-IP",
                  "CF-Connecting-IP", "True-Client-IP"):
            if self.headers.get(h):
                return False
        return cliente in ("127.0.0.1", "::1") and host in ("localhost", "127.0.0.1", "::1")

    def _pagina_de_setup(self):
        return _login_page(setup=True,
                           codigo=_setup_code_value() if self._requisicao_local() else None)

    def _can_manage_profiles(self):
        """Perfil administrador, ou conta que acabou de redigitar a senha."""
        info = self._session_info()
        if not info:
            return False
        p = info["profile"]
        return bool(info["manage"] or (p and p.get("role") == "admin"))

    def _has_session(self):
        return self._current_user() is not None

    def _is_admin(self):
        user = self._current_user()
        return bool(user and user.get("role") == "admin")

    def _so_infantil(self):
        """True quando a sessão é de um perfil infantil.

        Perfil infantil não vê nem por URL direta o que não foi marcado:
        catálogo, detalhe e até o streaming são filtrados por isso.
        """
        user = self._current_user()
        return bool(user and user.get("infantil"))

    def _wants_html(self):
        return "text/html" in (self.headers.get("Accept") or "")

    def _client_ip(self):
        return self.client_address[0] if self.client_address else "?"

    def _queue_cookie(self, value):
        self._pending_cookies = list(getattr(self, "_pending_cookies", [])) + [value]

    def _cookie_secure(self):
        """Secure so em HTTPS: o acesso principal e HTTP na LAN
        (http://ip:9187), e um cookie Secure nunca voltaria por ele — o login
        daria certo e a sessao sumiria na requisicao seguinte."""
        return "; Secure" if isinstance(self.request, ssl.SSLSocket) else ""

    def _start_session(self, profile_id="", manage=False):
        self._user_cache = _UNSET
        self._info_cache = _UNSET
        manage_ate = time.time() + GERENCIAR_SEGUNDOS if manage else 0
        self._queue_cookie("%s=%s; Path=/; Max-Age=%d; HttpOnly; SameSite=Lax%s"
                           % (SESSION_COOKIE, _issue_session(profile_id, manage_ate),
                              SESSION_MAX_AGE, self._cookie_secure()))

    def _auth_gate(self, path, params):
        """Decide quem entra. O Chromecast nao manda cookie — para ele o acesso
        vem de um token assinado por arquivo, emitido por /api/cast-token."""
        # A fonte do app (so este arquivo, nome exato: nada de prefixo, senao um ".." liberaria o resto de static/) e publica: as telas de entrada
        # carregam antes de existir sessao.
        if path == "/static/fonts/jost-latin.woff2":
            return True
        if not _auth_configured():
            # Primeiro acesso: so a criacao do administrador responde.
            if path in ("/api/auth/setup", "/api/auth/status",
                        "/favicon.ico", "/favicon.svg"):
                return True
            if path in ("/", "/index.html", "/login") or self._wants_html():
                self._send_html(self._pagina_de_setup())
                return False
            self._send_json({"status": "error", "error": "setup_required"}, 401)
            return False

        if path in PUBLIC_PATHS:
            return True

        info = self._session_info()
        if info and not info["profile"]:
            # Entrou com a conta mas ainda nao escolheu o perfil: so o seletor
            # (e o que ele precisa) responde.
            if path in ACCOUNT_PATHS or path.startswith("/static/avatars/"):
                return True
            if path in ("/", "/index.html") or self._wants_html():
                self._send_html(_profiles_page())
                return False
            self._send_json({"status": "error", "error": "profile_required"}, 401)
            return False

        if self._has_session():
            if path in ADMIN_PATHS and not self._is_admin():
                self._send_json(
                    {"status": "error", "error": "Apenas administradores"}, 403)
                return False
            return True

        if path in TOKEN_PATHS and _valid_media_token(
                params.get("path", [""])[0], params.get("t", [""])[0]):
            return True

        if self._wants_html():
            self._send_html(_login_page(setup=False))
            return False
        self._send_json({"status": "error", "error": "auth_required"}, 401)
        return False

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0 or length > MAX_JSON_BODY_BYTES:
            return None
        try:
            raw = self.rfile.read(length)
            self._body_lido += length
            return json.loads(raw)
        except Exception:
            return None

    # ── Entrada ──────────────────────────────────────────────
    def _handle_auth_setup(self):
        if _auth_configured():
            self._send_json({"status": "error",
                             "error": "O administrador ja foi criado"}, 409)
            return
        ip = self._client_ip()
        if _login_blocked(ip):
            self._send_json({"status": "error", "error":
                             "Muitas tentativas. Espere alguns minutos."}, 429)
            return
        body = self._read_json_body() or {}
        if not hmac.compare_digest(str(body.get("code", "")).strip(),
                                   _setup_code_value()):
            _record_login_failure(ip)
            sys.stderr.write("[Midnight Media Server] codigo de instalacao errado de %s\n" % ip)
            self._send_json({"status": "error", "error":
                             "Codigo de instalacao incorreto. Ele aparece no "
                             "terminal onde o Midnight Media Server esta rodando."}, 403)
            return
        # O nome do app e sempre o padrao: nao se escolhe mais na instalacao.
        # (Instalacoes antigas com outro nome gravado no branding.json
        # continuam com ele — ver branding.get().)
        nome = _branding.NOME_PADRAO
        username = str(body.get("username", ""))
        pid, problem = _create_account(username, str(body.get("password", "")),
                                       str(body.get("perfil", "")))
        if problem:
            self._send_json({"status": "error", "error": problem}, 400)
            return
        _branding.set(nome=nome)
        _clear_login_failures(ip)
        adotar_progresso_orfao(pid)
        # O primeiro perfil (administrador) ja entra: o seletor aparece nos
        # proximos acessos, quando houver mais de um perfil.
        self._start_session(pid)
        print("[Midnight Media Server] Conta '%s' criada." % _norm_username(username),
              flush=True)
        self._send_json({"status": "ok"})

    def _handle_auth_login(self):
        ip = self._client_ip()
        if _login_blocked(ip):
            self._send_json({"status": "error", "error":
                             "Muitas tentativas. Espere alguns minutos."}, 429)
            return
        body = self._read_json_body() or {}
        username = str(body.get("username", ""))
        user = _check_credentials(username, str(body.get("password", "")))
        if not user:
            _record_login_failure(ip)
            sys.stderr.write("[Midnight Media Server] login recusado para '%s' de %s\n"
                             % (_norm_username(username), ip))
            # Mensagem unica: nao revela se a conta existe.
            self._send_json({"status": "error",
                             "error": "Usuario ou senha incorretos"}, 401)
            return
        _clear_login_failures(ip)
        # So a conta entrou: o perfil e escolhido no seletor.
        self._start_session("")
        self._send_json({"status": "ok", "user": user})

    def _handle_auth_logout(self, everywhere=False):
        if everywhere:
            # "Sair de todos os aparelhos" derruba as sessoes de TODAS as
            # contas — inclusive a do administrador. Qualquer conta logada
            # podia deslogar a casa inteira; agora e so admin.
            if not self._is_admin():
                self._send_json({"status": "error", "error":
                                 "Apenas o administrador pode encerrar todas as sessões"}, 403)
                return
            _revoke_all_sessions()
        self._queue_cookie("%s=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax%s"
                           % (SESSION_COOKIE, self._cookie_secure()))
        self._send_json({"status": "ok"})

    def _handle_cast_token(self):
        """Assina URLs para o Chromecast, que busca a midia sem cookie."""
        body = self._read_json_body() or {}
        media_path = str(body.get("path", ""))
        if not media_path:
            self._send_json({"status": "error", "error": "Missing path"}, 400)
            return
        subtitle = str(body.get("subtitle", ""))
        # Poster e fanart tambem saem por /api/stream, entao a TV precisa de um
        # token para cada um — senao a tela do Chromecast fica sem a arte.
        # Teto de 4: sao poster e fanart, nao uma galeria.
        extras = body.get("images")
        imgs = ([str(p) for p in extras[:4] if p]
                if isinstance(extras, list) else [])
        # Perfil infantil: o token e a credencial da TV e vale SEM sessao —
        # por isso o filtro tem que acontecer aqui na emissao. Checar so no
        # /api/stream nao adianta: quando quem pede e o Chromecast nao ha
        # cookie, e a sessao infantil nunca chega la.
        if self._so_infantil():
            alvos = [media_path] + ([subtitle] if subtitle else []) + imgs
            for alvo in alvos:
                if not self._permitido_infantil(alvo):
                    self._send_json({"status": "error",
                                     "error": "Filme não disponível neste perfil"}, 403)
                    return
        out = {"status": "ok", "t": _issue_media_token(media_path)}
        if subtitle:
            out["sub"] = _issue_media_token(subtitle)
        if imgs:
            out["imgs"] = {p: _issue_media_token(p) for p in imgs}
        self._send_json(out)

    def _handle_prepare(self):
        """Prepara um video para a TV (remux MP4/AAC — ver prepare.py).

        Idempotente e chamado a cada tentativa de cast: se ja existe cache
        da conversao, responde 'ready' na hora; senao agenda e devolve o
        estado para a UI acompanhar em /api/prepare-status."""
        body = self._read_json_body() or {}
        file_path = str(body.get("path", ""))
        if not file_path:
            self._send_json({"status": "error", "error": "Missing path"}, 400)
            return
        if self._so_infantil() and not self._permitido_infantil(file_path):
            self._send_json({"status": "error",
                             "error": "Filme não disponível neste perfil"}, 403)
            return
        # O prepare trabalha em fontes: local = path de disco; nuvem =
        # descriptor remoto (o prepare baixa e converte; ver _fonte_de).
        fonte = self._fonte_de(file_path)
        if fonte is None:
            # Nuvem/fonte remota sem descriptor: fica como sempre foi —
            # o receptor recebe o arquivo original.
            self._send_json({"needed": False, "state": "none"})
            return
        self._send_json(prepare.status(fonte, enqueue=True))

    # ── Painel de administracao ──────────────────────────────
    def _fonte_de(self, file_path):
        """Fonte do prepare para um path logico: path de disco ou nuvem.

        Local: o path real do arquivo, como sempre. Nuvem (kind 'cloud'):
        descriptor com a marca REMOTA do banco (size/mod_time) e a legenda
        sidecar escolhida pela mesma regra do disco — o prepare baixa os
        dois pelo 'rclone serve http', converte e apaga o palco. None =
        path fora das fontes; o chamador responde como sempre.
        """
        if not file_path:
            return None
        if _sources.is_local(file_path):
            real = _sources.local_real_path(file_path)
            return str(real) if real is not None else None
        try:
            src = _sources.resolve(file_path)
        except Exception:
            src = None
        if src is None or src.get("kind") != "cloud":
            return None
        return self._fonte_nuvem(file_path)

    def _fonte_nuvem(self, file_path):
        """Descriptor de prepare para um video da nuvem — video + legenda.

        O rclone serve nao expoe o arquivo como path de disco: as marcas
        (size/mod_time) que assinam o cache vem do banco, do mesmo
        listamento que alimenta a ficha. A legenda e a mesma que a ficha
        escolhe (prepare.escolhe_legenda). None = video nao esta no banco.
        """
        pasta, _, nome = str(file_path).rpartition("/")
        if not nome:
            return None
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT size, mod_time FROM files WHERE folder_path=? AND name=?",
                (pasta, nome)).fetchone()
            legs = [dict(l) for l in conn.execute(
                "SELECT name, size, mod_time FROM files "
                "WHERE folder_path=? AND file_type='subtitle'",
                (pasta,)).fetchall()]
        finally:
            conn.close()
        if row is None:
            return None
        sub = None
        nome_leg = prepare.escolhe_legenda(
            Path(nome).stem, [l["name"] for l in legs])
        if nome_leg:
            l = next((l for l in legs if l["name"] == nome_leg), None)
            if l:
                sub = {
                    "remoto": _serve_path(pasta + "/" + l["name"]),
                    "size": l["size"],
                    "mtime": l["mod_time"],
                    "nome": l["name"],
                }
        return {
            "kind": "nuvem",
            "remoto": _serve_path(file_path),
            "size": row["size"],
            "mtime": row["mod_time"],
            "sub": sub,
        }

    # ── Metadados (TMDB) e organizador ───────────────────────

    def _handle_scrape_key_set(self):
        body = self._read_json_body() or {}
        _scraper.set_api_key(str(body.get("api_key", "")))
        self._send_json({"status": "ok", "configurado": _scraper.configurado()})

    @staticmethod
    def _tipo_da_pasta(folder_path):
        conn = get_db()
        try:
            row = conn.execute("SELECT tipo FROM folders WHERE path=?",
                               (folder_path,)).fetchone()
        finally:
            conn.close()
        return row["tipo"] if row else "filme"

    def _handle_scrape_apply(self):
        body = self._read_json_body() or {}
        folder_path = str(body.get("path", "")).strip()
        try:
            tmdb_id = int(body.get("tmdb_id"))
        except (TypeError, ValueError):
            self._send_json({"status": "error", "error": "Faltou path ou tmdb_id"}, 400)
            return
        if not folder_path:
            self._send_json({"status": "error", "error": "Faltou path ou tmdb_id"}, 400)
            return
        if self._tipo_da_pasta(folder_path) == "serie":
            ok, erro, _n = _scraper.aplicar_serie(folder_path, tmdb_id)
        else:
            ok, erro = _scraper.aplicar(folder_path, tmdb_id)
        if not ok:
            self._send_json({"status": "error", "error": erro}, 502)
            return
        self._send_json({"status": "ok"})

    def _handle_scrape_capa(self):
        """Troca a capa de um filme local pela escolhida (nunca fanart)."""
        body = self._read_json_body() or {}
        folder_path = str(body.get("path", "")).strip()
        try:
            tmdb_id = int(body.get("tmdb_id"))
        except (TypeError, ValueError):
            tmdb_id = 0
        ok, erro = _scraper.aplicar_capa(folder_path, tmdb_id, str(body.get("poster_path", "")))
        if not ok:
            self._send_json({"status": "error", "error": erro}, 400)
            return
        # reindexa a fonte para o catalogo enxergar a capa nova
        src = _sources.resolve(folder_path)
        if src and src.get("id"):
            _scanner.start_background_scan(src["id"])
        self._send_json({"status": "ok"})

    def _handle_organizar_aplicar(self):
        body = self._read_json_body() or {}
        itens = body.get("itens")
        if not isinstance(itens, list) or not itens:
            self._send_json({"status": "error", "error": "Nada para organizar."}, 400)
            return
        source_id = str(body.get("source", ""))
        res, erro = _organizador.aplicar(source_id, [i for i in itens if isinstance(i, dict)])
        if erro:
            self._send_json({"status": "error", "error": erro}, 400)
            return
        if res["op"]:
            # reindexa a fonte: o catalogo passa a enxergar os novos caminhos
            _scanner.start_background_scan(source_id)
        self._send_json({"status": "ok", **res})

    def _handle_organizar_desfazer(self):
        body = self._read_json_body() or {}
        ok, erro = _organizador.desfazer(str(body.get("op", "")))
        if not ok:
            self._send_json({"status": "error", "error": erro}, 400)
            return
        op = next((o for o in _organizador.historico() if o["id"] == str(body.get("op", ""))), None)
        if op:
            _scanner.start_background_scan(op["source"])
        self._send_json({"status": "ok"})

    # ── Perfis ───────────────────────────────────────────────

    def _perfis_resposta(self, **extra):
        info = self._session_info() or {}
        me = info.get("profile")
        dados = {"status": "ok", "profiles": _list_profiles(),
                 "me": me["id"] if me else None,
                 "canManage": self._can_manage_profiles(),
                 "max": MAX_PERFIS, "avatars": list(AVATARES)}
        dados.update(extra)
        self._send_json(dados)

    def _handle_profiles_list(self):
        self._perfis_resposta()

    def _handle_profile_select(self):
        """Escolhe o perfil da sessao. Perfil com PIN pede os 4 numeros."""
        body = self._read_json_body() or {}
        pid = str(body.get("id", ""))
        perfil = _get_profile(pid)
        if not perfil:
            self._send_json({"status": "error", "error": "Perfil não encontrado"}, 404)
            return
        chave = "%s|pin|%s" % (self._client_ip(), pid)
        # Contador por perfil, alem do por IP: so o IP deixava quem troca de
        # endereco (IPv6 temporario) testar os 10 mil PINs sem parar.
        chave_perfil = "pin|%s" % pid
        if perfil.get("pin"):
            if _login_blocked(chave) or _login_blocked(chave_perfil):
                self._send_json({"status": "error", "error":
                                 "Muitas tentativas. Espere alguns minutos."}, 429)
                return
            if not _pin_confere(pid, str(body.get("pin", ""))):
                _record_login_failure(chave)
                _record_login_failure(chave_perfil)
                self._send_json({"status": "error", "error": "PIN incorreto"}, 401)
                return
            _clear_login_failures(chave)
        info = self._session_info() or {}
        self._start_session(pid, manage=bool(info.get("manage")))
        self._send_json({"status": "ok"})

    def _handle_profile_leave(self):
        """Volta ao seletor ("Trocar de perfil"), mantendo a conta logada."""
        self._start_session("")
        self._send_json({"status": "ok"})

    def _handle_profile_unlock(self):
        """Libera a edicao de perfis a partir do seletor: a conta redigita a
        senha. Vale 10 minutos nesta sessao."""
        ip = self._client_ip()
        if _login_blocked(ip):
            self._send_json({"status": "error", "error":
                             "Muitas tentativas. Espere alguns minutos."}, 429)
            return
        body = self._read_json_body() or {}
        conta = (self._session_info() or {}).get("account", "")
        if not _check_credentials(conta, str(body.get("password", ""))):
            _record_login_failure(ip)
            self._send_json({"status": "error", "error": "Senha incorreta"}, 401)
            return
        _clear_login_failures(ip)
        info = self._session_info() or {}
        self._start_session((info.get("profile") or {}).get("id", ""), manage=True)
        self._send_json({"status": "ok"})

    def _perfil_atual_id(self):
        return ((self._session_info() or {}).get("profile") or {}).get("id", "")

    def _handle_profile_save(self):
        if not self._can_manage_profiles():
            self._send_json({"status": "error",
                             "error": "Apenas administradores"}, 403)
            return
        body = self._read_json_body() or {}
        pid = str(body.get("id", ""))
        criado = None
        nome = body.get("name")
        avatar = body.get("avatar")
        infantil = bool(body.get("infantil"))
        role = "admin" if body.get("role") == "admin" else "user"
        if pid:
            problem = _update_profile(
                pid, name=None if nome is None else str(nome),
                avatar=None if avatar is None else str(avatar),
                infantil=infantil, role=role)
        else:
            novo, problem = _create_profile(str(nome or ""), str(avatar or ""),
                                            infantil=infantil, role=role)
            if not problem:
                pid = novo["id"]
                criado = pid
        if problem:
            self._send_json({"status": "error", "error": problem}, 400)
            return
        if pid and pid == self._perfil_atual_id():
            # Mudar o proprio papel derruba a sessao: renova a atual.
            info = self._session_info() or {}
            self._start_session(pid, manage=bool(info.get("manage")))
        self._perfis_resposta(created=criado)

    def _handle_profile_pin(self):
        """Define ou remove o PIN. Quem gerencia mexe em qualquer perfil; cada
        pessoa (que nao seja perfil infantil) mexe no seu, confirmando o PIN
        atual quando ja existe."""
        body = self._read_json_body() or {}
        pid = str(body.get("id", ""))
        perfil = _get_profile(pid)
        if not perfil:
            self._send_json({"status": "error", "error": "Perfil não encontrado"}, 404)
            return
        proprio = pid == self._perfil_atual_id()
        if not self._can_manage_profiles():
            if not proprio or perfil.get("infantil"):
                self._send_json({"status": "error",
                                 "error": "Apenas administradores"}, 403)
                return
            if perfil.get("pin"):
                chave = "%s|pin|%s" % (self._client_ip(), pid)
                chave_perfil = "pin|%s" % pid
                if (_login_blocked(chave) or _login_blocked(chave_perfil)
                        or not _pin_confere(pid, str(body.get("current", "")))):
                    _record_login_failure(chave)
                    _record_login_failure(chave_perfil)
                    self._send_json({"status": "error", "error": "PIN atual incorreto"}, 401)
                    return
        novo = body.get("pin")
        problem = _set_pin(pid, None if novo in (None, "") else str(novo))
        if problem:
            self._send_json({"status": "error", "error": problem}, 400)
            return
        if proprio:
            info = self._session_info() or {}
            self._start_session(pid, manage=bool(info.get("manage")))
        self._perfis_resposta()

    def _handle_profile_delete(self):
        if not self._can_manage_profiles():
            self._send_json({"status": "error",
                             "error": "Apenas administradores"}, 403)
            return
        pid = str((self._read_json_body() or {}).get("id", ""))
        if pid == self._perfil_atual_id():
            self._send_json({"status": "error", "error":
                             "Não dá para remover o perfil em uso. Troque de perfil antes."}, 400)
            return
        problem = _delete_profile(pid)
        if problem:
            self._send_json({"status": "error", "error": problem}, 400)
            return
        apagar_progresso_do_perfil(pid)
        self._perfis_resposta()

    def _media_token_ok(self):
        """True quando a requisicao traz um token de midia valido para o proprio
        arquivo que ela pede.

        E a credencial do Chromecast: ele busca a midia sozinho, sem cookie. O
        token e assinado por HMAC, vale para um arquivo so e expira em 12h; so
        e emitido por /api/cast-token, que exige sessao e Origin local.
        """
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path not in TOKEN_PATHS:
            return False
        params = urllib.parse.parse_qs(parsed.query)
        return _valid_media_token(params.get("path", [""])[0],
                                  params.get("t", [""])[0])

    def _security_gate(self):
        """Bloqueia DNS rebinding (Host publico) e leitura cross-site (Origin de
        terceiro). Chromecast e <video> nao mandam Origin e passam normalmente."""
        if not _host_allowed(self.headers.get("Host")):
            self._send_error("Host nao permitido", 403)
            return False
        if (self.command == "POST" and self.headers.get("Origin")
                and not _origin_mesmo_servidor(
                    self.headers.get("Origin"), self.headers.get("Host"),
                    [PORT] + list(range(HTTPS_PORT_BASE, HTTPS_PORT_BASE + 50)))):
            self._send_error("Origem nao permitida", 403)
            return False
        if not _origin_allowed(self.headers.get("Origin")):
            # O receiver do Chromecast busca a faixa de legenda COM CORS — e
            # exigencia do Cast para faixas de texto — entao manda um Origin de
            # terceiro (ou "null"). O video passa porque elemento de midia nao
            # manda Origin; a legenda batia aqui e morria em 403.
            # Liberar so faz sentido porque nessas rotas quem autoriza e o token
            # por arquivo, nao a origem: o cookie de sessao e SameSite=Lax e nem
            # viaja numa requisicao cross-site.
            if not self._media_token_ok():
                self._send_error("Origem nao permitida", 403)
                return False
        return True

    def do_OPTIONS(self):
        """Preflight de CORS.

        O receiver do Chromecast faz um OPTIONS antes de buscar a legenda. Sem
        do_OPTIONS o BaseHTTPRequestHandler nem responde, e a faixa some sem
        erro visivel.
        """
        self._reset_request_state()
        if not _host_allowed(self.headers.get("Host")):
            self._send_error("Host nao permitido", 403)
            return
        origin = self.headers.get("Origin")
        if (urllib.parse.urlparse(self.path).path not in TOKEN_PATHS
                or not (_origin_allowed(origin) or self._media_token_ok())):
            self._send_error("Origem nao permitida", 403)
            return
        self.send_response(204)
        self._send_media_cors()
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        """Sonda de cabecalhos: e como players e receivers (Chromecast, e o
        AirPlay do Roku) perguntam tipo, tamanho e suporte a Range antes de
        baixar a midia. Sem este metodo o http.server respondia 501, o
        log_message customizado quebrava no meio do send_error e a conexao
        morria sem resposta nenhuma — a TV ficava presa em "conectando" e o
        filme nunca comecava.

        Roda os mesmos caminhos do GET: os corpos nao saem por causa de
        self._head_only (ver os guards espalhados pelo arquivo)."""
        self._reset_request_state()
        self._head_only = True
        if not self._security_gate():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        params = urllib.parse.parse_qs(parsed.query)

        if not self._auth_gate(path, params):
            return

        if path == "/api/stream":
            file_path = params.get("path", [""])[0]
            if not file_path:
                self._send_error("Missing 'path' parameter", 400)
                return
            if self._so_infantil() and not self._permitido_infantil(file_path):
                self._send_error("Filme não disponível neste perfil", 403)
                return
            self._stream_file(file_path)
            return

        if path == "/api/prepared":
            file_path = params.get("path", [""])[0]
            if not file_path:
                self._send_error("Missing 'path' parameter", 400)
                return
            if self._so_infantil() and not self._permitido_infantil(file_path):
                self._send_error("Filme não disponível neste perfil", 403)
                return
            self._serve_prepared(file_path)
            return

        if path == "/api/subtitle":
            file_path = params.get("path", [""])[0]
            if not file_path:
                self._send_error("Missing 'path' parameter", 400)
                return
            if self._so_infantil() and not self._permitido_infantil(file_path):
                self._send_error("Legenda não disponível neste perfil", 403)
                return
            self._serve_subtitle(file_path)
            return

        if path == "/login":
            if self._session_info():
                self.send_response(303)
                self.send_header("Location", "/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self._send_html(self._pagina_de_setup() if not _auth_configured() else _login_page())
            return

        if path == "/" or path == "/index.html":
            self._send_html(self._index_html())
            return

        if path == "/favicon.ico" or path == "/favicon.svg":
            self._serve_file(path)
            return

        if path.startswith("/static/"):
            self._serve_file(path)
            return

        # Mesma resposta do GET para caminho desconhecido (sem corpo).
        self._send_error("Not found", 404)

    def _require_write_origin(self):
        """Operacoes que alteram estado exigem Origin local explicito — e o que
        impede CSRF disparado por <img> ou <form> a partir de qualquer site."""
        origin = self.headers.get("Origin")
        if not origin or not _origin_allowed(origin):
            self._send_json(
                {"status": "error", "error": "Origem invalida para operacao de escrita"}, 403)
            return False
        return True

    def _send_media_cors(self):
        """CORS restrito: '*' apenas quando nao ha Origin (Chromecast, <video>,
        download direto). Com Origin, ecoa se for local — ou se o token de midia
        autorizar, que e o caso da legenda buscada pelo receiver do Cast."""
        origin = self.headers.get("Origin")
        if not origin:
            self.send_header("Access-Control-Allow-Origin", "*")
        elif _origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        elif self._media_token_ok():
            # "null" nao pode ser ecoado; vira "*", que aqui nao concede nada
            # alem do que o token assinado ja concedeu.
            self.send_header("Access-Control-Allow-Origin",
                             "*" if origin == "null" else origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Expose-Headers",
                         "Content-Length, Content-Range, Accept-Ranges")

    def _send_exception(self, e, status=500):
        """Detalhe completo no log do servidor, mensagem generica para o cliente."""
        sys.stderr.write("[Midnight Media Server] %s: %r\n" % (self.path, e))
        self._send_json({"status": "error", "error": "Erro interno — veja o log do servidor"}, status)

    def _aceita_gzip(self):
        return "gzip" in (self.headers.get("Accept-Encoding") or "").lower()

    def _send_json(self, data, status=200):
        # Corpo montado antes dos cabecalhos: com HTTP/1.1 o Content-Length
        # e obrigatorio (ver protocol_version no topo da classe).
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        gz = len(body) > 1024 and self._aceita_gzip()
        if gz:
            body = gzip.compress(body, compresslevel=5, mtime=0)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-cache")
        for cookie in getattr(self, "_pending_cookies", ()):
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        if not self._head_only:
            self.wfile.write(body)

    def _send_html(self, content, status=200):
        body = content.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        for cookie in getattr(self, "_pending_cookies", ()):
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        if not self._head_only:
            self.wfile.write(body)

    def _send_error(self, msg, status=500):
        self._send_json({"error": msg}, status)

    def _index_html(self):
        """Monta o HTML da raiz do app. GET e HEAD usam o mesmo conteudo."""
        html_content = FRONTEND_PATH.read_text(encoding="utf-8") if FRONTEND_PATH.exists() else "<h1>Midnight Media Server</h1><p>Frontend not found.</p>"
        # Troca o nome de exibicao antes de servir: fazer isso por
        # JavaScript depois piscaria "Midnight Media Server" por um instante a cada
        # carregamento, em qualquer instalacao que tenha escolhido outro
        # nome. So esse texto muda — CACHE_DIR, nome do banco e do
        # servico continuam fixos, de proposito (ver branding.py).
        html_content = html_content.replace(NOME_PADRAO, _branding.get()["nome"])
        # Inject HTTP base URL for Chromecast media streaming
        # (Chromecast doesn't trust self-signed certs, so media must use HTTP)
        local_ip = _get_local_ip()
        # Dados de rede das instrucoes "Instalar no celular" (Ajustes): o nome
        # .local que o certificado cobre, o IP de reserva e as portas reais.
        # So entram no HTML autenticado — a tela de login nao recebe nada disto.
        net_info = {
            "host": _primary_local_hostname(),
            "ip": local_ip,
            "httpPort": PORT,
            "httpsPort": active_https_port(),
        }
        html_content = html_content.replace(
            "</head>",
            f"<script>window.__HTTP_BASE__='http://{local_ip}:{PORT}';"
            f"window.__LOGICAL_ROOT__={json.dumps(_branding.logical_root())};"
            f"window.__NET__={json.dumps(net_info)};</script></head>",
            1
        )
        return _bust_asset_cache(html_content)

    def _stream_file(self, path):
        """Stream a file, escolhendo o caminho pela fonte dona do path."""
        ext = Path(path).suffix.lower()

        # Fonte local (HD externo, pendrive, disco): os bytes ja estao aqui —
        # nada de rclone, nada de cache intermediario.
        if _sources.is_local(path):
            self._stream_local(path)
            return
        if _sources.under_local_root(path):
            # Path de fonte local que nao existe mais. Nao pode escorregar pro
            # ramo do rclone: viraria um 502 sem sentido.
            self._send_error("Fonte local nao encontrada — ela foi removida?", 404)
            return

        # Small images: cache locally after first fetch
        if ext in IMAGE_EXTENSIONS:
            self._stream_image_cached(path)
            return

        # Videos and other files: proxy through rclone serve or fallback
        self._stream_video_direct(path)

    @staticmethod
    def _parse_range(range_header, size):
        """"bytes=inicio-fim" -> (inicio, fim) inclusivo, ou None se invalido.

        Cobre tambem a forma sufixo ("bytes=-500", os ultimos 500 bytes), que o
        <video> usa para ler o final do container antes de tocar um .mp4.
        """
        if not range_header or not range_header.startswith("bytes="):
            return None
        # Multiplos ranges numa requisicao exigiriam multipart/byteranges; o
        # player nunca pede isso, entao atendemos o primeiro.
        spec = range_header[len("bytes="):].split(",")[0].strip()
        first, sep, last = spec.partition("-")
        if not sep:
            return None
        try:
            if not first:
                n = int(last)
                if n <= 0:
                    return None
                start = max(0, size - n)
                end = size - 1
            else:
                start = int(first)
                end = int(last) if last else size - 1
        except ValueError:
            return None
        if start < 0 or start >= size or start > end:
            return None
        return start, min(end, size - 1)

    def _stream_local(self, path):
        """Serve do disco um arquivo de fonte local (com Range)."""
        real = _sources.local_real_path(path)
        if real is None:
            # Path fora da raiz da fonte (ou fonte inexistente). Nunca detalhar
            # o motivo: isso viraria uma sonda do sistema de arquivos.
            self._send_error("Forbidden", 403)
            return
        ext = Path(path).suffix.lower()
        if ext in IMAGE_EXTENSIONS and not self._quer_full():
            # Miniatura para o grid; a ficha e o fanart continuam no original.
            mini = _thumbs.miniatura_para(real, self._tipo_de_imagem(path))
            if mini is not None:
                real = mini
        self._serve_real_file(real, self._guess_mime(path),
                              cache_imagem=ext in IMAGE_EXTENSIONS)

    def _serve_prepared(self, path):
        """Serve o MP4 gerado pelo prepare.py (cache de conversao para TV).

        O token do cast assina o path ORIGINAL — o receptor nao conhece o
        arquivo convertido; o de-para original->cache mora no prepare.py.
        Vale para fonte local e para nuvem (o descriptor vem do banco)."""
        fonte = self._fonte_de(path)
        mp4 = prepare.prepared_file(fonte) if fonte is not None else None
        if mp4 is None:
            self._send_error("Video ainda nao foi preparado", 404)
            return
        prepare.mark_used(fonte)
        self._serve_real_file(mp4, "video/mp4")

    def _serve_real_file(self, real, mime, cache_imagem=False):
        """Serve um arquivo real do disco com suporte a Range.

        O Range e o que faz o <video> conseguir pular no meio do filme: sem
        206 + Content-Range o player so consegue tocar do inicio.
        """
        try:
            if not real.is_file():
                raise FileNotFoundError
            size = real.stat().st_size
        except OSError:
            self._send_error("Arquivo indisponivel — a fonte esta conectada?", 404)
            return

        range_header = self.headers.get("Range")
        start, end = 0, max(size - 1, 0)
        partial = False

        if range_header and size > 0:
            parsed = self._parse_range(range_header, size)
            if parsed is None:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self._send_media_cors()
                self.end_headers()
                return
            start, end = parsed
            partial = True

        length = (end - start + 1) if size > 0 else 0

        self.send_response(206 if partial else 200)
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(length))
        self.send_header("Content-Type", mime)
        self.send_header("Accept-Ranges", "bytes")
        if cache_imagem:
            self.send_header("Cache-Control", "max-age=86400")
        self._send_media_cors()
        self.end_headers()

        if self._head_only:
            return

        try:
            # Enquanto os bytes do video saem daqui, o Mac nao pode dormir.
            with keepawake.while_streaming():
                with open(real, "rb") as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        buf = f.read(min(_STREAM_BUFFER, remaining))
                        if not buf:
                            break
                        self.wfile.write(buf)
                        remaining -= len(buf)
        except (BrokenPipeError, ConnectionResetError):
            pass   # o player fechou ou pulou pra outro trecho
        except OSError as e:
            sys.stderr.write(f"[Midnight Media Server] Falha lendo arquivo local: {e}\n")

    def _quer_full(self):
        """?full=1 pede a imagem original — miniatura e o padrao do grid."""
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        return q.get("full", ["0"])[0] == "1"

    @staticmethod
    def _tipo_de_imagem(path):
        """file_type da imagem no catalogo ('' quando nao consta).

        So fanart escapa da miniatura: ele e o fundo de tela em tamanho
        cheio, onde 640 px apareceria serrilhado num monitor grande.
        """
        partes = path.strip("/").split("/")
        if len(partes) < 2:
            return ""
        try:
            conn = get_db()
            try:
                row = conn.execute(
                    "SELECT file_type FROM files WHERE folder_path=? AND name=?",
                    ("/" + "/".join(partes[:-1]), partes[-1])).fetchone()
            finally:
                conn.close()
        except Exception:
            return ""
        return row["file_type"] if row else ""

    def _serve_imagem_do_cache(self, cache_path, path):
        """Serve a imagem do cache local, em miniatura quando valer a pena.

        O grid pede dezenas de posteres em cartoes de ~300 px; servir o
        original de 1-2 MB em cada um era o maior desperdicio da home. A
        chave da miniatura embute mtime+tamanho do original, entao gerar
        acontece uma vez por versao da imagem."""
        serve = cache_path
        if not self._quer_full():
            mini = _thumbs.miniatura_para(cache_path, self._tipo_de_imagem(path))
            if mini is not None:
                serve = mini
        mime, _ = mimetypes.guess_type(str(serve))
        if mime is None:
            mime = "image/jpeg"
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(serve.stat().st_size))
        self.send_header("Cache-Control", "max-age=86400")
        self._send_media_cors()
        self.end_headers()
        if not self._head_only:
            with open(serve, "rb") as f:
                shutil.copyfileobj(f, self.wfile, _STREAM_BUFFER)

    def _stream_image_cached(self, path):
        """Stream an image file, caching it locally on first access."""
        cache_key = _chave_de_cache("img", path)
        cache_path = IMAGE_CACHE_DIR / cache_key

        # Serve from local cache if available
        if cache_path.exists():
            self._serve_imagem_do_cache(cache_path, path)
            return

        # Sonda (HEAD): nao vale baixar a imagem inteira so pra responder
        # cabecalho — o caminho direto pelo rclone ja devolve tipo e tamanho.
        if self._head_only:
            self._stream_video_direct(path)
            return

        # Not cached yet — download via rclone proxy with retry
        safe_path = urllib.parse.quote(_serve_path(path), safe="/")
        rclone_url = f"http://localhost:{RCLONE_SERVE_PORT}/{safe_path}"

        # Retry up to 3 times with 0.5s delay (rclone serve may still be starting)
        last_error = None
        for attempt in range(3):
            try:
                req = urllib.request.Request(rclone_url, method="GET")
                resp = urllib.request.urlopen(req, timeout=60)

                data = resp.read()
                mime = resp.headers.get("Content-Type", "image/jpeg")

                # Save to local cache
                try:
                    with open(cache_path, "wb") as f:
                        f.write(data)
                    sys.stderr.write(f"[Midnight Media Server] Cached image: {cache_key} ({len(data)}B)\n")
                except Exception as e:
                    sys.stderr.write(f"[Midnight Media Server] Cache write failed: {e}\n")

                if cache_path.exists():
                    # Gravado no cache: serve pelo caminho comum, que ja
                    # aplica a miniatura na primeira visita.
                    self._serve_imagem_do_cache(cache_path, path)
                    return

                self.send_response(200)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "max-age=86400")
                self._send_media_cors()
                self.end_headers()
                self.wfile.write(data)
                return
            except Exception as e:
                last_error = e
                if attempt < 2:
                    time.sleep(0.5)
                    continue

        # All retries failed — fallback to direct
        sys.stderr.write(f"[Midnight Media Server] Image cache proxy failed after retries: {last_error}\n")
        self._stream_file_direct(path)

    def _stream_video_direct(self, path):
        """Stream video directly via rclone HTTP serve, proxying through same server.
        Uses http.client + shutil.copyfileobj for zero-buffer streaming."""
        safe_path = urllib.parse.quote(_serve_path(path), safe="/")
        range_header = self.headers.get("Range")
        mime = self._guess_mime(path)

        import http.client
        try:
            conn = http.client.HTTPConnection("localhost", RCLONE_SERVE_PORT, timeout=60)
            conn.request("GET", "/" + safe_path, headers={"Range": range_header} if range_header else {})
            resp = conn.getresponse()

            status = resp.status
            cl = resp.getheader("Content-Length")
            cr = resp.getheader("Content-Range")

            # Se rclone devolveu erro, não repassa o body — retorna erro limpo
            if status in (404, 500, 502, 503):
                resp.read()
                resp.close()
                conn.close()
                sys.stderr.write(f"[Midnight Media Server] rclone error {status} for {path}\n")
                self._send_error("Video not available from storage", 502)
                return

            if status == 206:
                self.send_response(206)
                if cr:
                    self.send_header("Content-Range", cr)
            else:
                self.send_response(200)

            if cl:
                self.send_header("Content-Length", cl)
            else:
                # Sem tamanho nao da pra delimitar o corpo em keep-alive:
                # fecha a conexao no fim, como era antes do HTTP/1.1.
                self.send_header("Connection", "close")
            self.send_header("Content-Type", mime)
            self.send_header("Accept-Ranges", "bytes")
            self._send_media_cors()
            self.end_headers()

            if self._head_only:
                resp.close()
                conn.close()
                return

            # Stream direto do socket do rclone pro socket do browser
            with keepawake.while_streaming():
                shutil.copyfileobj(resp, self.wfile, _STREAM_BUFFER)
            resp.close()
            conn.close()

            # Mark as VFS-cached if range covered the last byte
            if status == 206 and range_header:
                try:
                    file_info = cached_get_file_info(path)
                    file_size = file_info.get("Size", 0) if file_info else 0
                    if file_size > 0:
                        range_match = range_header.replace("bytes=", "").split("-")
                        range_end = int(range_match[1]) if len(range_match) > 1 and range_match[1] else None
                        if range_end is not None and range_end >= file_size - 1:
                            _mark_file_cached(path)
                except Exception:
                    pass
        except Exception as e:
            sys.stderr.write(f"[ERROR] Video stream failed: {e}\n")
            self._stream_file_direct(path)

    def _stream_file_direct(self, path):
        """Fallback: stream directly via rclone cat (original method)."""
        try:
            remote_path = _rc_remote(path)
        except CaminhoInvalido:
            self._send_error("File not found", 404)
            return

        file_info = cached_get_file_info(path)
        file_size = file_info.get("Size", 0) if file_info else 0

        range_header = self.headers.get("Range")
        start = 0
        end = file_size - 1 if file_size > 0 else None
        chunk_size = 10 * 1024 * 1024

        if range_header:
            range_match = range_header.replace("bytes=", "").split("-")
            try:
                start = int(range_match[0]) if range_match[0] else 0
                if len(range_match) > 1 and range_match[1]:
                    end = int(range_match[1])
                    chunk_size = end - start + 1
                else:
                    end = min(start + chunk_size, file_size - 1) if file_size > 0 else start + chunk_size
                    chunk_size = end - start + 1
            except (ValueError, IndexError):
                pass
        else:
            end = min(chunk_size - 1, file_size - 1) if file_size > 0 else chunk_size - 1
            chunk_size = end + 1

        cat_cmd = ["rclone", "cat"]
        if start > 0:
            cat_cmd.extend(["--offset", str(start)])
        cat_cmd.extend(["--count", str(chunk_size)])
        cat_cmd.append(remote_path)

        mime = self._guess_mime(path)

        if range_header:
            self.send_response(206)
            content_range = f"bytes {start}-{end}/{file_size}" if file_size > 0 else f"bytes {start}-{end}/*"
            self.send_header("Content-Range", content_range)
            self.send_header("Content-Length", str(chunk_size))
            self.send_header("Accept-Ranges", "bytes")
            self._send_media_cors()
            self.send_header("Content-Type", mime)
            self.end_headers()
        else:
            self.send_response(200)
            self.send_header("Content-Length", str(chunk_size))
            self.send_header("Accept-Ranges", "bytes")
            self._send_media_cors()
            self.send_header("Content-Type", mime)
            self.end_headers()

        if self._head_only:
            return

        try:
            proc = subprocess.Popen(cat_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            with keepawake.while_streaming():
                remaining = chunk_size
                while remaining > 0:
                    buf = proc.stdout.read(min(65536, remaining))
                    if not buf:
                        break
                    self.wfile.write(buf)
                    remaining -= len(buf)
            proc.stdout.close()
            proc.wait(timeout=10)
            # If range covers the last byte of the file, the whole file is cached by rclone
            if proc.returncode == 0 and file_size > 0 and end is not None and end >= file_size - 1:
                _mark_file_cached(path)
        except Exception as e:
            sys.stderr.write(f"[ERROR] Direct stream failed: {e}\n")

    @staticmethod
    def _decode_subtitle(raw_bytes):
        """UTF-8 primeiro, latin-1 depois (encoding comum em SRT antigo)."""
        try:
            return raw_bytes.decode("utf-8")
        except UnicodeDecodeError:
            return raw_bytes.decode("latin-1")

    def _read_subtitle_text(self, path):
        """Texto bruto da legenda, buscado na fonte dona do path.

        Legenda de fonte local vem direto do disco — nao faz sentido copiar pro
        cache um arquivo que ja e local. A da nuvem continua no rclone cat com
        cache em disco.
        """
        if _sources.is_local(path):
            real = _sources.local_real_path(path)
            if real is None or not real.is_file():
                return None
            try:
                return self._decode_subtitle(real.read_bytes())
            except OSError:
                return None

        cache_key = _chave_de_cache("sub", path)
        cache_path = SUBS_CACHE_DIR / cache_key
        try:
            if cache_path.exists():
                return cache_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            pass

        try:
            result = subprocess.run(
                ["rclone", "cat", _rc_remote(path)],
                capture_output=True, timeout=30
            )
            if result.returncode != 0:
                return None
            raw = self._decode_subtitle(result.stdout)
        except Exception as e:
            sys.stderr.write(f"[Midnight Media Server] Subtitle fetch failed: {e}\n")
            return None

        # Cache local (sempre UTF-8)
        try:
            cache_path.write_text(raw, encoding="utf-8")
        except Exception:
            pass
        return raw

    def _serve_subtitle(self, path):
        """Serve a subtitle file, converting SRT→VTT if needed."""
        # So legenda: sem isso a rota lia qualquer arquivo que o rclone alcance.
        if Path(str(path)).suffix.lower() not in SUBTITLE_EXTENSIONS:
            self._send_error("Subtitle not found", 404)
            return
        if _sources.under_local_root(path) and not _sources.is_local(path):
            self._send_error("Fonte local nao encontrada — ela foi removida?", 404)
            return
        raw = self._read_subtitle_text(path)
        if raw is None:
            self._send_error("Subtitle not found", 404)
            return

        ext = Path(path).suffix.lower()

        # SRT → WebVTT conversion (browsers don't support SRT natively)
        if ext == ".srt":
            # Normalize line endings (CRLF de SRTs de Windows)
            text = raw.replace("\r\n", "\n").replace("\r", "\n").lstrip("\n")
            lines = text.split("\n")
            # Cabeçalho WEBVTT SEMPRE seguido de linha em branco — parsers
            # estritos (receiver do Chromecast) rejeitam o arquivo sem ela
            vtt = ["WEBVTT", ""]
            for line in lines:
                # SRT: 00:00:10,500 --> 00:00:13,000
                # VTT: 00:00:10.500 --> 00:00:13.000
                if "-->" in line:
                    line = line.replace(",", ".")
                vtt.append(line)
            body = "\n".join(vtt)
        else:
            # VTT/ASS already supported or passed through
            body = raw

        # Content-Length em BYTES, nao em caracteres: legenda com acento tem
        # mais bytes que caracteres em UTF-8 e chegava truncada no player.
        payload = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/vtt; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self._send_media_cors()
        self.send_header("Cache-Control", "max-age=3600")
        self.end_headers()
        if not self._head_only:
            self.wfile.write(payload)

    def _guess_mime(self, path):
        """Guess MIME type for a file."""
        mime, _ = mimetypes.guess_type(path)
        if mime:
            return mime
        ext = Path(path).suffix.lower()
        MIME_MAP = {
            ".mp4": "video/mp4",
            ".mkv": "video/x-matroska",
            ".webm": "video/webm",
            ".mov": "video/quicktime",
            ".avi": "video/x-msvideo",
            ".wmv": "video/x-ms-wmv",
            ".flv": "video/x-flv",
            ".m4v": "video/mp4",
            ".mpg": "video/mpeg",
            ".mpeg": "video/mpeg",
            ".ts": "video/mp2t",
            ".3gp": "video/3gpp",
            ".ogg": "video/ogg",
        }
        return MIME_MAP.get(ext, "application/octet-stream")

    def _serve_file(self, path):
        """Serve arquivo estatico. Ancorado numa allowlist: apenas os favicons da
        raiz e o conteudo de static/. Antes a raiz inteira era alcancavel via
        /static/../ — o que expunha server.py e o diretorio .git.

        A raiz vem do config, nao de Path(__file__): este modulo mora dentro do
        pacote, um nivel abaixo dos favicons."""
        project_root = PROJECT_ROOT
        rel = path.lstrip("/")
        if rel in ("favicon.ico", "favicon.svg"):
            base = project_root
        elif rel.startswith("static/"):
            base = project_root / "static"
            rel = rel[len("static/"):]
        else:
            self._send_error("Forbidden", 403)
            return
        # A contencao e conferida no texto do caminho (normpath), nao seguindo
        # symlinks: no app empacotado do macOS os arquivos de dados sao links
        # para Resources/, e resolver os dois lados os fazia "sair" de static/.
        try:
            requested = Path(os.path.normpath(base / rel))
            requested.relative_to(Path(os.path.normpath(base)))
        except (ValueError, RuntimeError):
            self._send_error("Forbidden", 403)
            return
        if not requested.exists() or not requested.is_file():
            self._send_error("File not found", 404)
            return
        mime, _ = mimetypes.guess_type(str(requested))
        if mime is None:
            mime = "application/octet-stream"
        st = requested.stat()
        # O index.html carimba os estaticos com ?v=<mtime> (_bust_asset_cache):
        # URL com versao nunca muda de conteudo, entao o navegador pode guardar
        # por um ano. Sem versao, continua 1h.
        versionado = "v=" in urllib.parse.urlparse(self.path).query
        corpo = None
        if (self._aceita_gzip() and st.st_size > 1024
                and (mime.startswith("text/") or mime in (
                    "application/javascript", "text/javascript",
                    "application/json", "image/svg+xml"))):
            chave = (str(requested), st.st_mtime_ns, st.st_size)
            corpo = _GZIP_ESTATICOS.get(chave)
            if corpo is None:
                corpo = gzip.compress(requested.read_bytes(), compresslevel=6, mtime=0)
                if len(_GZIP_ESTATICOS) > 64:
                    _GZIP_ESTATICOS.clear()
                _GZIP_ESTATICOS[chave] = corpo
        self.send_response(200)
        self.send_header("Content-Type", mime)
        if corpo is not None:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(corpo) if corpo is not None else st.st_size))
        self.send_header("Cache-Control",
                         "public, max-age=31536000, immutable" if versionado else "max-age=3600")
        self.end_headers()
        if not self._head_only:
            if corpo is not None:
                self.wfile.write(corpo)
            else:
                with open(requested, "rb") as f:
                    shutil.copyfileobj(f, self.wfile)

    def _generate_backup_zip(self):
        """Generate backup zip to a temporary file. Returns path to temp file."""
        import tempfile
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
        try:
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
                db_path = Path(DB_PATH)
                if db_path.exists():
                    z.write(db_path, "media-server.db")
                img_dir = Path(IMAGE_CACHE_DIR)
                if img_dir.exists():
                    for f in sorted(img_dir.iterdir()):
                        if f.is_file():
                            z.write(f, f"images/{f.name}")
                subs_dir = Path(SUBS_CACHE_DIR)
                if subs_dir.exists():
                    for f in sorted(subs_dir.iterdir()):
                        if f.is_file():
                            z.write(f, f"subs/{f.name}")
            tmp.close()
            return tmp.name
        except Exception:
            tmp.close()
            os.unlink(tmp.name)
            raise

    def _serve_backup(self):
        """Generate and serve a zip backup of DB + images + subs (streamed)."""
        import tempfile
        zip_path = None
        try:
            zip_path = self._generate_backup_zip()
            zip_size = os.path.getsize(zip_path)
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Disposition", 'attachment; filename="media-server-backup.zip"')
            self.send_header("Content-Length", str(zip_size))
            self._send_media_cors()
            self.end_headers()
            with open(zip_path, "rb") as f:
                shutil.copyfileobj(f, self.wfile)
        except Exception as e:
            sys.stderr.write(f"[Midnight Media Server] Backup failed: {e}\n")
            self._send_error("Failed to generate backup")
        finally:
            if zip_path and os.path.exists(zip_path):
                try:
                    os.unlink(zip_path)
                except Exception:
                    pass

    def _backup_to_cloud(self):
        """Gera o zip e sobe pro remote da nuvem conectada.

        Escreve na pasta de backups do próprio remote cadastrado em
        Ajustes > Nuvem."""
        zip_path = None
        try:
            zip_path = self._generate_backup_zip()
            filename = f"media-server-backup-{time.strftime('%Y-%m-%d')}.zip"
            remote_path = destino_backup() + "/" + filename

            with open(zip_path, "rb") as f:
                data = f.read()

            proc = subprocess.run(
                ["rclone", "rcat", remote_path],
                input=data,
                capture_output=True,
                timeout=120
            )
            if proc.returncode != 0:
                err = proc.stderr.decode(errors="replace").strip()
                if "didn't find section in config file" in err:
                    return {"ok": False, "error":
                            "O remote de backup nao esta configurado. "
                            "Cadastre a nuvem em Ajustes > Nuvem."}
                return {"ok": False, "error": f"rclone failed: {err}"}

            return {"ok": True, "path": f"{BACKUP_FOLDER}/{filename}"}
        except Exception as e:
            return {"ok": False, "error": str(e)}
        finally:
            if zip_path and os.path.exists(zip_path):
                try:
                    os.unlink(zip_path)
                except Exception:
                    pass

    def _handle_restore_from_cloud(self):
        """Baixa o backup .zip mais recente da nuvem e restaura."""
        try:
            # Lista pelo remote de backup: com uma key so de escrita restrita,
            # ele so enxerga os arquivos que o proprio Midnight Media Server criou.
            candidatos = []
            listou = False
            for pasta in destinos_backup():
                result = run_rclone_cmd(["lsjson", pasta])
                if not isinstance(result, list):
                    continue
                listou = True
                for f in result:
                    nome_f = f.get("Name", "")
                    if nome_f.endswith(".zip") and nome_f.startswith(PREFIXO_BACKUP):
                        f["_pasta"] = pasta
                        candidatos.append(f)
            zips = candidatos
            if not listou:
                self._send_error(
                    "Nao foi possivel listar os backups. O remote de backup "
                    "esta configurado? Veja Ajustes > Nuvem.")
                return
            if not zips:
                self._send_error("Nenhum backup encontrado na nuvem")
                return

            # Get most recent by ModTime
            zips.sort(key=lambda f: f.get("ModTime", ""), reverse=True)
            latest = zips[0]
            name = latest["Name"]
            # Teto ANTES de baixar: o zip inteiro entra em memoria no rclone
            # cat — um arquivo gigante (ou trocado na nuvem) derrubava o
            # servidor antes de qualquer validacao.
            if (latest.get("Size") or 0) > MAX_RESTORE_BYTES:
                self._send_error(
                    "O backup mais recente e grande demais (%d MB; limite %d MB)"
                    % (latest["Size"] // (1024 * 1024),
                       MAX_RESTORE_BYTES // (1024 * 1024)), 413)
                return

            self._send_json({"status": "downloading", "file": name})

            # Download in background thread
            def _do_restore():
                try:
                    remote = latest["_pasta"] + "/" + name
                    proc = subprocess.run(
                        ["rclone", "cat", remote],
                        capture_output=True, timeout=120
                    )
                    if proc.returncode != 0:
                        msg = f"Falha ao baixar backup: {proc.stderr.decode(errors='replace')}"
                        print(f"[Midnight Media Server] {msg}", flush=True)
                        # Log to DB for user to see on next refresh
                        _log_notification("error", msg)
                        return
                    # Teto tambem no que chegou: o Size do lsjson pode faltar
                    # (ou mentir) em backend exotico.
                    if len(proc.stdout) > MAX_RESTORE_BYTES:
                        msg = "Backup baixado grande demais para restaurar"
                        print(f"[Midnight Media Server] {msg}", flush=True)
                        _log_notification("error", msg)
                        return

                    buf = io.BytesIO(proc.stdout)
                    with zipfile.ZipFile(buf, "r") as z:
                        names = z.namelist()
                        nome_db = NOME_DB_BACKUP if NOME_DB_BACKUP in names else None
                        if nome_db is None:
                            msg = "Backup zip não contém media-server.db"
                            print(f"[Midnight Media Server] {msg}", flush=True)
                            _log_notification("error", msg)
                            return
                        if z.getinfo(nome_db).file_size > MAX_RESTORE_BYTES:
                            msg = "O banco do backup e grande demais"
                            print(f"[Midnight Media Server] {msg}", flush=True)
                            _log_notification("error", msg)
                            return
                        db_bytes = z.read(nome_db)
                        # Mesma checagem do restore por upload: sem isso, um zip
                        # qualquer (ou corrompido) sobrescrevia o banco vivo.
                        if not _looks_like_media_server_db(db_bytes):
                            msg = "O banco do backup nao parece ser do Midnight Media Server"
                            print(f"[Midnight Media Server] {msg}", flush=True)
                            _log_notification("error", msg)
                            return
                        db_path = Path(DB_PATH)
                        if db_path.exists():
                            shutil.copy2(db_path, db_path.with_suffix(".db.bak"))
                        db_path.write_bytes(db_bytes)
                        img_dir = Path(IMAGE_CACHE_DIR)
                        img_dir.mkdir(exist_ok=True)
                        for n in names:
                            if n.startswith("images/") and not n.endswith("/"):
                                if _zip_member_ok(z, n):
                                    (img_dir / Path(n).name).write_bytes(z.read(n))
                        subs_dir = Path(SUBS_CACHE_DIR)
                        subs_dir.mkdir(exist_ok=True)
                        for n in names:
                            if n.startswith("subs/") and not n.endswith("/"):
                                if _zip_member_ok(z, n):
                                    (subs_dir / Path(n).name).write_bytes(z.read(n))
                    msg = f"Backup restaurado com sucesso: {name}"
                    print(f"[Midnight Media Server] {msg}", flush=True)
                    _log_notification("success", msg)
                except Exception as e:
                    msg = f"Falha ao restaurar da nuvem: {e}"
                    print(f"[Midnight Media Server] {msg}", flush=True)
                    _log_notification("error", msg)

            threading.Thread(target=_do_restore, daemon=True).start()

        except Exception as e:
            self._send_error(f"Falha ao restaurar da nuvem: {e}")

    # ── Fontes do catalogo (nuvem + pastas locais) ──────────────

    def _source_payload(self, source):
        counts = cached_source_counts(source["mount"])
        payload = {
            "id": source["id"],
            "kind": source["kind"],
            "name": source["name"],
            "mount": source["mount"],
            "online": _sources.is_online(source),
            "genres": counts["genres"],
            "movies": counts["movies"],
        }
        # O caminho no disco so interessa a quem pode gerenciar fontes, e
        # descreve a maquina do servidor — nao vai pra sessao comum.
        if self._is_admin():
            payload["root"] = source["root"]
        return payload

    def _handle_sources_list(self):
        self._send_json({
            "sources": [self._source_payload(s) for s in _sources.list_sources()],
        })

    def _handle_sources_detect(self):
        """Volumes e pastas de midia sugeridos. So sugere — nao cadastra nada."""
        try:
            self._send_json({"candidates": _sources.detect_volumes()})
        except Exception as e:
            self._send_exception(e)

    def _handle_source_add(self):
        body = self._read_json_body() or {}
        source, err = _sources.add_source(body.get("name", ""), body.get("path", ""))
        if err:
            self._send_json({"status": "error", "error": err}, 400)
            return
        # Primeiro scan ja sai daqui: sem ele a fonte apareceria vazia.
        scan = _scanner.start_background_scan(source["id"])
        if scan == "already_scanning":
            # So existe uma vaga de scan por vez. Melhor dizer isso do que
            # deixar a fonte recem-criada parecendo vazia sem explicacao.
            message = ("Fonte adicionada. Ja havia um scan em andamento — "
                       "clique em Atualizar quando ele terminar.")
        else:
            message = "Fonte adicionada. Escaneando..."
        if source.get("descended"):
            # A raiz foi ancorada mais fundo: dizer qual, senao o usuario nao
            # entende por que o caminho mostrado nao e o que ele escolheu.
            message += f" Os filmes estao em {source['root']} — foi essa pasta que entrou."
        self._send_json({"status": "ok", "scan": scan, "message": message,
                         "source": self._source_payload(source)})

    def _handle_source_remove(self):
        body = self._read_json_body() or {}
        source_id = str(body.get("id", "")).strip()
        source = _sources.get_source(source_id)
        if not source or source["kind"] != "local":
            self._send_json({"status": "error",
                             "error": "Fonte local nao encontrada."}, 404)
            return
        _sources.remove_source(source_id)
        # O catalogo dela sai junto — senao ficariam filmes apontando pra
        # uma fonte que o app nao conhece mais.
        conn = get_db()
        try:
            _scanner._remove_folder_tree(conn, source["mount"])
            conn.commit()
        finally:
            conn.close()
        self._send_json({"status": "ok"})

    # ── Nuvem (wizard) ────────────────────────────────────────

    # ── Coleções do app ────────────────────────────────────────

    @staticmethod
    def _valida_colecao(body, conn, id_atual=None):
        """Valida o corpo de create/update. Devolve (dados, erro).

        `dados` vem pronto pro banco: nome, descricao, capa, filmes[]. A capa
        precisa ser um dos filmes (ou vazia — aí cai no primeiro); filme que
        não existe no catálogo é recusado, senão a coleção nasceria órfã.
        """
        nome = str(body.get("nome") or "").strip()
        descricao = str(body.get("descricao") or "").strip()
        filmes = body.get("filmes") or []
        capa = str(body.get("capa") or "").strip()
        if not nome:
            return None, "Dê um nome à coleção."
        if len(nome) > 80:
            return None, "Nome longo demais (máximo 80 caracteres)."
        dup = conn.execute(
            "SELECT id FROM colecoes WHERE nome = ? COLLATE NOCASE AND id != ?",
            (nome, id_atual if id_atual else -1)).fetchone()
        if dup:
            return None, f'Já existe uma coleção chamada "{nome}".'
        if not isinstance(filmes, list) or not filmes:
            return None, "Escolha pelo menos um filme para a coleção."
        if len(filmes) > 500:
            return None, "Coleção grande demais (máximo 500 filmes)."
        limpos = []
        for f in filmes:
            f = str(f).strip()
            if f and f not in limpos:
                limpos.append(f)
        for f in limpos:
            row = conn.execute(
                "SELECT path FROM folders WHERE path=? AND has_video=1", (f,)).fetchone()
            if not row:
                return None, f"Filme não encontrado no catálogo: {f}"
        if capa and capa not in limpos:
            return None, "A capa precisa ser de um dos filmes da coleção."
        return {"nome": nome, "descricao": descricao,
                "capa": capa or limpos[0], "filmes": limpos}, None

    # ── Tags do app ────────────────────────────────────────────

    def _handle_genero_create(self):
        body = self._read_json_body() or {}
        nome = str(body.get("nome") or "").strip()
        if not nome:
            self._send_json({"status": "error", "error": "Dê um nome à tag."}, 400)
            return
        if len(nome) > 40:
            self._send_json({"status": "error",
                             "error": "Nome longo demais (máximo 40 caracteres)."}, 400)
            return
        conn = get_db()
        try:
            dup = conn.execute(
                "SELECT id FROM generos_app WHERE nome = ? COLLATE NOCASE",
                (nome,)).fetchone()
            if dup:
                # Idempotente: criar o que existe devolve o id dele.
                self._send_json({"status": "ok", "id": dup["id"],
                                 "ja_existia": True,
                                 "message": f'Tag "{nome}" já existia.'})
                return
            cur = conn.execute(
                "INSERT INTO generos_app (nome, created_at) VALUES (?, ?)",
                (nome, time.time()))
            conn.commit()
            novo_id = cur.lastrowid
        finally:
            conn.close()
        self._send_json({"status": "ok", "id": novo_id,
                         "message": f'Tag "{nome}" criada.'})

    def _handle_genero_renomear(self):
        body = self._read_json_body() or {}
        nome = str(body.get("nome") or "").strip()
        if not nome:
            self._send_json({"status": "error", "error": "Dê um nome à tag."}, 400)
            return
        if len(nome) > 40:
            self._send_json({"status": "error",
                             "error": "Nome longo demais (máximo 40 caracteres)."}, 400)
            return
        try:
            gid = int(body.get("id"))
        except (TypeError, ValueError):
            self._send_json({"status": "error", "error": "Tag inválida."}, 400)
            return
        conn = get_db()
        try:
            if not conn.execute("SELECT id FROM generos_app WHERE id=?",
                                (gid,)).fetchone():
                self._send_json({"status": "error",
                                 "error": "Tag não encontrada."}, 404)
                return
            dup = conn.execute(
                "SELECT id FROM generos_app WHERE nome = ? COLLATE NOCASE AND id != ?",
                (nome, gid)).fetchone()
            if dup:
                self._send_json({"status": "error",
                                 "error": f'Já existe uma tag "{nome}".'}, 400)
                return
            conn.execute("UPDATE generos_app SET nome=? WHERE id=?", (nome, gid))
            conn.commit()
        finally:
            conn.close()
        self._send_json({"status": "ok", "message": f'Gênero renomeado para "{nome}".'})

    def _handle_genero_delete(self):
        body = self._read_json_body() or {}
        try:
            gid = int(body.get("id"))
        except (TypeError, ValueError):
            self._send_json({"status": "error", "error": "Tag inválida."}, 400)
            return
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT nome FROM generos_app WHERE id=?", (gid,)).fetchone()
            if not row:
                self._send_json({"status": "error",
                                 "error": "Tag não encontrada."}, 404)
                return
            conn.execute("DELETE FROM generos_app WHERE id=?", (gid,))
            conn.execute("DELETE FROM generos_filmes WHERE genero_id=?", (gid,))
            conn.commit()
        finally:
            conn.close()
        self._send_json({"status": "ok",
                         "message": f'Tag "{row["nome"]}" excluída.'})

    def _handle_genero_atribuir(self):
        """Define as tags de um filme: substitui o conjunto por inteiro.

        O alvo é o folder_path (filme em pasta) ou o path completo do arquivo
        (filme solto). Filme que não existe mais no catálogo é recusado — sem
        isso a atribuição criaria vínculo órfão invisível.
        """
        body = self._read_json_body() or {}
        alvo = str(body.get("alvo") or "").strip()
        ids = body.get("generos") or []
        if not alvo:
            self._send_json({"status": "error", "error": "Filme não informado."}, 400)
            return
        if not isinstance(ids, list):
            self._send_json({"status": "error", "error": "Tags inválidas."}, 400)
            return
        conn = get_db()
        try:
            existe = conn.execute(
                "SELECT 1 FROM folders WHERE path=? AND has_video=1 AND depth>0",
                (alvo,)).fetchone()
            if not existe:
                existe = conn.execute(
                    """SELECT 1 FROM files WHERE folder_path = ? AND name = ?
                       AND file_type = 'video'""", partir_caminho(alvo)).fetchone()
            if not existe:
                self._send_json({"status": "error",
                                 "error": "Filme não encontrado no catálogo."}, 404)
                return
            limpos = []
            for i in ids:
                try:
                    i = int(i)
                except (TypeError, ValueError):
                    continue
                if conn.execute("SELECT 1 FROM generos_app WHERE id=?",
                                (i,)).fetchone() and i not in limpos:
                    limpos.append(i)
            conn.execute("DELETE FROM generos_filmes WHERE alvo=?", (alvo,))
            conn.executemany(
                "INSERT OR IGNORE INTO generos_filmes (genero_id, alvo) VALUES (?, ?)",
                [(i, alvo) for i in limpos])
            conn.commit()
        finally:
            conn.close()
        self._send_json({"status": "ok", "generos": limpos,
                         "message": "Tags atualizadas."})

    def _handle_watched(self):
        """Marcar/desmarcar um filme como assistido (interruptor da ficha).

        Reaproveita watch_progress: "marcar" grava posicao 0 (a mesma
        convencao de quem assiste ate o fim), "desmarcar" apaga a linha — o
        filme sai de assistido e tambem do Continuar Assistindo.
        """
        body = self._read_json_body() or {}
        alvo = str(body.get("path") or "").strip()
        if not alvo:
            self._send_json({"status": "error", "error": "Filme não informado."}, 400)
            return
        on = bool(body.get("on"))
        conn = get_db()
        try:
            if on:
                conn.execute(
                    "INSERT OR REPLACE INTO watch_progress "
                    "(profile_id, folder_path, position_seconds, duration_seconds, updated_at) "
                    "VALUES (?, ?, 0, 0, ?)", (perfil_atual(), alvo, time.time()))
            else:
                conn.execute(
                    "DELETE FROM watch_progress WHERE profile_id=? AND folder_path=?",
                    (perfil_atual(), alvo))
            conn.commit()
        finally:
            conn.close()
        self._send_json({"status": "ok", "watched": on})

    def _handle_colecao_create(self):
        body = self._read_json_body() or {}
        conn = get_db()
        try:
            dados, err = self._valida_colecao(body, conn)
            if err:
                self._send_json({"status": "error", "error": err}, 400)
                return
            cur = conn.execute(
                "INSERT INTO colecoes (nome, descricao, capa, created_at) "
                "VALUES (?, ?, ?, ?)",
                (dados["nome"], dados["descricao"], dados["capa"], time.time()))
            nova_id = cur.lastrowid
            conn.executemany(
                "INSERT OR IGNORE INTO colecoes_filmes (colecao_id, folder_path) "
                "VALUES (?, ?)",
                [(nova_id, f) for f in dados["filmes"]])
            conn.commit()
        finally:
            conn.close()
        self._send_json({"status": "ok", "id": nova_id,
                         "message": f'Coleção "{dados["nome"]}" criada.'})

    def _handle_colecao_update(self):
        body = self._read_json_body() or {}
        try:
            col_id = int(body.get("id"))
        except (TypeError, ValueError):
            self._send_json({"status": "error", "error": "Coleção inválida."}, 400)
            return
        conn = get_db()
        try:
            if not conn.execute(
                    "SELECT id FROM colecoes WHERE id=?", (col_id,)).fetchone():
                self._send_json({"status": "error",
                                 "error": "Coleção não encontrada."}, 404)
                return
            dados, err = self._valida_colecao(body, conn, id_atual=col_id)
            if err:
                self._send_json({"status": "error", "error": err}, 400)
                return
            conn.execute(
                "UPDATE colecoes SET nome=?, descricao=?, capa=? WHERE id=?",
                (dados["nome"], dados["descricao"], dados["capa"], col_id))
            # Vínculos são substituídos por inteiro: a tela manda a lista final.
            conn.execute("DELETE FROM colecoes_filmes WHERE colecao_id=?", (col_id,))
            conn.executemany(
                "INSERT OR IGNORE INTO colecoes_filmes (colecao_id, folder_path) "
                "VALUES (?, ?)",
                [(col_id, f) for f in dados["filmes"]])
            conn.commit()
        finally:
            conn.close()
        self._send_json({"status": "ok",
                         "message": f'Coleção "{dados["nome"]}" salva.'})

    def _handle_colecao_delete(self):
        body = self._read_json_body() or {}
        try:
            col_id = int(body.get("id"))
        except (TypeError, ValueError):
            self._send_json({"status": "error", "error": "Coleção inválida."}, 400)
            return
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT nome FROM colecoes WHERE id=?", (col_id,)).fetchone()
            if not row:
                self._send_json({"status": "error",
                                 "error": "Coleção não encontrada."}, 404)
                return
            conn.execute("DELETE FROM colecoes WHERE id=?", (col_id,))
            conn.execute("DELETE FROM colecoes_filmes WHERE colecao_id=?", (col_id,))
            conn.commit()
        finally:
            conn.close()
        self._send_json({"status": "ok",
                         "message": f'Coleção "{row["nome"]}" excluída.'})

    def _permitido_infantil(self, caminho_midia):
        """Para sessão infantil: o arquivo só pode tocar se ele mesmo ou
        alguma pasta acima dele estiver marcada.

        Cobre os três casos: arquivo solto (marcado direto), filme (a pasta
        dele) e episódio de série (a pasta da série, acima da temporada) —
        marcar a série vale para todos os episódios. Aceita o path com ou sem
        a barra inicial do namespace lógico."""
        caminho = "/" + str(caminho_midia or "").strip("/")
        # '..' e '.' sao resolvidos depois pelo disco e pelo rclone, mas aqui
        # o filtro olha o texto: '/Local/hd/<marcado>/../<adulto>/x.mkv' teria
        # o ancestral marcado e tocaria outro filme. Recusa em vez de normalizar.
        if any(seg in ("..", ".") for seg in caminho.replace("\\", "/").split("/")):
            return False
        alvos = [caminho]
        pasta = caminho.rsplit("/", 1)[0]
        while pasta and pasta != "/":
            alvos.append(pasta)
            pasta = pasta.rsplit("/", 1)[0]
        return cached_algum_infantil(alvos)

    def _handle_infantil_marcar(self):
        """Marca/desmarca um filme para o perfil infantil (admin)."""
        body = self._read_json_body() or {}
        alvo = "/" + str(body.get("alvo") or "").strip("/")
        if alvo == "/":
            self._send_json({"status": "error", "error": "Filme não informado."}, 400)
            return
        conn = get_db()
        try:
            existe = conn.execute(
                "SELECT 1 FROM folders WHERE path=? AND has_video=1 AND depth>0",
                (alvo,)).fetchone()
            if not existe:
                existe = conn.execute(
                    """SELECT 1 FROM files WHERE folder_path = ? AND name = ?
                       AND file_type = 'video'""", partir_caminho(alvo)).fetchone()
            if not existe:
                self._send_json({"status": "error",
                                 "error": "Filme não encontrado no catálogo."}, 404)
                return
            on = bool(body.get("on"))
            if on:
                conn.execute("INSERT OR IGNORE INTO infantil_filmes (alvo) VALUES (?)",
                             (alvo,))
            else:
                conn.execute("DELETE FROM infantil_filmes WHERE alvo=?", (alvo,))
            conn.commit()
        finally:
            conn.close()
        self._send_json({"status": "ok", "on": on,
                         "message": ("Marcado para o perfil infantil."
                                     if on else "Desmarcado do perfil infantil.")})

    # ── Nuvem (qualquer remote rclone, via wizard) ─────────────

    def _handle_nuvem_status(self):
        try:
            self._send_json(_nuvem.status())
        except Exception as e:
            self._send_exception(e)

    def _handle_nuvem_conectar(self):
        body = self._read_json_body() or {}
        result, err = _nuvem.conectar(body.get("remote", ""),
                                      body.get("pasta", ""))
        if err:
            self._send_json({"status": "error", "error": err}, 400)
            return
        # Remote novo em uso: reinicia o serve para montar nele.
        serve = restart_rclone_serve()
        self._send_json({"status": "ok", "remote": result["remote"],
                         "pasta": result["pasta"], "serve": serve})

    def _handle_nuvem_desconectar(self):
        _nuvem.desconectar()
        # O catalogo da nuvem sai junto — sem isso a home continuaria listando
        # filmes que nao existem mais em lugar nenhum, com play que falha.
        try:
            _scanner.prune_unconfigured_cloud()
        except Exception as e:
            print(f"[Midnight Media Server] Falha ao podar catalogo da nuvem: {e}",
                  flush=True)
        self._send_json({"status": "ok"})

    def _handle_rclone_remotes(self):
        remotes, err = _nuvem.listar_remotes()
        if err:
            self._send_json({"status": "error", "error": err}, 500)
            return
        self._send_json(remotes)

    def _handle_rclone_providers(self):
        providers, err = _nuvem.providers()
        if err:
            self._send_json({"status": "error", "error": err}, 500)
            return
        self._send_json(providers)

    def _handle_rclone_wizard(self):
        body = self._read_json_body() or {}
        result, err = _nuvem.criar_remote(body.get("nome", ""),
                                          body.get("tipo", ""),
                                          body.get("parametros") or {})
        if err:
            self._send_json({"status": "error", "error": err}, 400)
            return
        self._send_json({"status": "ok", **result})

    def _handle_branding_set(self):
        body = self._read_json_body() or {}
        # So a cor: o nome e escolhido na instalacao (_handle_auth_setup) e
        # fica fixo depois disso — ver branding.set().
        ok, err = _branding.set(cor=body.get("cor", ""))
        if not ok:
            self._send_json({"status": "error", "error": err}, 400)
            return
        self._send_json({"status": "ok", "branding": _branding.get()})

    def do_POST(self):
        try:
            self._rota_do_post()
        finally:
            self._sobra_do_corpo()

    def _sobra_do_corpo(self):
        """Corpo do POST que a rota nao leu (403/404 respondem antes do parse)
        fica no socket e, em keep-alive, seria lido como a PROXIMA requisicao:
        um 400 disparado pelo proprio corpo que o cliente acabou de mandar.
        Drena restos pequenos; resto grande fecha a conexao, como era antes
        do HTTP/1.1."""
        try:
            restante = int(self.headers.get("Content-Length", 0) or 0) - \
                getattr(self, "_body_lido", 0)
        except (TypeError, ValueError):
            restante = 0
        if restante <= 0:
            return
        if restante <= 65536:
            try:
                self.rfile.read(restante)
                return
            except Exception:
                pass
        self.close_connection = True

    def _rota_do_post(self):
        self._reset_request_state()
        if not self._security_gate():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if not self._require_write_origin():
            return

        # Login e criacao de senha vem antes do gate — sao a porta de entrada.
        if path == "/api/auth/setup":
            self._handle_auth_setup()
            return

        if path == "/api/auth/login":
            self._handle_auth_login()
            return

        if not self._auth_gate(path, urllib.parse.parse_qs(parsed.query)):
            return

        if path == "/api/auth/logout":
            self._handle_auth_logout(
                everywhere=(self._read_json_body() or {}).get("everywhere", False))
            return

        if path == "/api/cast-token":
            self._handle_cast_token()
            return

        if path == "/api/prepare":
            self._handle_prepare()
            return

        if path == "/api/scrape/key/set":
            self._handle_scrape_key_set()
            return

        if path == "/api/scrape/apply":
            self._handle_scrape_apply()
            return

        if path == "/api/scrape/capa":
            self._handle_scrape_capa()
            return

        if path == "/api/organizar/aplicar":
            self._handle_organizar_aplicar()
            return

        if path == "/api/organizar/desfazer":
            self._handle_organizar_desfazer()
            return

        if path == "/api/profiles/select":
            self._handle_profile_select()
            return

        if path == "/api/profiles/leave":
            self._handle_profile_leave()
            return

        if path == "/api/profiles/unlock":
            self._handle_profile_unlock()
            return

        if path == "/api/profiles/save":
            self._handle_profile_save()
            return

        if path == "/api/profiles/pin":
            self._handle_profile_pin()
            return

        if path == "/api/profiles/delete":
            self._handle_profile_delete()
            return

        # Rotas que antes eram GET e alteravam estado (scan, cache, restore).
        # O corpo do handler continua em do_GET; aqui so liberamos a execucao.
        if path in WRITE_ROUTES:
            self._write_ok = True
            try:
                self.do_GET()
            finally:
                self._write_ok = False
            return

        if path == "/api/restore":
            self._handle_restore()
            return

        if path == "/api/progress":
            try:
                content_len = int(self.headers.get("Content-Length", 0))
                if content_len == 0:
                    self._send_json({"status": "error", "error": "Empty body"}, 400)
                    return
                if content_len > MAX_JSON_BODY_BYTES:
                    self._send_json({"status": "error", "error": "Corpo grande demais"}, 413)
                    return
                raw = self.rfile.read(content_len)
                self._body_lido += content_len
                body = json.loads(raw)
                folder_path = body.get("path", "").strip()
                position = float(body.get("position", 0))
                duration = float(body.get("duration", 0))
                if not folder_path:
                    self._send_json({"status": "error", "error": "Missing path"}, 400)
                    return
                conn = get_db()
                conn.execute(
                    "INSERT OR REPLACE INTO watch_progress (profile_id, folder_path, position_seconds, duration_seconds, updated_at) VALUES (?, ?, ?, ?, ?)",
                    (perfil_atual(), folder_path, position, duration, time.time())
                )
                conn.commit()
                conn.close()
                self._send_json({"status": "ok"})
            except Exception as e:
                self._send_exception(e)
            return

        if path == "/api/rclone/webgui/start":
            self._send_json(start_rclone_webgui())
            return

        if path == "/api/rclone/webgui/stop":
            self._send_json(stop_rclone_webgui())
            return

        if path == "/api/rclone/serve/restart":
            self._send_json(restart_rclone_serve())
            return

        self._send_error("Not found", 404)

    def _handle_restore(self):
        """Restore backup from uploaded zip file."""
        try:
            content_len = int(self.headers.get("Content-Length", 0))
            if content_len == 0:
                self._send_error("Empty request", 400)
                return
            if content_len > MAX_RESTORE_BYTES:
                self._send_error("Backup grande demais", 413)
                return
            data = self.rfile.read(content_len)
            self._body_lido += content_len
            buf = io.BytesIO(data)
            with zipfile.ZipFile(buf, "r") as z:
                names = z.namelist()
                nome_db = NOME_DB_BACKUP if NOME_DB_BACKUP in names else None
                if nome_db is None:
                    self._send_error("Backup must contain media-server.db", 400)
                    return
                if z.getinfo(nome_db).file_size > MAX_RESTORE_BYTES:
                    self._send_error("Banco do backup grande demais", 413)
                    return
                db_bytes = z.read(nome_db)
                if not _looks_like_media_server_db(db_bytes):
                    self._send_error(
                        "O arquivo nao e um banco valido do Midnight Media Server", 400)
                    return
                db_path = Path(DB_PATH)
                if db_path.exists():
                    shutil.copy2(db_path, db_path.with_suffix(".db.bak"))
                db_path.write_bytes(db_bytes)
                img_dir = Path(IMAGE_CACHE_DIR)
                img_dir.mkdir(exist_ok=True)
                for name in names:
                    if name.startswith("images/") and not name.endswith("/"):
                        if _zip_member_ok(z, name):
                            (img_dir / Path(name).name).write_bytes(z.read(name))
                subs_dir = Path(SUBS_CACHE_DIR)
                subs_dir.mkdir(exist_ok=True)
                for name in names:
                    if name.startswith("subs/") and not name.endswith("/"):
                        if _zip_member_ok(z, name):
                            (subs_dir / Path(name).name).write_bytes(z.read(name))
            self._send_json({"status": "ok", "message": "Backup restaurado com sucesso"})
        except Exception as e:
            sys.stderr.write("[Midnight Media Server] restore falhou: %r\n" % (e,))
            self._send_error("Falha ao restaurar o backup")

    # ── Rotas GET (extraidas do do_GET) ───────────────────────

    # Rotas GET antes do guard de escrita: caminho -> metodo. Cada metodo e _get_<caminho>.
    _ROTAS_GET_ANTES = {
        "/api/scrape/status": "_get_api_scrape_status",
        "/api/scrape/pendentes": "_get_api_scrape_pendentes",
        "/api/scrape/search": "_get_api_scrape_search",
        "/api/scrape/capas": "_get_api_scrape_capas",
        "/api/organizar/itens": "_get_api_organizar_itens",
        "/api/organizar/buscar": "_get_api_organizar_buscar",
        "/api/organizar/historico": "_get_api_organizar_historico",
        "/api/profiles": "_get_api_profiles",
        "/perfis": "_get_perfis",
    }

    # Rotas GET depois do guard de escrita: caminho -> metodo. Cada metodo e _get_<caminho>.
    _ROTAS_GET = {
        "/manifest.webmanifest": "_get_manifest_webmanifest",
        "/branding.css": "_get_branding_css",
        "/ca.crt": "_get_ca_crt",
        "/api/branding": "_get_api_branding",
        "/api/branding/set": "_get_api_branding_set",
        "/api/refresh": "_get_api_refresh",
        "/api/sources": "_get_api_sources",
        "/api/sources/detect": "_get_api_sources_detect",
        "/api/sources/add": "_get_api_sources_add",
        "/api/sources/remove": "_get_api_sources_remove",
        "/api/nuvem/status": "_get_api_nuvem_status",
        "/api/nuvem/conectar": "_get_api_nuvem_conectar",
        "/api/nuvem/desconectar": "_get_api_nuvem_desconectar",
        "/api/rclone/remotes": "_get_api_rclone_remotes",
        "/api/rclone/providers": "_get_api_rclone_providers",
        "/api/rclone/wizard": "_get_api_rclone_wizard",
        "/api/scan-progress": "_get_api_scan_progress",
        "/api/backup": "_get_api_backup",
        "/api/backup/local": "_get_api_backup_local",
        "/api/backup/b2": "_get_api_backup_b2",
        "/api/restore/b2": "_get_api_restore_b2",
        "/api/cache-manager": "_get_api_cache_manager",
        "/api/cache-download": "_get_api_cache_download",
        "/api/cache-download-progress": "_get_api_cache_download_progress",
        "/api/check-cached": "_get_api_check_cached",
        "/api/clear-cache": "_get_api_clear_cache",
        "/api/uncache": "_get_api_uncache",
        "/api/cache-status": "_get_api_cache_status",
        "/api/genres": "_get_api_genres",
        "/api/recent-movies": "_get_api_recent_movies",
        "/api/continue-watching": "_get_api_continue_watching",
        "/api/progress": "_get_api_progress",
        "/api/list": "_get_api_list",
        "/api/collections": "_get_api_collections",
        "/api/collection": "_get_api_collection",
        "/api/generos": "_get_api_generos",
        "/api/genero": "_get_api_genero",
        "/api/generos/de": "_get_api_generos_de",
        "/api/infantil/marcar": "_get_api_infantil_marcar",
        "/api/colecoes/create": "_get_api_colecoes_create",
        "/api/colecoes/update": "_get_api_colecoes_update",
        "/api/colecoes/delete": "_get_api_colecoes_delete",
        "/api/generos/create": "_get_api_generos_create",
        "/api/generos/delete": "_get_api_generos_delete",
        "/api/generos/atribuir": "_get_api_generos_atribuir",
        "/api/generos/renomear": "_get_api_generos_renomear",
        "/api/watched": "_get_api_watched",
        "/api/series": "_get_api_series",
        "/api/serie": "_get_api_serie",
        "/api/movie-detail": "_get_api_movie_detail",
        "/api/search": "_get_api_search",
        "/api/all-movies": "_get_api_all_movies",
        "/api/stream": "_get_api_stream",
        "/api/prepared": "_get_api_prepared",
        "/api/prepare-status": "_get_api_prepare_status",
        "/api/info": "_get_api_info",
        "/api/rclone/status": "_get_api_rclone_status",
    }

    def do_GET(self):
        self._reset_request_state()
        if not self._security_gate():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        params = urllib.parse.parse_qs(parsed.query)

        if not self._auth_gate(path, params):
            return

        if path == "/login":
            if self._has_session():
                self.send_response(303)
                self.send_header("Location", "/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self._send_html(self._pagina_de_setup() if not _auth_configured() else _login_page())
            return

        if path == "/api/auth/status":
            user = self._current_user()
            info = self._session_info()
            self._send_json({"configured": _auth_configured(),
                             "authenticated": user is not None,
                             "account": info is not None,
                             "user": user})
            return

        # Rotas de escrita chegam aqui apenas quando redespachadas por do_POST.
        metodo = self._ROTAS_GET_ANTES.get(path)
        if metodo:
            getattr(self, metodo)(path, params)
            return
        if path in WRITE_ROUTES and not getattr(self, "_write_ok", False):
            self._send_json(
                {"status": "error", "error": "Use POST para esta operacao"}, 405)
            return

        metodo = self._ROTAS_GET.get(path)
        if metodo:
            getattr(self, metodo)(path, params)
            return
        # Serve frontend
        if path == "/" or path == "/index.html":
            self._send_html(self._index_html())
            return

        # Favicon (serve from project root)
        if path == "/favicon.ico" or path == "/favicon.svg":
            self._serve_file(path)
            return

        # Static files
        if path.startswith("/static/"):
            self._serve_file(path)
            return

        if path.startswith("/icone-") and path.endswith(".png"):
            chave = path[len("/icone-"):-len(".png")]
            dados = _branding.icone_png(chave)
            if dados is None:
                self._send_error("Icone desconhecido", 404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(dados)))
            # A cor entra no nome do arquivo em cache (branding.py); um icone
            # nunca fica desatualizado atras deste cache, so muda de URL.
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            self.wfile.write(dados)
            return

        # API: Subtitle (serve as WebVTT for browser)
        if path == "/api/subtitle" and self._so_infantil() \
                and not self._permitido_infantil(
                    params.get("path", [""])[0]):
            self._send_error("Legenda não disponível neste perfil", 403)
            return

        if path == "/api/subtitle":
            file_path = params.get("path", [""])[0]
            if not file_path:
                self._send_error("Missing 'path' parameter", 400)
                return
            self._serve_subtitle(file_path)
            return

        # Fallback 404
        self._send_error("Not found", 404)


# ──────────────────────────────────────────────
#  SSL / HTTPS (self-signed cert for Chromecast)
# ──────────────────────────────────────────────











# ═══════════════════════════════════════════════
#  rclone management (serve, web GUI, status)
# ═══════════════════════════════════════════════
















