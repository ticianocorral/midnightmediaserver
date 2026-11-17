"""Scanner: detecta filmes e series e nao muda o resultado ao rodar de novo."""
import sqlite3

import pytest

from mediaserver import db, scanner, sources


def _arq(p, conteudo=b"x"):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(conteudo)


@pytest.fixture(scope="module")
def acervo(tmp_path_factory, home):
    raiz = tmp_path_factory.mktemp("hd") / "Media Server"
    for i in range(30):
        d = raiz / "Movies" / ("Filme %d (19%02d)" % (i, 80 + i % 20))
        _arq(d / ("Filme %d.mkv" % i)); _arq(d / "poster.jpg")
    # colecao: pasta com video solto E subpasta com filme (o solto nao e "o filme pai")
    _arq(raiz / "Movies" / "Colecao" / "trailer.mkv")
    _arq(raiz / "Movies" / "Colecao" / "Parte 1" / "Parte 1.mkv")
    for s in range(4):
        for t in (1, 2):
            for e in (1, 2, 3):
                _arq(raiz / "TV Shows" / ("Serie %d" % s) / ("Temporada %d" % t) / ("S0%dE0%d.mkv" % (t, e)))
    src, err = sources.add_source("HD", str(raiz.parent))
    assert not err, err
    scanner.scan_all()
    return raiz


def _consulta(sql, *args):
    conn = db.get_db()
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def test_acha_todos_os_videos(acervo):
    n = _consulta("SELECT COUNT(*) c FROM files WHERE file_type='video'")[0]["c"]
    assert n == 30 + 2 + 4 * 2 * 3


def test_pasta_pai_com_filme_dentro_nao_vira_filme(acervo):
    pastas = {r["path"] for r in _consulta("SELECT path FROM folders WHERE has_video=1")}
    assert any(p.endswith("/Colecao/Parte 1") for p in pastas)


def test_segundo_scan_nao_muda_o_catalogo(acervo):
    antes = (_consulta("SELECT folder_path,name,size FROM files ORDER BY 1,2"),
             _consulta("SELECT path,has_video FROM folders ORDER BY 1"))
    scanner.scan_all()
    depois = (_consulta("SELECT folder_path,name,size FROM files ORDER BY 1,2"),
              _consulta("SELECT path,has_video FROM folders ORDER BY 1"))
    assert [tuple(r) for r in antes[0]] == [tuple(r) for r in depois[0]]
    assert [tuple(r) for r in antes[1]] == [tuple(r) for r in depois[1]]


def test_remover_arquivo_some_do_catalogo(acervo):
    alvo = acervo / "Movies" / "Filme 0 (1980)" / "Filme 0.mkv"
    alvo.unlink()
    scanner.scan_all()
    nomes = {r["name"] for r in _consulta("SELECT name FROM files WHERE name LIKE 'Filme 0.%'")}
    assert "Filme 0.mkv" not in nomes


def test_metadado_some_quando_o_nfo_local_e_apagado(acervo):
    # regressao: o filme sem .nfo nem poster continuava com o metadado antigo no banco
    pasta = acervo / "Movies" / "Filme 5 (1985)"
    _arq(pasta / "Filme 5.nfo", b"<movie><title>Filme 5</title><year>1985</year></movie>")
    scanner.scan_all()
    folder = [r["path"] for r in _consulta("SELECT path FROM folders WHERE path LIKE ?", "%/Filme 5 (1985)")][0]
    assert _consulta("SELECT 1 FROM movie_meta WHERE folder_path=?", folder)
    (pasta / "Filme 5.nfo").unlink()
    scanner.scan_all()
    assert not _consulta("SELECT 1 FROM movie_meta WHERE folder_path=?", folder)


def test_scan_sem_nuvem_nao_derruba_as_fontes_locais(acervo):
    # regressao: scan_cloud levantava CaminhoInvalido e scan_all abortava
    assert scanner.scan_cloud() is False


def test_consulta_por_arquivo_usa_o_indice(acervo):
    conn = db.get_db()
    try:
        pasta, nome = db.partir_caminho("/Media Server/Movies/Filme 1 (1981)/Filme 1.mkv")
        plano = conn.execute(
            "EXPLAIN QUERY PLAN SELECT 1 FROM files WHERE folder_path = ? AND name = ?",
            (pasta, nome)).fetchall()
    finally:
        conn.close()
    assert "USING" in " ".join(str(r[3]) for r in plano) and "SCAN" not in str(plano[0][3])


