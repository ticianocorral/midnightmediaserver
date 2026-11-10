"""rc_remote e a chave de cache: o que impedia ler arquivos fora do acervo."""
import pytest

from mediaserver import branding, handler, paths

RAIZ = branding.logical_root()


@pytest.fixture
def sem_nuvem(monkeypatch):
    monkeypatch.setattr(paths, "_nuvem_cache", ("", ""))


@pytest.fixture
def com_nuvem(monkeypatch):
    monkeypatch.setattr(paths, "_nuvem_cache", ("b2", "acervo"))


@pytest.mark.parametrize("p", ["/local:/etc/passwd", ":local:/etc/passwd", RAIZ + "/A/x.mkv"])
def test_sem_nuvem_recusa_qualquer_caminho(sem_nuvem, p):
    # Sem remote o destino virava ":<path>", que o rclone le como ':local:/...'
    with pytest.raises(paths.CaminhoInvalido):
        paths.rc_remote(p)


def test_com_nuvem_caminho_normal_passa(com_nuvem):
    assert paths.rc_remote(RAIZ + "/Acao/Filme: Parte 2/x.mkv") == "b2:acervo/Acao/Filme: Parte 2/x.mkv"


@pytest.mark.parametrize("p", [RAIZ + "/../../etc/passwd", RAIZ + "/A/..\\..\\x", RAIZ + "/a/./b"])
def test_com_nuvem_recusa_dot_dot(com_nuvem, p):
    with pytest.raises(paths.CaminhoInvalido):
        paths.rc_remote(p)


@pytest.mark.parametrize("p", ["x\\..\\..\\auth.json", "a/b/../c.srt", "/Filme/poster.jpg"])
def test_chave_de_cache_nao_tem_separador(p):
    k = handler._chave_de_cache("sub", p)
    assert "/" not in k and "\\" not in k and ".." not in k


def test_chave_de_cache_mantem_extensao_e_e_estavel():
    assert handler._chave_de_cache("img", "/F/poster.jpg").endswith(".jpg")
    assert handler._chave_de_cache("img", "/F/a") == handler._chave_de_cache("img", "/F/a")
    assert handler._chave_de_cache("img", "/F/a") != handler._chave_de_cache("img", "/F/b")
