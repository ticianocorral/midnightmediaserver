"""App de Android TV: nao ha como compilar o Kotlin na CI, entao estes testes so travam, no texto,
as protecoes que a auditoria exigiu (se alguem remover, o teste avisa)."""
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent / "tv" / "app" / "src" / "main"


def test_webview_so_navega_dentro_do_servidor_escolhido():
    kt = (RAIZ / "java" / "com" / "mediaserver" / "tv" / "MainActivity.kt").read_text(encoding="utf-8")
    assert "override fun shouldOverrideUrlLoading" in kt and "mesmaOrigemDoServidor" in kt
    # a ponte so existe na MainActivity; sem a restricao, qualquer pagina carregada a enxerga
    assert 'addJavascriptInterface(Ponte(), "MediaServerTV")' in kt


def test_backup_do_android_desligado_para_nao_vazar_a_sessao():
    assert 'android:allowBackup="false"' in (RAIZ / "AndroidManifest.xml").read_text(encoding="utf-8")


def test_atividade_do_player_nao_e_exportada():
    xml = (RAIZ / "AndroidManifest.xml").read_text(encoding="utf-8")
    assert xml.count('android:exported="true"') == 1        # so a tela inicial (MAIN/LEANBACK)