def test_partir_caminho():
    assert db.partir_caminho("/a/b/c.mkv") == ("/a/b", "c.mkv")
    assert db.partir_caminho("/c.mkv") == ("", "c.mkv")


def test_substituir_arquivos_sobrescreve_sem_copia(tmp_path):
    from mediaserver import scraper
    pasta = tmp_path / "Filme (2000)"
    _arq(pasta / "Filme (2000).nfo", b"<movie><title>Velho</title></movie>")
    _arq(pasta / "Filme (2000).mkv")
    meta = {"title": "Novo", "year": "2000", "genres": [], "actors": [], "directors": [],
            "writers": [], "studios": [], "country": [], "tags": []}
    assert scraper.substituir_arquivos(pasta, meta)
    assert "Novo" in (pasta / "Filme (2000).nfo").read_text(encoding="utf-8")
    assert not list(pasta.glob("*.anterior*"))


def test_idioma_do_metadado_so_aceita_pt_br_ou_en_us():
    from mediaserver import scraper
    assert scraper.idioma_valido("en-US") == "en-US"
    assert scraper.idioma_valido("pt-BR") == "pt-BR"
    assert scraper.idioma_valido("fr-FR") == "pt-BR"
    assert scraper.idioma_valido(None) == "pt-BR"


def test_renomear_no_lugar_segue_o_titulo_do_idioma(tmp_path, home):
    from mediaserver import organizador
    raiz = tmp_path / "disco" / "Media Server"
    pasta = raiz / "movies" / "Jason Goes to Hell (1993)"
    pasta.mkdir(parents=True)
    with open(pasta / "Jason Goes to Hell (1993).mp4", "wb") as f:
        f.truncate(31 * 1024 * 1024)   # esparso: passa do minimo de video sem ocupar disco
    _arq(pasta / "Jason Goes to Hell (1993).srt")
    _arq(pasta / "Jason Goes to Hell (1993).nfo")
    _arq(pasta / "poster.jpg")
    src, err = sources.add_source("Disco renomear", str(raiz.parent))
    assert not err, err
    logico = src["mount"] + "/movies/Jason Goes to Hell (1993)"
    novo, erro = organizador.renomear_no_lugar(logico, "Jason Vai para o Inferno: A Última Sexta-Feira", "1993")
    assert erro is None
    nome = "Jason Vai para o Inferno - A Última Sexta-Feira (1993)"
    assert novo == src["mount"] + "/movies/" + nome
    destino = raiz / "movies" / nome
    assert sorted(p.name for p in destino.iterdir()) == sorted(
        [nome + ".mp4", nome + ".srt", nome + ".nfo", "poster.jpg"])
    assert not pasta.exists()
    # mesmo titulo de novo: nada a fazer
    assert organizador.renomear_no_lugar(novo, "Jason Vai para o Inferno: A Última Sexta-Feira", "1993") == (None, None)


