"""Rodada 5: HTTPS travavel por uma conexao parada, timeouts, Content-Length, forca bruta
distribuida e hash de senha."""
import http.server
import shutil
import socket
import ssl
import subprocess
import time
from unittest import mock

import pytest

from mediaserver import auth, handler, netutil


# ── HTTPS: uma conexao parada nao trava mais o servidor ──────
@pytest.fixture(scope="module")
def https(tmp_path_factory):
    if not shutil.which("openssl"):
        pytest.skip("openssl nao instalado")
    d = tmp_path_factory.mktemp("tls")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(d / "key.pem"),
                    "-out", str(d / "cert.pem"), "-days", "1", "-subj", "/CN=localhost"],
                   check=True, capture_output=True)

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *a):
            pass

    srv = netutil.start_https_server(H, "127.0.0.1", 0, d / "cert.pem", d / "key.pem")
    yield srv.server_address[1]
    srv.shutdown()


def _pedir(porta, max_versao=None, timeout=4):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    if max_versao:
        ctx.minimum_version = ssl.TLSVersion.MINIMUM_SUPPORTED
        ctx.maximum_version = max_versao
    with socket.create_connection(("127.0.0.1", porta), timeout=timeout) as s:
        with ctx.wrap_socket(s, server_hostname="localhost") as tls:
            tls.sendall(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            return tls.recv(100).split(b"\r\n")[0]


def test_conexao_parada_nao_trava_o_https(https):
    atacantes = [socket.create_connection(("127.0.0.1", https)) for _ in range(5)]   # conectam e nao mandam nada
    try:
        time.sleep(0.3)
        t = time.time()
        assert _pedir(https).endswith(b"200 OK")
        assert time.time() - t < 2, "o HTTPS ficou esperando as conexoes paradas"
    finally:
        for a in atacantes:
            a.close()


def test_tls_antigo_e_recusado(https):
    try:
        ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT).maximum_version = ssl.TLSVersion.TLSv1_1
    except (ValueError, AttributeError):
        pytest.skip("este Python nao fala TLS 1.1")
    with pytest.raises((ssl.SSLError, OSError)):
        _pedir(https, max_versao=ssl.TLSVersion.TLSv1_1)


def test_handshake_tem_prazo():
    assert 0 < netutil._ServidorTLS.HANDSHAKE_TIMEOUT <= 30


def test_conexao_http_tem_timeout():
    # sem timeout, cada conexao ociosa prendia uma thread para sempre
    assert 0 < handler.MediaServerHandler.timeout <= 300


# ── Content-Length invalido: 400, nao excecao ────────────────
@pytest.mark.parametrize("cl", ["abc", "1e3", "-5"])
def test_content_length_invalido_responde_400(servidor, admin, cl):
    base, porta = servidor
    ck = "; ".join("%s=%s" % kv for kv in admin.cookies.items())
    s = socket.create_connection(("127.0.0.1", porta), timeout=5)
    s.sendall(("POST /api/watched HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nOrigin: %s\r\nCookie: %s\r\n"
               "Content-Type: application/json\r\nContent-Length: %s\r\nConnection: close\r\n\r\n{}"
               % (porta, base, ck, cl)).encode())
    linha = s.recv(200).split(b"\r\n")[0]
    s.close()
    assert linha.startswith(b"HTTP/1.1 400"), linha


# ── forca bruta distribuida (muitos IPs) ─────────────────────
@pytest.fixture
def ips_rotativos():
    """Cada requisicao parece vir de um IP diferente (o que um atacante com IPv6 faz)."""
    contador = iter(range(10 ** 6))
    with auth._auth_lock:                       # outros testes ja erraram senhas: comeca do zero
        auth._login_attempts.pop(auth.GLOBAL_SENHA, None)
        auth._login_attempts.pop(auth.GLOBAL_SETUP, None)
    with mock.patch.object(handler.MediaServerHandler, "_client_ip",
                           lambda self: "10.9.%d.%d" % divmod(next(contador), 256)):
        yield
    with auth._auth_lock:
        auth._login_attempts.pop(auth.GLOBAL_SENHA, None)
        auth._login_attempts.pop(auth.GLOBAL_SETUP, None)
        auth._tentativas_gravar()


def test_senha_tem_limite_global_mesmo_trocando_de_ip(servidor, admin, ips_rotativos):
    from conftest import Cliente
    c = Cliente(*servidor)
    codigos = [c.post("/api/auth/login", {"username": "admin", "password": "errada-%d" % i}).status
               for i in range(auth.LIMITE_GLOBAL_SENHA)]
    assert set(codigos) == {401}
    # de um IP novo, ate com a senha CERTA: bloqueado ate a janela passar
    assert c.post("/api/auth/login", {"username": "admin", "password": "senha-de-teste-123"}).status == 429


def test_codigo_de_instalacao_tem_limite_global():
    with auth._auth_lock:
        auth._login_attempts.pop(auth.GLOBAL_SETUP, None)
    for _ in range(auth.LIMITE_GLOBAL_SETUP):
        auth._record_login_failure(auth.GLOBAL_SETUP)
    assert auth._setup_global_bloqueado() is True
    with auth._auth_lock:
        auth._login_attempts.pop(auth.GLOBAL_SETUP, None)
        auth._tentativas_gravar()


# ── hash de senha onde nao ha scrypt ─────────────────────────
def test_pbkdf2_novo_usa_600_mil_iteracoes(monkeypatch):
    monkeypatch.setattr(auth, "_scrypt_disponivel", lambda: False)
    reg = auth._novo_registro_senha("uma senha qualquer")
    assert reg["algo"] == "pbkdf2_sha256" and reg["iterations"] >= 600000
    assert auth._senha_confere(reg, "uma senha qualquer") == "pbkdf2"
    assert auth._senha_confere(reg, "outra") is None


def test_registro_antigo_de_100_mil_ainda_confere():
    salt, dk = auth._hash_password("antiga", iterations=100000)
    legado = {"algo": "pbkdf2_sha256", "salt": salt.hex(), "hash": dk.hex()}   # sem "iterations"
    assert auth._senha_confere(legado, "antiga") == "pbkdf2"


def test_login_reprocessa_registro_fraco(monkeypatch):
    monkeypatch.setattr(auth, "_scrypt_disponivel", lambda: False)
    salt, dk = auth._hash_password("antiga", iterations=100000)
    conta = {"username": "x", "algo": "pbkdf2_sha256", "salt": salt.hex(), "hash": dk.hex()}
    monkeypatch.setattr(auth, "_account", lambda: conta)
    with mock.patch.object(auth, "_upgrade_hash") as up:
        assert auth._check_credentials("x", "antiga") == {"username": "x"}
    up.assert_called_once()
