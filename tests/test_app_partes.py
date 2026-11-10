"""O frontend (static/app/*.js) e um script classico dividido em partes que
compartilham o escopo global e rodam NA ORDEM do index.html. Estes testes
protegem a divisao: nada fora de ordem, nada faltando, e toda funcao chamada por
um handler inline (onclick=...) existe de verdade."""
import re
import shutil
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parent.parent
PARTES = sorted((RAIZ / "static" / "app").glob("*.js"))
INDEX = (RAIZ / "index.html").read_text(encoding="utf-8")


def test_index_carrega_todas_as_partes_na_ordem():
    carregadas = re.findall(r'<script src="/static/app/([^"]+)"></script>', INDEX)
    assert carregadas == [p.name for p in PARTES]
    assert PARTES[0].name.startswith("01-") and PARTES[-1].name.endswith("init.js")


def test_nao_sobrou_o_app_js_antigo():
    assert not (RAIZ / "static" / "app.js").exists()
    assert "/static/app.js" not in INDEX


def test_marcador_do_changelog_esta_onde_o_bump_version_procura():
    sh = (RAIZ / "bump-version.sh").read_text(encoding="utf-8")
    alvo = re.search(r'APPJS="\$DIR/(static/app/[^"]+)"', sh).group(1)
    assert "const _CHANGELOG = [\n" in (RAIZ / alvo).read_text(encoding="utf-8")
    wf = (RAIZ / ".github" / "workflows" / "version-bump.yml").read_text(encoding="utf-8")
    assert alvo in wf


def _declaradas():
    codigo = "\n".join(p.read_text(encoding="utf-8") for p in PARTES)
    nomes = set(re.findall(r"(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)", codigo))
    nomes |= set(re.findall(r"(?:^|\n)\s*(?:let|const|var)\s+([A-Za-z_$][\w$]*)", codigo))
    nomes |= set(re.findall(r"window\.([A-Za-z_$][\w$]*)\s*=", codigo))
    return nomes


def test_toda_funcao_chamada_por_handler_inline_existe():
    textos = INDEX + "\n" + "\n".join(p.read_text(encoding="utf-8") for p in PARTES)
    chamadas = set()
    for m in re.finditer(r'\son[a-z]+=(["\'])((?:(?!\1).|\\\1)*)\1', textos):
        expr = re.sub(r"'[^']*'|\"[^\"]*\"", "''", m.group(2))     # tira literais
        for c in re.finditer(r"(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(", expr):
            chamadas.add(c.group(1))
    nativas = {"if", "decodeURIComponent", "encodeURIComponent", "event", "return", "alert", "confirm"}
    faltam = sorted(n for n in chamadas - nativas if n not in _declaradas())
    assert not faltam, "handlers inline chamam funcoes inexistentes: %s" % faltam
