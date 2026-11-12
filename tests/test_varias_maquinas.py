"""Dois servidores na mesma rede: nada de um pisar no outro."""
from mediaserver import handler, netutil


def test_nome_da_maquina_e_seguro_para_nome_de_arquivo():
    nome = netutil.nome_da_maquina()
    assert nome and all(c.isalnum() or c == "-" for c in nome)


def test_backup_restaura_so_o_desta_maquina_ou_o_antigo():
    f = handler._backup_e_desta_maquina
    eu = netutil.nome_da_maquina()
    assert f("media-server-backup-2026-01-02.zip")                  # formato antigo
    assert f("media-server-backup-%s-2026-01-02.zip" % eu)
    assert not f("media-server-backup-outro-pc-2026-01-02.zip")     # de outro computador
    assert not f("media-server-backup-%s-x-2026-01-02.zip" % eu)
    assert not f("qualquer-coisa.zip") and not f("media-server-backup-2026-01-02.db")


def test_status_publico_informa_o_nome_da_maquina(servidor):
    from conftest import Cliente
    r = Cliente(*servidor).get("/api/auth/status")
    assert r.json["machine"] == netutil.nome_da_maquina()
