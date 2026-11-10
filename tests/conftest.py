"""Fixtures dos testes.

O pacote le o HOME (~/.cache/media-server) quando e importado, entao o HOME de
teste e definido ANTES de qualquer import de `mediaserver`. Nada aqui toca nos
dados do usuario, e nenhum teste sobe o servidor na porta 9187 (o app mata
quem estiver nela): o servidor HTTP dos testes usa uma porta livre, numa thread.
"""
import json
import os
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

_HOME = tempfile.mkdtemp(prefix="ms-test-home-")
os.environ["HOME"] = _HOME
os.environ["USERPROFILE"] = _HOME          # Windows
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from mediaserver import db  # noqa: E402

db.init_db()


@pytest.fixture(scope="session")
def home():
    return Path(_HOME)


class Resposta:
    def __init__(self, status, headers, raw, json_):
        self.status, self.headers, self.raw, self.json = status, headers, raw, json_


class Cliente:
    """Cliente HTTP minimo com cookie de sessao, sem seguir redirecionamentos."""

    def __init__(self, base, porta):
        self.base, self.porta, self.cookies = base, porta, {}

    def req(self, metodo, caminho, corpo=None, headers=None, origin=True):
        h = {"Accept-Encoding": "identity"}
        if origin:
            h["Origin"] = self.base
        h.update(headers or {})
        data = None
        if corpo is not None:
            data = json.dumps(corpo).encode()
            h["Content-Type"] = "application/json"
        if self.cookies:
            h["Cookie"] = "; ".join("%s=%s" % kv for kv in self.cookies.items())
        r = urllib.request.Request(self.base + caminho, data=data, headers=h, method=metodo)
        try:
            resp = urllib.request.urlopen(r, timeout=15)
        except urllib.error.HTTPError as e:
            resp = e
        for c in resp.headers.get_all("Set-Cookie") or []:
            nome, _, resto = c.partition("=")
            self.cookies[nome] = resto.split(";")[0]
        corpo_resp = resp.read()
        try:
            js = json.loads(corpo_resp)
        except ValueError:
            js = None
        return Resposta(getattr(resp, "status", None) or resp.code, resp.headers, corpo_resp, js)

    def get(self, caminho, **kw):
        return self.req("GET", caminho, **kw)

    def post(self, caminho, corpo=None, **kw):
        return self.req("POST", caminho, corpo if corpo is not None else {}, **kw)


@pytest.fixture(scope="session")
def servidor():
    """Servidor real (o mesmo handler do app) numa porta livre, em thread."""
    import http.server
    from mediaserver import handler

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler.MediaServerHandler)
    srv.daemon_threads = True
    porta = srv.server_address[1]
    handler.PORT = porta     # o Origin de POST so vale para a porta do proprio servidor
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield "http://127.0.0.1:%d" % porta, porta
    srv.shutdown()


@pytest.fixture(scope="session")
def admin(servidor):
    """Cliente logado como administrador (cria a conta com o codigo de instalacao)."""
    from mediaserver import auth

    base, porta = servidor
    c = Cliente(base, porta)
    r = c.post("/api/auth/setup", {"code": auth._setup_code_value(), "username": "admin",
                                   "password": "senha-de-teste-123", "perfil": "Admin"})
    assert r.status == 200, r.raw
    return c


def _entrar_como(admin, servidor, nome, infantil=False):
    base, porta = servidor
    admin.post("/api/profiles/save", {"id": "", "name": nome, "avatar": "a02",
                                      "infantil": infantil, "role": "user"})
    perfis = admin.get("/api/profiles").json["profiles"]
    pid = next(p["id"] for p in perfis if p["name"] == nome)
    c = Cliente(base, porta)
    c.cookies = dict(admin.cookies)          # mesma conta, outro perfil
    assert c.post("/api/profiles/select", {"id": pid}).status == 200
    return c, pid


@pytest.fixture(scope="session")
def usuario(admin, servidor):
    """Perfil comum (nao admin) da mesma conta."""
    return _entrar_como(admin, servidor, "Comum")[0]


@pytest.fixture(scope="session")
def infantil(admin, servidor):
    return _entrar_como(admin, servidor, "Crianca", infantil=True)[0]
