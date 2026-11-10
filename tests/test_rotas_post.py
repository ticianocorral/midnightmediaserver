"""Caracterizacao das rotas de escrita (POST).

Estas rotas ficam atras do guard de WRITE_ROUTES e so rodam via POST, entao o
snapshot de GET (test_rotas_get.py) nao passa por elas. Registra o status de cada
uma para sem login, admin, perfil comum e infantil, com rclone/ffmpeg/rede
desligados. Regrave de proposito com MS_REGRAVAR_SNAPSHOT=1.
"""
import json
import os
from pathlib import Path
from unittest import mock

import pytest

from mediaserver import config, handler

SNAPSHOT = Path(__file__).parent / "snapshots" / "rotas_post.json"
ROTAS = sorted(config.WRITE_ROUTES)
CONSULTA = "?path=%2FMedia%20Server%2Fx&source=hd&id=1&nome=x"


def _status(cliente, rota):
    try:
        return cliente.post(rota + CONSULTA, {}).status
    except Exception as e:
        return type(e).__name__


def test_rotas_post_mantem_o_comportamento(servidor, admin, usuario, infantil):
    from conftest import Cliente
    falha = mock.Mock(side_effect=OSError("desligado nos testes"))
    atual = {}
    with mock.patch.object(handler.subprocess, "run", falha), \
            mock.patch.object(handler.subprocess, "Popen", falha), \
            mock.patch.object(handler.urllib.request, "urlopen", falha):
        for rota in ROTAS:
            atual[rota] = {"anon": _status(Cliente(*servidor), rota), "admin": _status(admin, rota),
                           "comum": _status(usuario, rota), "infantil": _status(infantil, rota)}
    if os.environ.get("MS_REGRAVAR_SNAPSHOT"):
        SNAPSHOT.write_text(json.dumps(atual, indent=1, sort_keys=True), encoding="utf-8")
        pytest.skip("snapshot regravado")
    esperado = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    assert {r: (esperado.get(r), atual.get(r)) for r in set(esperado) | set(atual)
            if esperado.get(r) != atual.get(r)} == {}


def test_nenhuma_rota_post_estoura_500_para_admin(admin):
    falha = mock.Mock(side_effect=OSError("desligado nos testes"))
    with mock.patch.object(handler.subprocess, "run", falha), \
            mock.patch.object(handler.subprocess, "Popen", falha), \
            mock.patch.object(handler.urllib.request, "urlopen", falha):
        erros = {r: _status(admin, r) for r in ROTAS}
    assert not {r: s for r, s in erros.items() if s == 500}, erros
