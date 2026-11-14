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


def test_substituir_arquivos_guarda_o_nfo_antigo(tmp_path):
    from mediaserver import scraper
    pasta = tmp_path / "Filme (2000)"
    _arq(pasta / "Filme (2000).nfo", b"<movie><title>Velho</title></movie>")
    _arq(pasta / "Filme (2000).mkv")
    meta = {"title": "Novo", "year": "2000", "genres": [], "actors": [], "directors": [],
            "writers": [], "studios": [], "country": [], "tags": []}
    assert scraper.substituir_arquivos(pasta, meta)
    assert "Novo" in (pasta / "Filme (2000).nfo").read_text(encoding="utf-8")
    assert "Velho" in (pasta / "Filme (2000).nfo.anterior").read_text(encoding="utf-8")
