"""Primeiro uso: pasta sem a subpasta do acervo e seletor de pasta."""
import pytest

from mediaserver import sources


def _video(p):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x")


def test_pasta_sem_subpasta_do_acervo_pede_confirmacao(tmp_path, home):
    pasta = tmp_path / "MeusFilmes"
    _video(pasta / "Filme (2020)" / "Filme.mkv")
    src, err = sources.add_source("Meus", str(pasta))
    assert src is None
    assert isinstance(err, sources.SemPastaBiblioteca)
    assert "propria pasta" in err


def test_confirmando_a_propria_pasta_vira_o_acervo(tmp_path, home):
    pasta = tmp_path / "OutrosFilmes"
    _video(pasta / "Filme.mkv")
    src, err = sources.add_source("Outros", str(pasta), aceitar_pasta=True)
    assert err is None
    assert src["root"] == str(pasta.resolve())
    assert not src["descended"]
    sources.remove_source(src["id"])


def test_pasta_ampla_demais_continua_barrada_mesmo_confirmando(home):
    from pathlib import Path
    src, err = sources.add_source("Casa", str(Path.home()), aceitar_pasta=True)
    assert src is None and not isinstance(err, sources.SemPastaBiblioteca)


def test_navegador_lista_subpastas_e_conta_videos(tmp_path, home):
    base = tmp_path / "nav"
    (base / "B").mkdir(parents=True)
    (base / "a").mkdir()
    (base / ".oculta").mkdir()
    _video(base / "x.mkv")
    d = sources.browse(str(base))
    assert [p["name"] for p in d["pastas"]] == ["a", "B"]
    assert d["videos"] == 1 and d["usavel"] is True
    assert d["parent"] == str(tmp_path.resolve())


def test_navegador_sem_caminho_devolve_atalhos(home):
    d = sources.browse("")
    assert d["path"] == "" and d["atalhos"]


def test_navegador_erro_em_pasta_inexistente(tmp_path, home):
    assert "erro" in sources.browse(str(tmp_path / "nao-existe"))


def test_rota_browse_so_para_admin(admin, usuario):
    assert admin.get("/api/sources/browse").status == 200
    assert usuario.get("/api/sources/browse").status == 403
