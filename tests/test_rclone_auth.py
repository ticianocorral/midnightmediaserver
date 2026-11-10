"""O rclone local (serve http e rcd) agora exige senha aleatoria, entregue por ambiente."""
import base64
import http.server
import threading
from unittest import mock

import pytest

from mediaserver import rclone, rclone_auth


def test_senha_e_aleatoria_forte_e_o_cabecalho_e_basic():
    assert len(rclone_auth.senha()) >= 32
    h = rclone_auth.cabecalho()["Authorization"]
    assert h.startswith("Basic ")
    assert base64.b64decode(h[6:]).decode() == "media-server:" + rclone_auth.senha()


def test_env_leva_a_senha_e_nao_ha_argumento():
    assert rclone_auth.env_serve() == {"RCLONE_USER": "media-server", "RCLONE_PASS": rclone_auth.senha()}
    assert rclone_auth.env_rc() == {"RCLONE_RC_USER": "media-server", "RCLONE_RC_PASS": rclone_auth.senha()}


class _ServeFalso(http.server.BaseHTTPRequestHandler):
    """Imita o `rclone serve http --user/--pass`: 401 sem a credencial certa."""
    def do_GET(self):
        ok = self.headers.get("Authorization") == rclone_auth.cabecalho()["Authorization"]
        self.send_response(200 if ok else 401)
        self.send_header("WWW-Authenticate", 'Basic realm="rclone"')
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *a):
        pass


@pytest.fixture
def serve_falso():
    srv = http.server.HTTPServer(("127.0.0.1", 0), _ServeFalso)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d/" % srv.server_address[1]
    srv.shutdown()


def test_sondagem_usa_a_credencial_e_sem_ela_o_serve_recusa(serve_falso):
    import urllib.error
    import urllib.request
    assert rclone._urlopen_ok(serve_falso) is True                      # com a senha do app: 200
    with pytest.raises(urllib.error.HTTPError) as e:                    # como "outro processo local": 401
        urllib.request.urlopen(serve_falso, timeout=3)
    assert e.value.code == 401
    assert rclone._porta_responde(serve_falso) is True                  # 401 ainda conta como "a porta responde"


def test_serve_sobe_com_senha_no_ambiente_e_nunca_no_argv(monkeypatch):
    monkeypatch.setattr(rclone, "remote_configurado", lambda: True)
    monkeypatch.setattr(rclone, "_porta_responde", lambda *a, **k: True)
    monkeypatch.setattr(rclone, "_urlopen_ok", lambda *a, **k: True)
    monkeypatch.setattr(rclone.time, "sleep", lambda *_: None)
    monkeypatch.setattr(rclone, "_kill_rclone_on_port", lambda *_: None)
    monkeypatch.setattr(rclone, "_rc_remote", lambda *_: "b2:acervo")
    with mock.patch.object(rclone.subprocess, "Popen") as popen, \
            mock.patch("urllib.request.urlopen", side_effect=OSError("nada rodando")):
        popen.return_value = mock.Mock(poll=lambda: None)
        rclone.start_rclone_serve()
    assert popen.called
    argv = popen.call_args[0][0]
    envv = popen.call_args[1]["env"]
    assert envv["RCLONE_PASS"] == rclone_auth.senha() and envv["RCLONE_USER"] == "media-server"
    assert rclone_auth.senha() not in " ".join(argv) and "--pass" not in argv and "--user" not in argv


def test_gui_do_rclone_nao_sobe_mais_sem_autenticacao(monkeypatch):
    monkeypatch.setattr(rclone, "RCLONE_GUI_ENABLED", True)
    monkeypatch.setattr(rclone, "rclone_webgui_proc", None)
    monkeypatch.setattr(rclone, "_urlopen_ok", lambda *a, **k: True)
    monkeypatch.setattr(rclone.time, "sleep", lambda *_: None)
    with mock.patch.object(rclone.subprocess, "Popen") as popen:
        popen.return_value = mock.Mock(poll=lambda: None)
        r = rclone.start_rclone_webgui()
    argv = popen.call_args[0][0]
    assert "--rc-no-auth" not in argv
    assert popen.call_args[1]["env"]["RCLONE_RC_PASS"] == rclone_auth.senha()
    assert rclone_auth.senha() not in " ".join(argv)
    assert r["status"] == "ok" and rclone_auth.senha() in r["url"]       # so o admin recebe esta URL


def test_status_aberto_a_todos_nao_vaza_a_senha_da_gui(usuario):
    r = usuario.get("/api/rclone/status")
    assert rclone_auth.senha() not in r.raw.decode()