def test_organizar_serie_padrao_polly_pocket_e_desfazer(tmp_path, home):
    from mediaserver import organizador
    raiz = tmp_path / "disco" / "Media Server"
    serie = raiz / "tv shows" / "polly.pocket.2018.1080p"
    _arq(serie / "Temporada 1" / "Polly Pocket - T1 - Ep 01.mp4")
    _arq(serie / "Temporada 1" / "Polly Pocket - T1 - Ep 01.srt")
    _arq(serie / "Temporada 1" / "Polly Pocket - T1 - Ep 02.mp4")
    _arq(serie / "poster.jpg")
    _arq(serie / "Temporada 1" / "Polly Pocket - T1 - Ep 07.mp4")   # sem episodio no TMDB
    src, err = sources.add_source("Disco serie", str(raiz.parent))
    assert not err, err
    logico = src["mount"] + "/tv shows/polly.pocket.2018.1080p"
    conn = db.get_db()
    conn.execute("INSERT INTO movie_meta (folder_path, title, year) VALUES (?,?,?)",
                 (logico, "Polly Pocket", "2018"))
    for e, t in ((1, "Tiny Power (1)"), (2, "Tiny Power (2)")):
        conn.execute("INSERT INTO episodios_meta (serie_path, season, episode, title, plot) "
                     "VALUES (?,?,?,?,?)", (logico, 1, e, t, "Sinopse"))
    conn.execute("INSERT INTO watch_progress (profile_id, folder_path, position_seconds, "
                 "duration_seconds, updated_at) VALUES ('', ?, 30, 100, 1)",
                 (logico + "/Temporada 1/Polly Pocket - T1 - Ep 01.mp4",))
    conn.commit()
    conn.close()
    novo, aviso = organizador.organizar_serie(logico)
    assert aviso is None and novo == src["mount"] + "/tv shows/Polly Pocket (2018)"
    destino = raiz / "tv shows" / "Polly Pocket (2018)"
    assert sorted(p.name for p in (destino / "Season 1").iterdir()) == sorted([
        "S01E01 - Tiny Power (1).mp4", "S01E01 - Tiny Power (1).srt", "S01E01 - Tiny Power (1).nfo",
        "S01E02 - Tiny Power (2).mp4", "S01E02 - Tiny Power (2).nfo",
        "S01E07.mp4", "S01E07.nfo"])
    assert "<season>1</season>" in (destino / "Season 1" / "S01E02 - Tiny Power (2).nfo").read_text(encoding="utf-8")
    assert not (serie).exists() and (destino / "poster.jpg").exists()
    conn = db.get_db()
    prog = conn.execute("SELECT folder_path FROM watch_progress").fetchone()["folder_path"]
    n_eps = conn.execute("SELECT COUNT(*) c FROM episodios_meta WHERE serie_path=?", (novo,)).fetchone()["c"]
    conn.close()
    assert prog == novo + "/Season 1/S01E01 - Tiny Power (1).mp4" and n_eps == 2
    # de novo: nada a fazer
    assert organizador.organizar_serie(novo) == (None, None)
    # desfazer volta tudo
    op = organizador.historico()[0]["id"]
    assert organizador.desfazer(op) == (True, None)
    assert (serie / "Temporada 1" / "Polly Pocket - T1 - Ep 01.mp4").exists()
    assert (serie / "Temporada 1" / "Polly Pocket - T1 - Ep 01.srt").exists()
    assert not (serie / "Season 1").exists()
    conn = db.get_db()
    prog = conn.execute("SELECT folder_path FROM watch_progress").fetchone()["folder_path"]
    conn.close()
    assert prog == logico + "/Temporada 1/Polly Pocket - T1 - Ep 01.mp4"


def test_nfo_de_serie_e_episodio_sao_lidos_de_volta():
    from mediaserver import scraper, nfo
    xml = scraper._construir_nfo_xml({"title": "Polly Pocket", "year": "2018", "plot": "P",
                                       "genres": ["Kids"], "_tmdb_id": 89095}, "tvshow")
    assert xml.startswith("<tvshow>") and "<tmdbid>89095</tmdbid>" in xml
    assert nfo._parse_nfo(xml)["title"] == "Polly Pocket"
    ep = scraper.construir_episodio_nfo("Polly Pocket", {"season": 1, "episode": 2, "title": "A & B"})
    assert "<episodedetails>" in ep and "A &amp; B" in ep and "thumb" not in ep


def test_fila_de_downloads_do_cache_offline(home):
    import time
    from unittest import mock
    from mediaserver import cachefila, rclone
    baixados = []
    with mock.patch.object(cachefila, "_baixar", side_effect=lambda it: baixados.append(it["path"])):
        n, b = cachefila.adicionar([("/Media Server/movies/A/a.mkv", 100, "A", ""),
                                    ("/Media Server/movies/A/a.mkv", 100, "A", ""),      # repetido
                                    ("/Media Server/tv shows/S/Season 1/e1.mkv", 50, "e1", "S · Season 1")])
        assert (n, b) == (2, 150)
        for _ in range(50):
            if cachefila.estado()["ativos"] == 0:
                break
            time.sleep(0.05)
    est = cachefila.estado()
    assert baixados == ["Media Server/movies/A/a.mkv", "Media Server/tv shows/S/Season 1/e1.mkv"]
    assert est["feitos"] == 2 and est["erros"] == 0
    # cancelar tira da fila o que ainda nao comecou
    with mock.patch.object(cachefila, "_trabalhar"):
        cachefila.adicionar([("/x/y/z.mkv", 10, "z", "")])
        assert cachefila.cancelar("/x/y/z.mkv") == 1
    assert [i["status"] for i in cachefila.estado()["itens"] if i["path"] == "x/y/z.mkv"] == ["cancelled"]
