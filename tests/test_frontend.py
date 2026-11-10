"""escHtml (static/app/*.js): precisa escapar aspas (e usado dentro de atributos)."""
import re
import shutil
import subprocess
from pathlib import Path

import pytest

APP_DIR = Path(__file__).resolve().parent.parent / "static" / "app"
PARTES = sorted(APP_DIR.glob("*.js"))


@pytest.mark.skipif(shutil.which("node") is None, reason="node nao instalado")
@pytest.mark.parametrize("entrada,esperado", [
    ('x" onload="alert(1)', "x&quot; onload=&quot;alert(1)"),
    ("<img src=x onerror=1>", "&lt;img src=x onerror=1&gt;"),
    ("Tom & Jerry", "Tom &amp; Jerry"),
    ("It's", "It&#39;s"),
])
def test_esc_html(entrada, esperado):
    src = "".join(p.read_text(encoding="utf-8") for p in PARTES)
    fn = re.search(r"function escHtml\(str\) \{.*?\n  \}", src, re.S).group(0)
    js = fn + "\nconsole.log(escHtml(process.argv[1]));"
    out = subprocess.run(["node", "-e", js, "--", entrada], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == esperado


@pytest.mark.skipif(shutil.which("node") is None, reason="node nao instalado")
@pytest.mark.parametrize("parte", PARTES, ids=lambda p: p.name)
def test_cada_parte_do_app_tem_sintaxe_valida(parte):
    subprocess.run(["node", "--check", str(parte)], check=True)
