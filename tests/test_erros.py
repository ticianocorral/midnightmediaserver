"""Falhas que o app contorna: devem continuar contornadas, mas agora avisando.

Cada trecho aqui engolia `except Exception: pass`. O comportamento (valor devolvido)
nao muda; o que muda e que o problema aparece no log, e que um erro INESPERADO
nao e mais escondido onde o tipo esperado e conhecido.
"""
import sqlite3
import subprocess
from unittest import mock

import pytest

from mediaserver import auth, handler, log, nfo, paths, prepare, scraper, netsec

PREFIXO = "[Midnight Media Server] AVISO"


@pytest.fixture(autouse=True)
def zera_limite_do_log():
    log._ULTIMO.clear()


def avisos(capsys):
    return [l for l in capsys.readouterr().err.splitlines() if l.startswith(PREFIXO)]


# ── o helper ──
def test_aviso_escreve_no_formato_do_app(capsys):
    assert log.aviso("contexto x", OSError("disco cheio")) is True
    assert avisos(capsys) == [PREFIXO + " contexto x: OSError: disco cheio"]


def test_aviso_nao_inunda_o_log(capsys):
    assert log.aviso("c", agora=100.0) is True
    assert log.aviso("c", agora=130.0) is False      # mesmo contexto, <60 s
    assert log.aviso("outro", agora=130.0) is True    # contexto diferente passa
    assert log.aviso("c", agora=161.0) is True        # passou 1 min
    assert len(avisos(capsys)) == 3


def test_aviso_nunca_levanta_excecao():
    with mock.patch.object(log.sys, "stderr", mock.Mock(write=mock.Mock(side_effect=OSError))):
        assert log.aviso("c") is False


# ── auth.json: ausente e normal, corrompido merece aviso ──
def test_auth_ausente_e_silencioso(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(auth, "AUTH_PATH", tmp_path / "nao-existe.json")
    assert auth._auth_data() is None
    assert avisos(capsys) == []


def test_auth_corrompido_avisa_e_cai_em_nao_configurado(monkeypatch, tmp_path, capsys):
    f = tmp_path / "auth.json"
    f.write_text("{ isto nao e json")
    monkeypatch.setattr(auth, "AUTH_PATH", f)
    assert auth._auth_data() is None
    assert any("auth.json ilegivel" in l for l in avisos(capsys))


# ── NFO via rclone ──
@pytest.mark.parametrize("erro", [OSError("sem rclone"), subprocess.TimeoutExpired("rclone", 15)])
def test_nfo_falha_do_rclone_devolve_none_e_avisa(monkeypatch, capsys, erro):
    monkeypatch.setattr(paths, "_nuvem_cache", ("b2", "acervo"))
    with mock.patch.object(nfo, "_is_local_path", return_value=False, create=True), \
            mock.patch.object(nfo.subprocess, "run", side_effect=erro):
        assert nfo._fetch_nfo_raw("/Media Server/Filme") is None
    assert any("nfo: rclone cat falhou" in l for l in avisos(capsys))


# ── metadado do cache de conversao ──
def test_limpeza_ignora_metadado_corrompido_e_avisa(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(prepare, "CAST_CACHE_DIR", tmp_path)
    (tmp_path / "ruim.json").write_text("{{{")
    prepare._limpar_vencidos()                       # nao levanta
    assert any("metadado ilegivel" in l for l in avisos(capsys))


# ── capa do scraper ──
def test_imagem_que_nao_baixa_devolve_none_e_avisa(capsys):
    with mock.patch.object(scraper.urllib.request, "urlopen", side_effect=OSError("sem rede")):
        assert scraper._baixar_imagem("https://image.tmdb.org/x.jpg") is None
    assert any("imagem nao baixou" in l for l in avisos(capsys))


def test_imagem_erro_inesperado_nao_e_mais_engolido():
    with mock.patch.object(scraper.urllib.request, "urlopen", side_effect=RuntimeError("bug")):
        with pytest.raises(RuntimeError):
            scraper._baixar_imagem("https://image.tmdb.org/x.jpg")


# ── tipo de imagem no banco ──
def test_tipo_de_imagem_com_banco_quebrado_devolve_vazio_e_avisa(capsys):
    with mock.patch.object(handler, "get_db", side_effect=sqlite3.OperationalError("database is locked")):
        assert handler.MediaServerHandler._tipo_de_imagem("/Media Server/F/poster.jpg") == ""
    assert any("tipo no banco" in l for l in avisos(capsys))


def test_tipo_de_imagem_erro_inesperado_propaga():
    with mock.patch.object(handler, "get_db", side_effect=RuntimeError("bug")):
        with pytest.raises(RuntimeError):
            handler.MediaServerHandler._tipo_de_imagem("/Media Server/F/poster.jpg")


# ── cache de legenda que nao grava ──
def test_legenda_serve_mesmo_se_o_cache_nao_grava_e_avisa(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(paths, "_nuvem_cache", ("b2", "acervo"))
    monkeypatch.setattr(handler, "SUBS_CACHE_DIR", tmp_path / "pasta-que-nao-existe")
    h = handler.MediaServerHandler.__new__(handler.MediaServerHandler)
    ok = mock.Mock(returncode=0, stdout=b"1\n00:00:01,000 --> 00:00:02,000\noi\n")
    with mock.patch.object(handler.subprocess, "run", return_value=ok):
        texto = h._read_subtitle_text("/Media Server/Filme/Filme.srt")
    assert texto and "oi" in texto
    assert any("cache em disco nao gravou" in l for l in avisos(capsys))


# ── entradas ruins de cliente continuam sem derrubar nada ──
def test_json_invalido_no_corpo_devolve_none():
    import io
    h = handler.MediaServerHandler.__new__(handler.MediaServerHandler)
    h.headers = {"Content-Length": "5"}
    h.rfile, h._body_lido = io.BytesIO(b"{nao}"), 0
    assert h._read_json_body() is None


@pytest.mark.parametrize("origin", ["http://[::1", "http://host:99999999", "http://[bad"])
def test_origin_malformado_e_recusado_sem_excecao(origin):
    assert netsec.origin_allowed(origin) is False
    assert netsec.origin_mesmo_servidor(origin, "localhost:9187", [9187]) is False
