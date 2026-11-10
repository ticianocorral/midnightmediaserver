"""Leitura do catalogo: filmes, series, generos, colecoes e progresso.

Metodos _get_<caminho> chamados pela tabela de rotas do MediaServerHandler (handler.py).
"""

from ..db import (
    partir_caminho,
    get_db,
    perfil_atual,
)
from .. import sources as _sources
from .. import branding as _branding
from ..nfo import _titulos_nfo_de_pastas
from ..queries import (
    cached_list_directory,
    cached_movie_detail,
    cached_search_files,
    cached_all_movies,
    cached_all_collections,
    cached_collection_movies,
    cached_generos,
    cached_generos_de,
    cached_genero_filmes,
    cached_movie_infantil,
    cached_serie,
    cached_series_list,
    _posters_de_pastas,
)


class CatalogoRotas:
    """Leitura do catalogo: filmes, series, generos, colecoes e progresso."""

    # API: List genres with content (from cache)
    def _get_api_genres(self, path, params):
        """GET /api/genres"""
        wanted = params.get("source", [""])[0].strip()
        conn = get_db()
        genre_rows = conn.execute(
            "SELECT * FROM folders WHERE 0 ORDER BY name"
        ).fetchall()
        conn.close()

        all_sources = _sources.list_sources()
        folders = []
        for row in genre_rows:
            owner = _sources.resolve(row["path"])
            source_id = owner["id"] if owner else ""
            if wanted and source_id != wanted:
                continue
            folders.append({
                "Path": row["path"].lstrip("/"),
                "Name": row["name"],
                "Size": 0,
                "MimeType": "inode/directory",
                "ModTime": "",
                "IsDir": True,
                "has_video": True,
                "source": source_id,
            })
        data = {
            "path": _branding.logical_root(),
            "folders": folders,
            # A home monta uma secao por fonte a partir daqui, numa
            # requisicao so — por isso as fontes vem junto dos generos.
            "sources": [
                {"id": s["id"], "kind": s["kind"], "name": s["name"],
                 "online": _sources.is_online(s)}
                for s in all_sources
                if not wanted or s["id"] == wanted
            ],
            # Gêneros criados na interface — a barra lateral lista depois
            # dos gêneros de pasta. Filtrado como todo o resto: sessão
            # infantil não vê (nem de nome) gênero sem filme marcado.
            "app": cached_generos(so_infantil=self._so_infantil()),
            "videos": [],
            "subtitles": [],
            "images": [],
        }
        self._send_json(data)
        return

    # API: Recent movies sorted by creation time (from cache)
    def _get_api_recent_movies(self, path, params):
        """GET /api/recent-movies"""
        conn = get_db()
        limit = 50
        try:
            limit = min(int(params.get("limit", ["50"])[0]), 200)
        except (ValueError, IndexError):
            pass
        filtro_inf = ""
        if self._so_infantil():
            filtro_inf = (" AND EXISTS (SELECT 1 FROM infantil_filmes ii "
                          "WHERE ii.alvo = folders.path)")
        movie_rows = conn.execute(
            f"""SELECT * FROM folders
               WHERE has_video=1 AND depth>0
                 AND tipo IN ('filme', 'serie'){filtro_inf}
               ORDER BY mod_time DESC, name ASC
               LIMIT ?""",
            (limit,)
        ).fetchall()
        # Pôster e título em lote (antes: uma conexão por filme da home).
        posters = _posters_de_pastas(conn, [r["path"] for r in movie_rows])
        titulos = _titulos_nfo_de_pastas(conn, [r["path"] for r in movie_rows])
        assistidos = {r["folder_path"] for r in conn.execute(
            "SELECT folder_path FROM watch_progress "
            "WHERE profile_id=? AND position_seconds <= 0",
            (perfil_atual(),)).fetchall()}
        conn.close()

        movies = []
        for row in movie_rows:
            movie_path = row["path"]
            movies.append({
                "path": movie_path,
                "name": row["name"],
                "mod_time": row["mod_time"],
                "poster": posters.get(movie_path),
                "is_serie": row["tipo"] == "serie",
                "title": titulos.get(movie_path) or None,
                "watched": movie_path in assistidos,
            })
        self._send_json(movies)
        return

    # API: Continue watching — movies with saved progress
    def _get_api_continue_watching(self, path, params):
        """GET /api/continue-watching"""
        conn = get_db()
        rows = conn.execute(
            """SELECT p.*, f.name FROM watch_progress p
               LEFT JOIN folders f ON f.path = p.folder_path
               WHERE p.profile_id = ? AND p.position_seconds > 0
               ORDER BY p.updated_at DESC
               LIMIT 20""",
            (perfil_atual(),)
        ).fetchall()
        # Pôster e título de filme em lote, na mesma conexão do laço.
        posters = _posters_de_pastas(conn, [r["folder_path"] for r in rows])
        titulos = _titulos_nfo_de_pastas(conn, [r["folder_path"] for r in rows])
        result = []
        so_infantil = self._so_infantil()

        def _titulo_limpo(nome_arquivo):
            base = nome_arquivo.rsplit(".", 1)[0]
            for sep in (".", "_"):
                base = base.replace(sep, " ")
            return base.strip()

        for row in rows:
            p_path = row["folder_path"]
            # Perfil infantil: a home nao mostra progresso de fora do
            # perfil (mesma regra que o /api/stream aplica pra tocar).
            if so_infantil and not self._permitido_infantil(p_path):
                continue
            pasta = conn.execute(
                "SELECT path, name, tipo, parent FROM folders WHERE path=?",
                (p_path,)).fetchone()

            if pasta and pasta["tipo"] == "filme":
                # Filme em pasta: poster card, como sempre.
                result.append({
                    "tipo": "filme", "path": p_path,
                    "name": row["name"] or p_path.strip("/").split("/")[-1],
                    "position": row["position_seconds"],
                    "duration": row["duration_seconds"],
                    "poster": posters.get(p_path),
                    "title": titulos.get(p_path) or None,
                })
                continue

            # Sem pasta de filme: o progresso é de um ARQUIVO — episódio
            # de série ou filme solto. Ambos viram linha na home.
            fi = conn.execute(
                """SELECT name, folder_path FROM files
                   WHERE folder_path = ? AND name = ?
                   AND file_type = 'video'""", partir_caminho(p_path)).fetchone()
            if not fi:
                continue  # progresso órfão (arquivo saiu do acervo)
            titulo = _titulo_limpo(fi["name"])
            pasta_row = conn.execute(
                "SELECT name, tipo, parent FROM folders WHERE path=?",
                (fi["folder_path"],)).fetchone()
            legenda = conn.execute(
                """SELECT folder_path || '/' || name AS arquivo FROM files
                   WHERE folder_path=? AND name LIKE ?
                   AND file_type='subtitle' LIMIT 1""",
                (fi["folder_path"], fi["name"].rsplit(".", 1)[0] + "%")
            ).fetchone()
            if pasta_row and pasta_row["tipo"] == "temporada":
                serie_row = conn.execute(
                    "SELECT name FROM folders WHERE path=?",
                    (pasta_row["parent"],)).fetchone()
                serie_meta = conn.execute(
                    "SELECT title FROM movie_meta WHERE folder_path=?",
                    (pasta_row["parent"],)).fetchone()
                result.append({
                    "tipo": "episodio", "path": p_path,
                    "serie": (serie_meta["title"] if serie_meta and serie_meta["title"]
                              else serie_row["name"]),
                    "temporada": pasta_row["name"],
                    "episodio": titulo,
                    "position": row["position_seconds"],
                    "duration": row["duration_seconds"],
                    "subtitle": legenda["arquivo"] if legenda else None,
                })
            else:
                result.append({
                    "tipo": "solto", "path": p_path,
                    "name": titulo,
                    "position": row["position_seconds"],
                    "duration": row["duration_seconds"],
                })
        conn.close()
        self._send_json(result)
        return

    # API: Get progress for a single movie
    def _get_api_progress(self, path, params):
        """GET /api/progress"""
        folder_path = params.get("path", [""])[0]
        if not folder_path:
            self._send_json({"position": 0, "duration": 0})
            return
        conn = get_db()
        row = conn.execute(
            "SELECT * FROM watch_progress WHERE profile_id=? AND folder_path=?",
            (perfil_atual(), folder_path)
        ).fetchone()
        conn.close()
        if row:
            self._send_json({
                "position": row["position_seconds"],
                "duration": row["duration_seconds"],
                # Linha zerada = marcado como assistido (mesma convencao
                # do interruptor da ficha). Sem linha = nunca visto.
                "watched": row["position_seconds"] <= 0,
            })
        else:
            self._send_json({"position": 0, "duration": 0, "watched": False})
        return

    # API: List directory (from cache)
    def _get_api_list(self, path, params):
        """GET /api/list"""
        dir_path = params.get("path", [""])[0]

        # Raiz -> raiz do remote, sem depender do nome fixo em texto.
        if dir_path == "" or dir_path == "/":
            dir_path = _branding.logical_root()

        data = cached_list_directory(dir_path, so_infantil=self._so_infantil())
        if data is None:
            self._send_error("Path not found in cache", 404)
            return

        # Ensure empty lists for missing keys
        data.setdefault("folders", [])
        data.setdefault("videos", [])
        data.setdefault("subtitles", [])
        data.setdefault("images", [])

        # No auto-scan — user must click refresh manually
        # If cache is empty, just show whatever we have (will be empty)

        self._send_json(data)
        return

    # API: Colecoes (Star Wars 1-6 e afins)
    def _get_api_collections(self, path, params):
        """GET /api/collections"""
        self._send_json(cached_all_collections(so_infantil=self._so_infantil()))
        return

    def _get_api_collection(self, path, params):
        """GET /api/collection"""
        key = params.get("key", [""])[0] or params.get("name", [""])[0]
        if not key:
            self._send_error("Missing 'key' parameter", 400)
            return
        data = cached_collection_movies(key, so_infantil=self._so_infantil())
        if data is None:
            self._send_error("Colecao nao encontrada", 404)
            return
        self._send_json(data)
        return

    # Gêneros do app (criados na interface, independentes de pasta).
    def _get_api_generos(self, path, params):
        """GET /api/generos"""
        self._send_json(cached_generos(so_infantil=self._so_infantil()))
        return

    def _get_api_genero(self, path, params):
        """GET /api/genero"""
        try:
            gid = int(params.get("id", [""])[0])
        except ValueError:
            self._send_error("Missing 'id' parameter", 400)
            return
        data = cached_genero_filmes(gid, so_infantil=self._so_infantil())
        if data is None:
            self._send_error("Genero nao encontrado", 404)
            return
        self._send_json(data)
        return

    def _get_api_generos_de(self, path, params):
        """GET /api/generos/de"""
        alvo = params.get("alvo", [""])[0]
        if not alvo:
            self._send_error("Missing 'alvo' parameter", 400)
            return
        self._send_json({"ids": cached_generos_de(alvo)})
        return

    # Interruptor "Já assisti" da ficha do filme.
    def _get_api_watched(self, path, params):
        """GET /api/watched"""
        self._handle_watched()
        return

    # API: Movie detail (from cache)
    # API: Lista de séries (listagem própria, separada dos filmes)
    def _get_api_series(self, path, params):
        """GET /api/series"""
        self._send_json(cached_series_list(so_infantil=self._so_infantil()))
        return

    # API: Uma série (temporadas + episódios)
    def _get_api_serie(self, path, params):
        """GET /api/serie"""
        serie_path = params.get("path", [""])[0]
        if not serie_path:
            self._send_error("Missing 'path' parameter", 400)
            return
        data = cached_serie(serie_path, so_infantil=self._so_infantil())
        if data is None:
            self._send_error("Serie nao encontrada", 404)
            return
        self._send_json(data)
        return

    def _get_api_movie_detail(self, path, params):
        """GET /api/movie-detail"""
        folder_path = params.get("path", [""])[0]
        if not folder_path:
            self._send_error("Missing 'path' parameter", 400)
            return

        if self._so_infantil() and not cached_movie_infantil(folder_path):
            self._send_error("Filme não disponível neste perfil", 404)
            return
        data = cached_movie_detail(folder_path)
        self._send_json(data)
        return

    # API: Search (from cache)
    def _get_api_search(self, path, params):
        """GET /api/search"""
        query = params.get("q", [""])[0]
        if not query:
            self._send_error("Missing 'q' parameter", 400)
            return
        results = cached_search_files(query, so_infantil=self._so_infantil())
        self._send_json({"results": results})
        return

    # API: All movies A-Z (from cache)
    def _get_api_all_movies(self, path, params):
        """GET /api/all-movies"""
        results = cached_all_movies(so_infantil=self._so_infantil())
        self._send_json(results)
        return
