"""Limite de tentativas de PIN por perfil, mesmo trocando de IP."""
from unittest import mock

from mediaserver import handler


def test_pin_bloqueia_por_perfil_mesmo_trocando_de_ip(admin):
    admin.post("/api/profiles/save", {"id": "", "name": "ComPin", "avatar": "a03", "role": "user"})
    pid = next(p["id"] for p in admin.get("/api/profiles").json["profiles"] if p["name"] == "ComPin")
    assert admin.post("/api/profiles/pin", {"id": pid, "pin": "4821"}).status == 200
    # O IP real vem do socket; aqui o teste faz cada requisicao "chegar" de um IP
    # diferente (o que um atacante com IPv6 temporario faz) lendo um header.
    def ip_do_header(self):
        return self.headers.get("X-Test-IP", "127.0.0.1")

    with mock.patch.object(handler.MediaServerHandler, "_client_ip", ip_do_header):
        codigos = [admin.post("/api/profiles/select", {"id": pid, "pin": "000%d" % n},
                              headers={"X-Test-IP": "10.0.0.%d" % n}).status for n in range(1, 9)]
        assert codigos == [401] * 8
        # PIN certo, de um IP novo, depois de 8 erros: continua bloqueado
        assert admin.post("/api/profiles/select", {"id": pid, "pin": "4821"},
                          headers={"X-Test-IP": "10.0.0.99"}).status == 429
