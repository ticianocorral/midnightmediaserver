"""Reproducao: stream, arquivo preparado para a TV e estado do preparo.

Metodos _get_<caminho> chamados pela tabela de rotas do MediaServerHandler (handler.py).
"""

from .. import prepare


class MidiaRotas:
    """Reproducao: stream, arquivo preparado para a TV e estado do preparo."""

    # API: Stream (live from rclone)
    def _get_api_stream(self, path, params):
        """GET /api/stream"""
        file_path = params.get("path", [""])[0]
        if not file_path:
            self._send_error("Missing 'path' parameter", 400)
            return
        if self._so_infantil() and not self._permitido_infantil(file_path):
            self._send_error("Filme não disponível neste perfil", 403)
            return
        self._stream_file(file_path)
        return

    # API: Video preparado para a TV (MP4/AAC gerado pelo prepare.py).
    # O token assinado e o do path original — ver prepare.py.
    def _get_api_prepared(self, path, params):
        """GET /api/prepared"""
        file_path = params.get("path", [""])[0]
        if not file_path:
            self._send_error("Missing 'path' parameter", 400)
            return
        if self._so_infantil() and not self._permitido_infantil(file_path):
            self._send_error("Filme não disponível neste perfil", 403)
            return
        self._serve_prepared(file_path)
        return

    # API: Progresso do preparo para a TV
    def _get_api_prepare_status(self, path, params):
        """GET /api/prepare-status"""
        file_path = params.get("path", [""])[0]
        if not file_path:
            self._send_error("Missing 'path' parameter", 400)
            return
        if self._so_infantil() and not self._permitido_infantil(file_path):
            self._send_error("Filme não disponível neste perfil", 403)
            return
        fonte = self._fonte_de(file_path)
        if fonte is None:
            self._send_json({"needed": False, "state": "none"})
            return
        self._send_json(prepare.status(fonte, enqueue=False))
        return
