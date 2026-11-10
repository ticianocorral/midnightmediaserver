"""Rodada 2 da auditoria: o perfil infantil nao escapa do filtro nem gasta recursos do servidor."""
from unittest import mock

import pytest

from conftest import Cliente
from mediaserver import scanner

SENHA = "senha-de-teste-123"          # a mesma criada pelo fixture `admin`


def _id_admin(admin):
    return next(p["id"] for p in admin.get("/api/profiles").json["profiles"] if p["role"] == "admin")


def _status(c):
    return c.get("/api/auth/status").json["user"]


@pytest.fixture
def crianca(admin, servidor, infantil):
    """Sessao NOVA no perfil infantil existente (o limite do app e 6 perfis, entao nada de criar um por teste;
    o teste pode trocar de perfil a vontade sem afetar os outros)."""
    pid = next(p["id"] for p in admin.get("/api/profiles").json["profiles"] if p["name"] == "Crianca")
    c = Cliente(*servidor)
    c.cookies = dict(admin.cookies)
    assert c.post("/api/profiles/select", {"id": pid}).status == 200
    assert _status(c)["infantil"] is True
    return c


def test_infantil_nao_vira_admin_sem_a_senha_da_conta(admin, crianca):
    r = crianca.post("/api/profiles/select", {"id": _id_admin(admin), "pin": ""})
    assert r.status == 401 and r.json["precisaSenha"] is True
    assert _status(crianca)["infantil"] is True and _status(crianca)["role"] != "admin"


def test_infantil_com_senha_errada_continua_infantil(admin, crianca):
    r = crianca.post("/api/profiles/select", {"id": _id_admin(admin), "password": "chute"})
    assert r.status == 401
    assert _status(crianca)["infantil"] is True


def test_infantil_com_a_senha_certa_pode_sair(admin, crianca):
    r = crianca.post("/api/profiles/select", {"id": _id_admin(admin), "password": SENHA})
    assert r.status == 200
    assert _status(crianca)["role"] == "admin" and _status(crianca)["infantil"] is False


def test_admin_e_comum_trocam_de_perfil_sem_senha(admin, usuario, servidor):
    # a regra e so para quem esta NO perfil infantil. Sessoes NOVAS: nao mexer nos clientes
    # `admin`/`usuario`, que sao compartilhados com o resto da suite.
    pid_comum = next(p["id"] for p in admin.get("/api/profiles").json["profiles"] if p["name"] == "Comum")
    c = Cliente(*servidor)
    c.cookies = dict(admin.cookies)
    assert c.post("/api/profiles/select", {"id": pid_comum}).status == 200
    assert c.post("/api/profiles/select", {"id": _id_admin(admin)}).status == 200


def test_infantil_para_outro_infantil_nao_pede_senha(admin, crianca, servidor):
    nomes = [p["name"] for p in admin.get("/api/profiles").json["profiles"]]
    if "Crianca-B" not in nomes:
        admin.post("/api/profiles/save", {"id": "", "name": "Crianca-B", "avatar": "a04", "infantil": True, "role": "user"})
    outro = next(p["id"] for p in admin.get("/api/profiles").json["profiles"] if p["name"] == "Crianca-B")
    assert crianca.post("/api/profiles/select", {"id": outro}).status == 200


@pytest.mark.parametrize("rota", ["/api/refresh", "/api/cache-download", "/api/uncache"])
def test_rotas_pesadas_fechadas_para_o_infantil(infantil, usuario, rota):
    assert infantil.post(rota + "?path=%2FMedia%20Server%2Fx").status == 403
    assert usuario.post(rota + "?path=%2FMedia%20Server%2Fx").status != 403     # perfil comum continua usando


def test_scan_progress_nao_mostra_titulos_ao_infantil(admin, infantil):
    # mock, e nao o estado real do scanner: um scan de fundo de outro teste escreveria por cima
    falso = {"phase": "indexing", "movie_current": "Titulo-Secreto", "source_current": "Fonte-Secreta", "percent": 42}
    with mock.patch.object(scanner, "get_progress", return_value=dict(falso)):
        crianca = infantil.get("/api/scan-progress").json
        adm = admin.get("/api/scan-progress").json
    assert crianca["movie_current"] == "" and crianca["source_current"] == "" and crianca["percent"] == 42
    assert adm["movie_current"] == "Titulo-Secreto"
