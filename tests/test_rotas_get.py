"""Teste de caracterizacao das rotas GET.

Registra, para cada rota do do_GET, o status que cada tipo de usuario recebe
(sem login, admin, perfil comum e infantil). Foi gravado ANTES de extrair as
rotas do do_GET para a tabela _ROTAS_GET e prova que a refatoracao nao mudou
comportamento. Se uma rota mudar de proposito, regrave com:

    MS_REGRAVAR_SNAPSHOT=1 python3 -m pytest tests/test_rotas_get.py

Efeitos externos (rclone, ffmpeg, rede) ficam desligados: subprocess e urllib sao
trocados por falhas, entao so o roteamento e a permissao sao testados.
"""
import json
import os
from pathlib import Path
from unittest import mock

import pytest

from mediaserver import handler

SNAPSHOT = Path(__file__).parent / "snapshots" / "rotas_get.json"
ROTAS = json.loads('["/api/scrape/status", "/api/scrape/pendentes", "/api/scrape/search", "/api/scrape/capas", "/api/organizar/itens", "/api/organizar/buscar", "/api/organizar/historico", "/api/profiles", "/perfis", "/manifest.webmanifest", "/branding.css", "/ca.crt", "/api/branding", "/api/branding/set", "/api/refresh", "/api/sources", "/api/sources/detect", "/api/sources/add", "/api/sources/remove", "/api/nuvem/status", "/api/nuvem/conectar", "/api/nuvem/desconectar", "/api/rclone/remotes", "/api/rclone/providers", "/api/rclone/wizard", "/api/scan-progress", "/api/backup", "/api/backup/local", "/api/backup/b2", "/api/restore/b2", "/api/cache-manager", "/api/cache-download", "/api/cache-download-progress", "/api/check-cached", "/api/clear-cache", "/api/uncache", "/api/cache-status", "/api/genres", "/api/recent-movies", "/api/continue-watching", "/api/progress", "/api/list", "/api/collections", "/api/collection", "/api/generos", "/api/genero", "/api/generos/de", "/api/infantil/marcar", "/api/colecoes/create", "/api/colecoes/update", "/api/colecoes/delete", "/api/generos/create", "/api/generos/delete", "/api/generos/atribuir", "/api/generos/renomear", "/api/watched", "/api/series", "/api/serie", "/api/movie-detail", "/api/search", "/api/all-movies", "/api/stream", "/api/prepared", "/api/prepare-status", "/api/subtitle", "/api/info", "/api/rclone/status", "/", "/favicon.ico", "/static/app.js", "/icone-192.png", "/rota-que-nao-existe", "/api/subtitle?path=%2Fx.mkv", "/", "/favicon.ico", "/static/app.js", "/icone-192.png", "/rota-que-nao-existe", "/api/subtitle?path=%2Fx.mkv"]')


@pytest.fixture
def sem_efeitos():
    falha = mock.Mock(side_effect=OSError("desligado nos testes"))
    with mock.patch.object(handler.subprocess, "run", falha), \
            mock.patch.object(handler.subprocess, "Popen", falha), \
            mock.patch.object(handler.urllib.request, "urlopen", falha):
        yield


def _status(cliente, rota):
    from conftest import Cliente
    try:
        return cliente.get(rota).status
    except Exception as e:          # conexao encerrada pelo servidor etc.
        return type(e).__name__


def test_rotas_get_mantem_o_comportamento(servidor, admin, usuario, infantil, sem_efeitos):
    from conftest import Cliente
    anon = Cliente(*servidor)
    atual = {}
    for rota in ROTAS:
        atual[rota] = {"anon": _status(anon, rota), "admin": _status(admin, rota),
                       "comum": _status(usuario, rota), "infantil": _status(infantil, rota)}
    if os.environ.get("MS_REGRAVAR_SNAPSHOT"):
        SNAPSHOT.write_text(json.dumps(atual, indent=1, sort_keys=True), encoding="utf-8")
        pytest.skip("snapshot regravado")
    esperado = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    diferencas = {r: (esperado.get(r), atual.get(r)) for r in set(esperado) | set(atual)
                  if esperado.get(r) != atual.get(r)}
    assert not diferencas, diferencas


def test_nenhuma_rota_get_estoura_500_para_admin(admin, sem_efeitos):
    erros = {r: _status(admin, r) for r in ROTAS}
    assert not {r: s for r, s in erros.items() if s == 500}, erros
