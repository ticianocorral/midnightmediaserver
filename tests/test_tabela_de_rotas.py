"""Tabela de rotas GET: toda entrada aponta para um metodo real e sem duplicata."""
import inspect

from mediaserver import handler

H = handler.MediaServerHandler


def test_cada_rota_aponta_para_um_metodo_existente():
    for tabela in (H._ROTAS_GET_ANTES, H._ROTAS_GET):
        for rota, nome in tabela.items():
            metodo = getattr(H, nome, None)
            assert callable(metodo), (rota, nome)
            assert list(inspect.signature(metodo).parameters) == ["self", "path", "params"], nome


def test_rota_nao_aparece_nas_duas_tabelas():
    assert not set(H._ROTAS_GET_ANTES) & set(H._ROTAS_GET)


def test_subtitle_continua_no_do_get_depois_do_bloco_do_perfil_infantil():
    # a regra do perfil infantil precisa vir ANTES da rota: fora da tabela de proposito
    assert "/api/subtitle" not in H._ROTAS_GET and "/api/subtitle" not in H._ROTAS_GET_ANTES
    src = inspect.getsource(H.do_GET)
    assert src.index("_so_infantil()") < src.index('path == "/api/subtitle":')


def test_do_get_ficou_pequeno():
    # era uma funcao de 1.062 linhas; nao deixe voltar a crescer
    assert len(inspect.getsource(H.do_GET).splitlines()) < 150
