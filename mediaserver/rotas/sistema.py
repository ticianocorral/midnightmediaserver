"""Perfis, manifest PWA, marca e certificado da CA.

Metodos _get_<caminho> chamados pela tabela de rotas do MediaServerHandler (handler.py).
"""

from ..templates import _profiles_page
from ..netutil import mkcert_root_ca_path
from ..rclone import get_rclone_status
from .. import branding as _branding
from ..queries import cached_get_file_info


class SistemaRotas:
    """Perfis, manifest PWA, marca e certificado da CA."""

    def _get_api_profiles(self, path, params):
        """GET /api/profiles"""
        self._handle_profiles_list()
        return

    def _get_perfis(self, path, params):
        """GET /perfis"""
        self._send_html(_profiles_page())
        return

    # Marca: manifest, CSS de cor e icones gerados na hora, na cor e nome
    # escolhidos. Publicos (ver PUBLIC_PATHS) porque o navegador os busca
    # fora da navegacao normal, sem cookie — inclusive antes do login.
    def _get_manifest_webmanifest(self, path, params):
        """GET /manifest.webmanifest"""
        payload = _branding.manifest_json().encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/manifest+json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(payload)
        return

    def _get_branding_css(self, path, params):
        """GET /branding.css"""
        payload = _branding.css().encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/css; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(payload)
        return

    # A CA local (mkcert) que assina o HTTPS do proprio app. Celular novo
    # baixa este arquivo pelo http:// (sem aviso de certificado) e
    # instala como certificado de CA — depois o https:// aparece como
    # seguro e o Chrome oferece "Instalar app". So o certificado publico
    # sai daqui; a chave da CA (rootCA-key.pem) nunca e servida.
    def _get_ca_crt(self, path, params):
        """GET /ca.crt"""
        ca = mkcert_root_ca_path()
        dados = None
        if ca is not None:
            try:
                dados = ca.read_bytes()
            except OSError:
                dados = None
        if not dados:
            self._send_error("Sem certificado local do mkcert para baixar", 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/x-x509-ca-cert")
        self.send_header("Content-Length", str(len(dados)))
        self.send_header("Content-Disposition",
                         'attachment; filename="media-server-ca.crt"')
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(dados)
        return

    # API: File info (from cache)
    def _get_api_info(self, path, params):
        """GET /api/info"""
        file_path = params.get("path", [""])[0]
        if not file_path:
            self._send_error("Missing 'path' parameter", 400)
            return
        item = cached_get_file_info(file_path)
        if item:
            self._send_json(item)
        else:
            self._send_error("File not found", 404)
        return

    # API: rclone status (instalação, remote da nuvem, streaming, web UI)
    def _get_api_rclone_status(self, path, params):
        """GET /api/rclone/status"""
        self._send_json(get_rclone_status())
        return
