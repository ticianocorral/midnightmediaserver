"""Filtro por genero do NFO: cada filme entra pelo 1o e 2o genero, sem misturar com tags."""
import json

import pytest

from mediaserver import db, queries


def test_so_os_dois_primeiros_generos_sem_repetir():
    g = queries.generos_principais(json.dumps(["Ação", "ação", "Aventura", "Drama"]))
    assert g == ["Ação", "Aventura"]


def test_genero_vazio_ou_invalido():
    assert queries.generos_principais("") == []
    assert queries.generos_principais("nao e json") == []
    assert queries.generos_principais(json.dumps({"a": 1})) == []
    assert queries.generos_principais(json.dumps(["  ", "Drama"])) == ["Drama"]


@pytest.fixture
def filmes(home):
    conn = db.get_db()
    dados = {
        "/Media Server/A": ["Ação", "Aventura", "Drama"],
        "/Media Server/B": ["Drama", "ação"],
        "/Media Server/C": ["Comédia"],
        "/Media Server/D": ["Terror", "Suspense", "Ação"],   # Ação so em 3o: nao conta
    }
    for path, gen in dados.items():
        conn.execute("INSERT OR REPLACE INTO folders (path,name,parent,depth,mod_time,has_video,tipo)"
                     " VALUES (?,?,?,?,?,1,'filme')", (path, path.split("/")[-1], "/Media Server", 2, ""))
        conn.execute("INSERT OR REPLACE INTO movie_meta (folder_path,title,genres,updated_at)"
                     " VALUES (?,?,?,0)", (path, "Filme " + path[-1], json.dumps(gen)))
    conn.commit()
    conn.close()
    yield
    conn = db.get_db()
    for path in dados:
        conn.execute("DELETE FROM folders WHERE path=?", (path,))
        conn.execute("DELETE FROM movie_meta WHERE folder_path=?", (path,))
    conn.commit()
    conn.close()


def test_contagem_por_genero_usa_so_os_dois_primeiros(filmes):
    cont = {g["nome"]: g["total"] for g in queries.cached_generos_nfo()}
    assert cont["Ação"] == 2          # A (1o) e B (2o); D tem Ação so em 3o
    assert cont["Drama"] == 1         # em A o Drama e o 3o: nao conta
    assert cont["Aventura"] == 1 and cont["Comédia"] == 1
    assert "Suspense" in cont and "Terror" in cont


def test_filmes_de_um_genero_ignora_maiusculas(filmes):
    r = queries.cached_genero_nfo_filmes("ação")
    assert [m["path"] for m in r["movies"]] == ["/Media Server/A", "/Media Server/B"]
    assert queries.cached_genero_nfo_filmes("Inexistente") is None


def test_rota_http(admin, filmes):
    r = admin.get("/api/generos-nfo")
    assert r.status == 200 and any(g["nome"] == "Drama" for g in r.json)
    assert admin.get("/api/genero-nfo?nome=Drama").json["name"] == "Drama"
    assert admin.get("/api/genero-nfo?nome=Nada").status == 404
