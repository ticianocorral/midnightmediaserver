"""Rodada 3 da auditoria: acervo e arquivos nao confiaveis (symlinks, ffmpeg)."""
import json
import os
import urllib.parse as up
from unittest import mock

import pytest

from mediaserver import prepare, scanner, sources, thumbs


# ── symlinks dentro do acervo ────────────────────────────────
@pytest.fixture(scope="module")
def acervo_malicioso(tmp_path_factory, home):
    fora = tmp_path_factory.mktemp("fora")
    (fora / "segredo.txt").write_text("CONTEUDO-FORA-DA-FONTE")
    (fora / "segredo.nfo").write_text("<movie><title>TITULO-FORA</title><plot>PLOT-FORA</plot></movie>")
    (fora / "segredo.srt").write_text("1\n00:00:01,000 --> 00:00:02,000\nLEGENDA-FORA\n")
    (fora / "Filme Externo").mkdir()
    (fora / "Filme Externo" / "Filme Externo.mkv").write_bytes(b"x")
    raiz = tmp_path_factory.mktemp("hdm") / "Media Server"
    m = raiz / "Movies" / "Filme Normal (2000)"
    m.mkdir(parents=True)
    (m / "Filme Normal.mkv").write_bytes(b"x")
    os.symlink(fora / "segredo.txt", m / "poster.jpg")
    os.symlink(fora / "segredo.nfo", m / "movie.nfo")
    os.symlink(fora / "segredo.srt", m / "Filme Normal.srt")
    os.symlink(fora / "Filme Externo", raiz / "Movies" / "Filme Externo")
    src, err = sources.add_source("HDM", str(raiz.parent))
    assert not err, err
    scanner.scan_all()
    return raiz


def _caminho_filme(admin):
    return next(f["path"] for f in admin.get("/api/all-movies").json if "Filme Normal" in f["path"])


def test_nfo_que_e_symlink_para_fora_nao_e_lido(admin, acervo_malicioso):
    base = _caminho_filme(admin)
    detalhe = admin.get("/api/movie-detail?path=" + up.quote(base, safe="")).raw.decode()
    assert "TITULO-FORA" not in detalhe and "PLOT-FORA" not in detalhe


@pytest.mark.parametrize("rota,arquivo", [("stream", "poster.jpg"), ("subtitle", "Filme Normal.srt"), ("stream", "movie.nfo")])
def test_arquivo_symlink_para_fora_nao_e_servido(admin, acervo_malicioso, rota, arquivo):
    base = _caminho_filme(admin)
    r = admin.get("/api/%s?path=%s" % (rota, up.quote(base + "/" + arquivo, safe="")))
    assert r.status in (403, 404) and b"FORA" not in r.raw and b"CONTEUDO" not in r.raw


def test_pasta_symlink_para_fora_nao_entra_no_catalogo(admin, acervo_malicioso):
    assert not any("Externo" in f["path"] for f in admin.get("/api/all-movies").json)


# ── ffmpeg: so conteineres de video, so arquivo local ────────
@pytest.mark.parametrize("nome,ok", [
    ("matroska,webm", True), ("mov,mp4,m4a,3gp,3g2,mj2", True), ("avi", True), ("mpegts", True),
    ("hls,applehttp", False), ("concat", False), ("image2", False), ("sdp", False), ("rtsp", False),
    ("dash", False), ("", False), (None, False), ("matroska,hls", False),
])
def test_formato_de_video_permitido(nome, ok):
    assert prepare.formato_de_video_permitido(nome) is ok


def _ffprobe_devolvendo(format_name):
    saida = json.dumps({"format": {"format_name": format_name, "duration": "10"},
                        "streams": [{"codec_type": "video", "codec_name": "h264", "index": 0}]})
    return mock.Mock(returncode=0, stdout=saida.encode())


def test_probe_recusa_playlist_disfarcada_de_video(capsys):
    with mock.patch.object(prepare, "_ffprobe_bin", return_value="ffprobe"), \
            mock.patch.object(prepare.subprocess, "run", return_value=_ffprobe_devolvendo("hls,applehttp")):
        assert prepare._probe("/x/filme.mkv") is None
    assert "formato recusado" in capsys.readouterr().err


