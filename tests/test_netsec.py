"""Host, Origin e limite de tentativas."""
import pytest

from mediaserver import netsec


@pytest.mark.parametrize("host,ok", [
    ("localhost:9187", True), ("192.168.0.10:9187", True), ("[::1]:9187", True),
    ("meuservidor.local", True), ("evil.com", False), ("fc-evil.com", False), ("8.8.8.8:9187", False),
])
def test_host_allowed(host, ok):
    assert netsec.host_allowed(host) is ok


PORTAS = [9187, 9443]


@pytest.mark.parametrize("origin,host,ok", [
    ("http://localhost:9187", "localhost:9187", True),
    ("https://localhost:9443", "localhost:9187", True),     # HTTPS do proprio servidor
    ("http://localhost:3000", "localhost:9187", False),     # outro app na mesma maquina
    ("http://192.168.0.5:9187", "localhost:9187", False),   # outro host da rede
    ("null", "localhost:9187", False),
    (None, "localhost:9187", True),                         # curl / cliente nativo
])
def test_origin_mesmo_servidor(origin, host, ok):
    assert netsec.origin_mesmo_servidor(origin, host, PORTAS) is ok
