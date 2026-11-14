"""Rotas de administracao: scraper, organizador, marca, fontes, nuvem e colecoes.

Metodos _get_<caminho> chamados pela tabela de rotas do MediaServerHandler (handler.py).
"""

from .. import scraper as _scraper
from .. import organizador as _organizador
from .. import branding as _branding
from .. import sources as _sources


class AdminRotas:
    """Rotas de administracao: scraper, organizador, marca, fontes, nuvem e colecoes."""

    def _get_api_scrape_status(self, path, params):
        """GET /api/scrape/status"""
        _, total = _scraper.listar_pendentes(limite=1)
        self._send_json({"configurado": _scraper.configurado(), "pendentes": total})
        return

    def _get_api_scrape_pendentes(self, path, params):
        """GET /api/scrape/pendentes"""
        pendentes, total = _scraper.listar_pendentes()
        self._send_json({"pendentes": pendentes, "total": total})
        return

    def _get_api_scrape_search(self, path, params):
        """GET /api/scrape/search"""
        folder_path = params.get("path", [""])[0]
        query = params.get("q", [""])[0].strip() or None
        if not folder_path:
            self._send_error("Missing 'path' parameter", 400)
            return
        nome_pasta = folder_path.rstrip("/").rsplit("/", 1)[-1]
        candidatos, erro = _scraper.buscar_candidatos(
            nome_pasta, query, self._tipo_da_pasta(folder_path),
            params.get("idioma", [""])[0])
        self._send_json({"candidatos": candidatos, "erro": erro})
        return

    def _get_api_scrape_preview(self, path, params):
        """GET /api/scrape/preview — o metadado que SERIA gravado, sem gravar nada."""
        folder_path = params.get("path", [""])[0]
        try:
            tmdb_id = int(params.get("tmdb_id", ["0"])[0])
        except ValueError:
            tmdb_id = 0
        if not folder_path or not tmdb_id:
            self._send_error("Missing 'path' or 'tmdb_id'", 400)
            return
        idioma = params.get("idioma", [""])[0]
        if self._tipo_da_pasta(folder_path) == "serie":
            dados, erro = _scraper.detalhes_serie(tmdb_id, idioma)
            meta = _scraper.para_serie_meta(dados) if dados else None
        else:
            dados, erro = _scraper.detalhes(tmdb_id, idioma)
            meta = _scraper.para_movie_meta(dados) if dados else None
        if meta:
            poster = meta.pop("_poster_path", None)
            meta["poster_path"] = poster
            meta["poster"] = ("https://image.tmdb.org/t/p/w185" + poster) if poster else None
            meta.pop("video_info", None)
            meta.pop("audio_info", None)
        self._send_json({"meta": meta, "erro": erro, "local": _sources.is_local(folder_path),
                         "serie": self._tipo_da_pasta(folder_path) == "serie"})
        return

    def _get_api_scrape_capas(self, path, params):
        """GET /api/scrape/capas"""
        try:
            tmdb_id = int(params.get("tmdb_id", ["0"])[0])
        except ValueError:
            tmdb_id = 0
        folder_path = params.get("path", [""])[0]
        tipo = self._tipo_da_pasta(folder_path) if folder_path else "filme"
        capas, erro = (_scraper.listar_capas(tmdb_id, tipo, params.get("idioma", [""])[0])
                       if tmdb_id else ([], "Filme não informado."))
        self._send_json({"capas": capas, "erro": erro})
        return

    def _get_api_organizar_itens(self, path, params):
        """GET /api/organizar/itens"""
        itens, erro = _organizador.listar_itens(params.get("source", [""])[0])
        self._send_json({"itens": itens or [], "erro": erro})
        return

    def _get_api_organizar_buscar(self, path, params):
        """GET /api/organizar/buscar"""
        cands, erro = _organizador.buscar(
            params.get("source", [""])[0], params.get("origem", [""])[0],
            params.get("q", [""])[0].strip() or None, params.get("idioma", [""])[0])
        self._send_json({"candidatos": cands, "erro": erro})
        return

    def _get_api_organizar_historico(self, path, params):
        """GET /api/organizar/historico"""
        self._send_json({"operacoes": _organizador.historico()})
        return

    # API: Marca atual (nome e cor) — admin, ver Ajustes > Aparencia
    def _get_api_branding(self, path, params):
        """GET /api/branding"""
        self._send_json(_branding.get())
        return

    def _get_api_branding_set(self, path, params):
        """GET /api/branding/set"""
        self._handle_branding_set()
        return

    # API: Fontes do catalogo
    def _get_api_sources(self, path, params):
        """GET /api/sources"""
        self._handle_sources_list()
        return

    def _get_api_sources_detect(self, path, params):
        """GET /api/sources/detect"""
        self._handle_sources_detect()
        return

    def _get_api_sources_browse(self, path, params):
        """GET /api/sources/browse"""
        r = _sources.browse(params.get("path", [""])[0])
        self._send_json(r, 400 if "erro" in r else 200)
        return

    def _get_api_sources_add(self, path, params):
        """GET /api/sources/add"""
        self._handle_source_add()
        return

    def _get_api_sources_remove(self, path, params):
        """GET /api/sources/remove"""
        self._handle_source_remove()
        return

    # Nuvem (qualquer remote rclone, via wizard)
    def _get_api_nuvem_status(self, path, params):
        """GET /api/nuvem/status"""
        self._handle_nuvem_status()
        return

    def _get_api_nuvem_conectar(self, path, params):
        """GET /api/nuvem/conectar"""
        self._handle_nuvem_conectar()
        return

    def _get_api_nuvem_desconectar(self, path, params):
        """GET /api/nuvem/desconectar"""
        self._handle_nuvem_desconectar()
        return

    def _get_api_rclone_remotes(self, path, params):
        """GET /api/rclone/remotes"""
        self._handle_rclone_remotes()
        return

    def _get_api_rclone_providers(self, path, params):
        """GET /api/rclone/providers"""
        self._handle_rclone_providers()
        return

    def _get_api_rclone_wizard(self, path, params):
        """GET /api/rclone/wizard"""
        self._handle_rclone_wizard()
        return

    # Coleções do app: criar, editar e excluir (admin).
    def _get_api_infantil_marcar(self, path, params):
        """GET /api/infantil/marcar"""
        self._handle_infantil_marcar()
        return

    def _get_api_colecoes_create(self, path, params):
        """GET /api/colecoes/create"""
        self._handle_colecao_create()
        return

    def _get_api_colecoes_update(self, path, params):
        """GET /api/colecoes/update"""
        self._handle_colecao_update()
        return

    def _get_api_colecoes_delete(self, path, params):
        """GET /api/colecoes/delete"""
        self._handle_colecao_delete()
        return

    # Tags do app: criar, excluir e atribuir (admin).
    def _get_api_generos_create(self, path, params):
        """GET /api/generos/create"""
        self._handle_genero_create()
        return

    def _get_api_generos_delete(self, path, params):
        """GET /api/generos/delete"""
        self._handle_genero_delete()
        return

    def _get_api_generos_atribuir(self, path, params):
        """GET /api/generos/atribuir"""
        self._handle_genero_atribuir()
        return

    def _get_api_generos_renomear(self, path, params):
        """GET /api/generos/renomear"""
        self._handle_genero_renomear()
        return