def test_probe_aceita_mkv_e_so_usa_protocolo_de_arquivo():
    with mock.patch.object(prepare, "_ffprobe_bin", return_value="ffprobe"), \
            mock.patch.object(prepare.subprocess, "run", return_value=_ffprobe_devolvendo("matroska,webm")) as run:
        info = prepare._probe("/x/filme.mkv")
    assert info and info["v"] == "h264"
    cmd = run.call_args[0][0]
    assert cmd[cmd.index("-protocol_whitelist") + 1] == "file"


def test_comando_do_ffmpeg_so_le_arquivo_local_e_forca_o_formato_da_legenda():
    info = {"vidx": 0, "aidx": 1, "v": "h264", "a": "aac"}
    with mock.patch.object(prepare, "_ffmpeg_bin", return_value="ffmpeg"):
        cmd = prepare._cmd("/x/filme.mkv", info, "/tmp/saida.mp4", "/x/filme.srt")
    inputs = [i for i, a in enumerate(cmd) if a == "-i"]
    assert len(inputs) == 2
    for i in inputs:                        # cada entrada vem com protocolo so-arquivo logo antes
        assert cmd[i - 2:i] == ["-protocol_whitelist", "file"] or cmd[i - 4:i - 2] == ["-protocol_whitelist", "file"]
    i_sub = inputs[1]
    assert cmd[i_sub - 2:i_sub] == ["-f", "srt"]        # legenda: formato forcado, sem sondar o conteudo


def test_miniatura_via_ffmpeg_so_le_arquivo_local_e_forca_imagem(tmp_path):
    cmd = thumbs._comando(("ffmpeg", "ffmpeg"), tmp_path / "poster.jpg", tmp_path / "t.tmp", ".jpg")
    assert cmd[cmd.index("-protocol_whitelist") + 1] == "file"
    i = cmd.index("-i")
    assert cmd[i - 2:i] == ["-f", "image2"]


# ── wizard do rclone: valor nao pode virar flag ──────────────
def test_wizard_passa_chave_valor_em_um_argumento(monkeypatch):
    from mediaserver import nuvem
    chamadas = []
    monkeypatch.setattr(nuvem, "_remotes_no_conf", lambda: set())
    monkeypatch.setattr(nuvem, "providers", lambda: ([{"tipo": "b2", "nome": "B2", "opcoes": [
        {"nome": "account", "senha": False}, {"nome": "key", "senha": True}]}], None))
    monkeypatch.setattr(nuvem, "_run", lambda args, timeout=60: (chamadas.append(args) or (0, "", "")))
    r, err = nuvem.criar_remote("meu", "b2", {"account": "--config=/tmp/x", "key": "-x"})
    assert err is None
    criar = chamadas[0]
    assert "account=--config=/tmp/x" in criar and "key=-x" in criar
    assert "--config=/tmp/x" not in criar and "-x" not in criar           # nunca como argumento solto


# ── NFO: nota e votos so como numero ─────────────────────────
@pytest.mark.parametrize("bruto,esperado", [
    ("7.5", "7.5"), ("7,5", "7.5"), ("9", "9"),
    ("8<img src=x onerror=alert(1)>", None), ("", None), (None, None), ("1e9", None), ("12345678901", None),
])
def test_nota_do_nfo_so_numero(bruto, esperado):
    from mediaserver import nfo
    assert nfo._numero(bruto, decimais=True) == esperado


@pytest.mark.parametrize("bruto,esperado", [("1.234", "1234"), ("12345", "12345"), ("<svg onload=1>", None), ("", None), (None, None)])
def test_votos_do_nfo_so_numero(bruto, esperado):
    from mediaserver import nfo
    assert nfo._numero(bruto, decimais=False) == esperado


def test_nfo_malicioso_nao_leva_html_em_nota_nem_votos():
    from mediaserver import nfo
    xml = ("<movie><title>T</title><rating>8<img src=x onerror=1></rating>"
           "<ratings><rating><value>9</value><votes>1<svg onload=1></votes></rating></ratings></movie>")
    meta = nfo._parse_nfo(xml.replace("<img src=x onerror=1>", "&lt;img src=x onerror=1&gt;").replace("<svg onload=1>", "&lt;svg onload=1&gt;"))
    assert "<" not in str(meta["rating"]) and "<" not in str(meta["votes"])
