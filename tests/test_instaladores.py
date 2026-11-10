"""install.sh e os instaladores de shell instalam a ULTIMA RELEASE, nao a branch main."""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parent.parent
SCRIPTS = ["install.sh", "Instalador-Media-Server-Linux.sh", "Instalador-Media-Server-macOS.command"]

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="bash nao instalado")


def _resolve(script, tmp_path, corpo_curl, ref_env=None):
    """Roda SO a funcao resolver_ref do script, com um `curl` falso no PATH."""
    shim = tmp_path / "bin"
    shim.mkdir()
    curl = shim / "curl"
    curl.write_text("#!/bin/sh\n" + corpo_curl + "\n")
    curl.chmod(0o755)
    env = {"PATH": "%s:%s" % (shim, os.environ["PATH"]), "HOME": str(tmp_path)}
    if ref_env:
        env["MEDIA_SERVER_REF"] = ref_env
    prog = ('REPO=ticianocorral/midnightmediaserver; REF=""; '
            'eval "$(sed -n "/^resolver_ref()/,/^}/p" %s)"; resolver_ref; echo "REF=$REF"' % (RAIZ / script))
    r = subprocess.run(["bash", "-c", prog], capture_output=True, text=True, env=env, timeout=20)
    return r.stdout.strip().splitlines()[-1], r.stderr


@pytest.mark.parametrize("script", SCRIPTS)
def test_usa_a_ultima_release(script, tmp_path):
    saida, _ = _resolve(script, tmp_path, 'echo \'{"tag_name": "v1.28.1", "name": "x"}\'')
    assert saida == "REF=v1.28.1"


@pytest.mark.parametrize("script", SCRIPTS)
@pytest.mark.parametrize("lixo", ['v1.2.3; rm -rf ~', 'main', '../../x', 'v1.2.3"; echo pwn; "', ''])
def test_tag_estranha_cai_na_main_sem_executar_nada(script, lixo, tmp_path):
    saida, err = _resolve(script, tmp_path, "echo '{\"tag_name\": \"%s\"}'" % lixo.replace("'", ""))
    # o que sai e SEMPRE uma tag valida ou a main, nunca o texto estranho; e nada foi executado
    assert saida in ("REF=main", "REF=v1.2.3"), saida
    assert "pwn" not in saida and "rm -rf" not in saida
    assert not (tmp_path / "pwn").exists()


@pytest.mark.parametrize("script", SCRIPTS)
def test_sem_rede_cai_na_main_avisando(script, tmp_path):
    saida, err = _resolve(script, tmp_path, "exit 22")
    assert saida == "REF=main" and "main" in err


@pytest.mark.parametrize("script", SCRIPTS)
def test_media_server_ref_do_usuario_manda(script, tmp_path):
    saida, _ = _resolve(script, tmp_path, "exit 22", ref_env="v1.20.0")
    assert saida == "REF=v1.20.0"


def test_tarball_de_tag_e_de_branch_usam_caminhos_diferentes():
    sh = (RAIZ / "install.sh").read_text(encoding="utf-8")
    assert "archive/refs/tags/${REF}.tar.gz" in sh and "archive/refs/heads/${REF}.tar.gz" in sh
    assert 'REF="${MEDIA_SERVER_REF:-main}"' not in sh          # o padrao deixou de ser a main
