"""'Sair' encerra a sessao NO SERVIDOR: um cookie copiado antes deixa de valer."""
import base64
import json
import os
import stat
import time

import pytest

from conftest import Cliente
from mediaserver import auth, config

SENHA = "senha-de-teste-123"


def _login(servidor):
    c = Cliente(*servidor)
    r = c.post("/api/auth/login", {"username": "admin", "password": SENHA})
    assert r.status == 200, r.raw
    return c


def _vale(cookies, servidor):
    c = Cliente(*servidor)
    c.cookies = dict(cookies)
    return c.get("/api/profiles").status == 200


def test_cookie_copiado_nao_vale_depois_do_sair(admin, servidor):
    c = _login(servidor)
    copia = dict(c.cookies)                       # o "ladrao" copia o cookie
    assert _vale(copia, servidor)
    assert c.post("/api/auth/logout").status == 200
    assert not _vale(copia, servidor), "o cookie roubado continua valendo depois do Sair"
    assert not _vale(c.cookies, servidor)


def test_trocar_de_perfil_mantem_a_sessao_e_o_sair_derruba_todos_os_cookies_dela(admin, servidor):
    c = _login(servidor)
    antes = dict(c.cookies)
    pid = admin.get("/api/profiles").json["profiles"][0]["id"]
    assert c.post("/api/profiles/select", {"id": pid}).status == 200
    depois = dict(c.cookies)
    assert antes != depois                       # cookie novo (perfil escolhido)...
    c.post("/api/auth/logout")
    assert not _vale(antes, servidor) and not _vale(depois, servidor)   # ...mas a mesma sessao


def test_sair_de_um_aparelho_nao_derruba_o_outro(admin, servidor):
    a, b = _login(servidor), _login(servidor)
    a.post("/api/auth/logout")
    assert not _vale(a.cookies, servidor)
    assert _vale(b.cookies, servidor)
    b.post("/api/auth/logout")


def test_cookie_antigo_sem_id_tambem_e_revogavel(admin, servidor):
    # cookie emitido antes desta versao: sem o campo "s"
    token = auth._issue_session("")
    raw, _ = token.rsplit(".", 1)
    payload = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    payload.pop("s")
    novo = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    legado = novo + "." + auth._sign(novo)
    assert auth._session_info(legado) is not None
    assert auth._revogar_sessao(legado) is True
    assert auth._session_info(legado) is None


def test_revogacao_sobrevive_a_reinicio_e_o_arquivo_e_privado(admin, servidor):
    c = _login(servidor)
    copia = dict(c.cookies)
    c.post("/api/auth/logout")
    auth._revogadas = None                        # "reinicia" o servidor: a memoria some, o disco fica
    assert not _vale(copia, servidor)
    modo = stat.S_IMODE(os.stat(config.SESSOES_REVOGADAS_PATH).st_mode)
    assert modo == 0o600


def test_lista_de_revogadas_poda_as_que_ja_expirariam(admin, servidor):
    with auth._auth_lock:
        auth._revogadas_carregadas()["velha"] = time.time() - 10
        auth._revogadas_carregadas()["valida"] = time.time() + 1000
        auth._gravar_revogadas(time.time())
    assert "velha" not in auth._revogadas and "valida" in auth._revogadas


def test_token_adulterado_nao_revoga_nada():
    assert auth._revogar_sessao("lixo.assinatura") is False
    assert auth._revogar_sessao("") is False


# ── limite de tentativas sobrevive a reinicio ────────────────
def test_tentativas_de_login_sobrevivem_a_reinicio(admin):
    chave = "teste-reinicio|pin|zzz"
    auth._login_attempts.pop(chave, None)
    for _ in range(config.LOGIN_MAX_ATTEMPTS):
        auth._record_login_failure(chave)
    assert auth._login_blocked(chave) is True
    # "reinicia": memoria zerada, arquivo no disco
    auth._login_attempts.clear()
    auth._tentativas_lidas = False
    assert auth._login_blocked(chave) is True, "o reinicio zerou o contador de tentativas"
    assert stat.S_IMODE(os.stat(config.TENTATIVAS_LOGIN_PATH).st_mode) == 0o600
    auth._clear_login_failures(chave)
    auth._login_attempts.clear()
    auth._tentativas_lidas = False
    assert auth._login_blocked(chave) is False


def test_tentativas_antigas_nao_voltam_do_disco(admin, tmp_path):
    antigo = time.time() - config.LOGIN_WINDOW - 60
    config.TENTATIVAS_LOGIN_PATH.write_text(json.dumps({"ip-velho": [antigo] * 20}))
    auth._login_attempts.clear()
    auth._tentativas_lidas = False
    assert auth._login_blocked("ip-velho") is False
