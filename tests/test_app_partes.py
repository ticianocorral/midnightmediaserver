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


# ── sem JS inline: o que permite (no futuro) uma CSP que bloqueie script inline ──
def _fontes():
    return {"index.html": INDEX, **{p.name: p.read_text(encoding="utf-8") for p in PARTES}}


def _sem_comentarios(texto):
    return "\n".join(l for l in texto.split("\n") if not l.lstrip().startswith("//"))


def test_nao_ha_handlers_inline():
    achados = []
    for nome, texto in _fontes().items():
        for m in re.finditer(r'\son(?:click|error|input|change|keydown|keyup|load|submit|focus|blur)=', _sem_comentarios(texto)):
            achados.append(nome + ": " + _sem_comentarios(texto)[m.start():m.start() + 60].strip())
    assert not achados, achados


def test_nao_ha_script_nem_url_javascript_inline():
    assert not re.findall(r"<script>(?!\s*</script>)", INDEX)           # <script> sem src
    for nome, texto in _fontes().items():
        assert "javascript:" not in _sem_comentarios(texto), nome


def _acoes_permitidas():
    js = (RAIZ / "static" / "app" / "11-acoes.js").read_text(encoding="utf-8")
    corpo = re.search(r"const ACOES = Object\.freeze\(\{(.*?)\}\);", js, re.S).group(1)
    return {n.strip() for n in corpo.split(",") if n.strip()}


def test_toda_acao_usada_esta_na_lista_permitida():
    textos = "\n".join(_sem_comentarios(t) for t in _fontes().values())
    usadas = set(re.findall(r"data-act(?:-[a-z]+)?=\\?\"([A-Za-z_]\w*)\\?\"", textos))
    usadas |= set(re.findall(r"attrAcao\('([A-Za-z_]\w*)'", textos))
    usadas |= set(re.findall(r"&quot;n&quot;:&quot;([A-Za-z_]\w*)&quot;", textos))
    usadas |= {"selectSubtitleSize", "selectSubtitleColor"}               # passadas como aoEscolher
    faltam = sorted(usadas - _acoes_permitidas())
    assert not faltam, "acoes usadas no HTML mas fora de ACOES (o clique nao faria nada): %s" % faltam


def test_toda_acao_permitida_e_uma_funcao_declarada():
    assert _declaradas() >= _acoes_permitidas(), sorted(_acoes_permitidas() - _declaradas())


def test_despachante_nao_usa_eval_nem_window_por_nome():
    js = (RAIZ / "static" / "app" / "11-acoes.js").read_text(encoding="utf-8")
    codigo = _sem_comentarios(js)
    assert "eval(" not in codigo and "new Function" not in codigo and "window[" not in codigo


def test_acoes_carrega_antes_da_inicializacao():
    nomes = [p.name for p in PARTES]
    assert nomes.index("11-acoes.js") < nomes.index("12-init.js")


def test_nada_depende_dos_atributos_onclick_antigos():
    """tv.js e styles.css chegaram a selecionar [onclick]: sem o atributo, a TV perdia a
    navegacao e o cursor de clique sumia. Qualquer codigo que leia o atributo quebra igual."""
    import glob
    arquivos = [RAIZ / "static" / "tv.js", RAIZ / "static" / "styles.css", RAIZ / "static" / "tv.css",
                *PARTES]
    achados = []
    for f in arquivos:
        for i, linha in enumerate(f.read_text(encoding="utf-8").split("\n"), 1):
            if linha.lstrip().startswith(("//", "/*", "*")):
                continue
            if re.search(r"\[on(click|error|input|change|keydown)[\]=*^$~|]|getAttribute\(['\"]on(click|error|input|change|keydown)", linha):
                achados.append("%s:%d %s" % (f.name, i, linha.strip()[:80]))
    assert not achados, achados


# ── XSS: atributos e campos de NFO sem escape ────────────────
# Expressoes que entram em `="' + X + '"` e foram AUDITADAS (constante, numero, URL ja codificada
# por posterUrl/streamUrl, ou titulo ja passado por escHtml). Qualquer outra expressao nova falha
# aqui ate alguem auditar: foi assim que um data-path="' + m.path + '" sem escape sobreviveu.
_SEGUROS_ATRIBUTO = re.compile(
    r"^(escHtml|enc\(|encodeURIComponent|posterUrl|capaUrl|attrAcao|JSON\.stringify|Math\.|Number|parseInt|cssUrl)")
_AUDITADOS = {
    "nome",                                   # nome de acao (constante) em attrAcao
    "GENERO_PREFIXO + g.id", "titulo",        # id numerico; titulo = escHtml(...) em todas as definicoes
    "poster", "posterSrc", "x.poster", "c.thumb",   # URLs: encodeURIComponent / validadas
    "id",                                     # 10-nuvem.js: 'wz_' + o.nome, nome de opcao devolvido pelo proprio rclone
    "icon", "(ativo ? 'true' : 'false')", "(assistido ? 'true' : 'false')",
    "(a[0] === aba ? 'background:var(--primary);color:#fff' : '')", "(o.senha ? 'password' : 'text')",
}


def test_atributo_html_nao_recebe_valor_sem_escape():
    suspeitos = []
    for p in PARTES:
        for n, linha in enumerate(p.read_text(encoding="utf-8").split("\n"), 1):
            if linha.lstrip().startswith("//"):
                continue
            for m in re.finditer(r"""=\\?"'\s*\+\s*(.+?)\s*\+\s*'\\?\"""", linha):
                expr = m.group(1).strip()
                if not _SEGUROS_ATRIBUTO.match(expr) and expr not in _AUDITADOS:
                    suspeitos.append("%s:%d  %s" % (p.name, n, expr))
    assert not suspeitos, "valor sem escape dentro de atributo HTML:\n" + "\n".join(suspeitos)


def test_campos_do_nfo_na_ficha_passam_por_escHtml():
    for p in PARTES:
        for n, linha in enumerate(p.read_text(encoding="utf-8").split("\n"), 1):
            for m in re.finditer(r"\$\{\s*(nfo\.[A-Za-z_.]+)\s*\}", linha):
                pytest.fail("%s:%d  ${%s} sem escHtml" % (p.name, n, m.group(1)))
            if re.search(r"'\s*\+\s*nfo\.[a-z]+\s*\+\s*'", linha):
                pytest.fail("%s:%d  campo do NFO concatenado sem escHtml: %s" % (p.name, n, linha.strip()[:80]))
