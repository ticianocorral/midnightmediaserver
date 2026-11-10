"""Servidor real (handler do app) numa porta livre: permissoes, cabecalhos e rotas."""
import gzip
import json
from unittest import mock

import pytest

from mediaserver import handler

ROTAS_SO_ADMIN = [
    "/api/rclone/serve/restart", "/api/rclone/webgui/start", "/api/rclone/webgui/stop",
    "/api/clear-cache", "/api/sources/add", "/api/backup", "/api/infantil/marcar",
]


def test_pagina_de_login_tem_cabecalhos_anti_iframe(servidor):
    from conftest import Cliente
    c = Cliente(*servidor)
    r = c.get("/login")
    assert r.headers["X-Frame-Options"] == "DENY"
    assert "frame-ancestors 'none'" in r.headers["Content-Security-Policy"]


def test_host_publico_e_recusado(servidor):
    from conftest import Cliente
    r = Cliente(*servidor).get("/login", headers={"Host": "evil.com"})
    assert r.status == 403


@pytest.mark.parametrize("rota", ROTAS_SO_ADMIN)
def test_perfil_comum_nao_acessa_rotas_de_admin(usuario, rota):
    assert usuario.post(rota).status == 403


@pytest.mark.parametrize("rota", ["/api/rclone/serve/restart", "/api/clear-cache"])
def test_admin_acessa(admin, rota):
    with mock.patch.object(handler, "restart_rclone_serve", return_value={"status": "ok"}):
        assert admin.post(rota).status == 200


def test_post_com_origin_de_outra_porta_e_recusado(admin, servidor):
    base, porta = servidor
    r = admin.post("/api/refresh", origin=False,
                   headers={"Origin": "http://127.0.0.1:%d" % (porta + 1)})
    assert r.status == 403


def test_post_com_origin_do_proprio_servidor_passa(admin):
    assert admin.post("/api/refresh").status == 200


def test_sem_nuvem_legenda_arbitraria_nao_chama_rclone(admin):
    # regressao do vazamento: /local:/<path> virava `rclone cat :local:/<path>`
    with mock.patch.object(handler.subprocess, "run") as run, \
            mock.patch.object(handler.subprocess, "Popen") as popen:
        for rota in ("subtitle", "stream"):
            for p in ("/local:/etc/hosts", "/local:/tmp/x.srt", "/local:/tmp/x.srt/../y.srt"):
                r = admin.get("/api/%s?path=%s" % (rota, p.replace("/", "%2F").replace(":", "%3A")))
                assert r.status in (404, 403), (rota, p, r.status)
    assert not run.called and not popen.called


def test_legenda_so_aceita_extensao_de_legenda(admin):
    with mock.patch.object(handler.subprocess, "run") as run:
        r = admin.get("/api/subtitle?path=%2FMedia%20Server%2Fx.mkv")
    assert r.status == 404 and not run.called


def test_estatico_versionado_tem_cache_longo_e_gzip(admin):
    r = admin.get("/static/app.js?v=123", headers={"Accept-Encoding": "gzip"})
    assert r.headers["Content-Encoding"] == "gzip"
    assert "immutable" in r.headers["Cache-Control"]
    assert gzip.decompress(r.raw).startswith(b"/") or len(gzip.decompress(r.raw)) > 1000
    sem = admin.get("/static/app.js", headers={"Accept-Encoding": "gzip"})
    assert sem.headers["Cache-Control"] == "max-age=3600"


def test_json_grande_vai_comprimido_e_pequeno_nao(admin):
    grande = [{"name": "Filme %d" % i, "path": "/p/%d" % i} for i in range(2000)]
    h = handler.MediaServerHandler.__new__(handler.MediaServerHandler)
    h.headers = {"Accept-Encoding": "gzip"}
    enviado = {}

    class W:
        def write(self, b): enviado["corpo"] = b
    h.wfile, h._head_only, h._pending_cookies = W(), False, ()
    h.send_response = lambda *a, **k: None
    h.send_header = lambda k, v: enviado.setdefault("h", {}).__setitem__(k, v)
    h.end_headers = lambda: None
    h._send_json(grande)
    assert enviado["h"]["Content-Encoding"] == "gzip"
    assert json.loads(gzip.decompress(enviado["corpo"])) == grande


def test_token_de_midia_nao_vai_para_o_log(admin, capsys):
    admin.get("/api/subtitle?path=%2Fx.srt&t=SEGREDO123")
    assert "SEGREDO123" not in capsys.readouterr().err


def test_perfil_infantil_nao_burla_com_dot_dot(infantil):
    h = handler.MediaServerHandler.__new__(handler.MediaServerHandler)
    with mock.patch.object(handler, "cached_algum_infantil",
                           side_effect=lambda alvos: "/Local/hd/Marcado" in alvos):
        assert h._permitido_infantil("/Local/hd/Marcado/x.mkv") is True
        assert h._permitido_infantil("/Local/hd/Marcado/../Adulto/x.mkv") is False
        assert h._permitido_infantil("/Local/hd/Marcado\\..\\Adulto/x.mkv") is False
