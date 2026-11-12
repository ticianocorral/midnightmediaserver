"""Modo desktop do app empacotado (instaladores nativos).

O instalador deixa um unico executavel. Ele tem dois jeitos de subir:

  --servidor   roda o servidor (e o que o inicio automatico executa; sem
               janela, com a saida indo para o arquivo de log);
  (sem args)   e o que o atalho do usuario abre: garante que o servidor esteja
               de pe e abre o navegador na pagina do app. Se o servidor ja
               estiver rodando, so abre o navegador.

Rodando do codigo-fonte (python3 server.py) nada disto entra em cena: o
comportamento de sempre continua.
"""

import http.client
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

from .config import CACHE_DIR, PORT, env

NOME = "Midnight Media Server"
ROTULO_MAC = "com.mediaserver"


def _porta():
    try:
        return int(env("PORT") or PORT)
    except ValueError:
        return PORT


def _url():
    return "http://localhost:%d" % _porta()


def servidor_responde(timeout=1.5):
    try:
        urllib.request.urlopen(_url() + "/api/auth/status", timeout=timeout)
        return True
    except urllib.error.HTTPError:
        return True   # respondeu (mesmo um erro): ha servidor ali
    except (OSError, ValueError, http.client.HTTPException):
        return False


def _redirecionar_saida():
    """Sem console (Windows/macOS empacotados) print() falharia: manda tudo
    para o log, o mesmo arquivo que o servico de antes usava."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    log = open(CACHE_DIR / "media-server.log", "a", buffering=1, encoding="utf-8")
    sys.stdout = log
    sys.stderr = log


def _iniciar_servidor_desacoplado():
    """Sobe o servidor num processo proprio, que sobrevive ao launcher."""
    cmd = [sys.executable, "--servidor"]
    if os.name == "nt":
        flags = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED | NEW_GROUP | NO_WINDOW
        subprocess.Popen(cmd, creationflags=flags, close_fds=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
    else:
        subprocess.Popen(cmd, start_new_session=True, close_fds=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)


def _registrar_inicio_mac():
    """macOS: LaunchAgent (inicia no login e reinicia se cair). Devolve True
    quando o launchd assumiu o servidor."""
    from pathlib import Path
    import plistlib
    la = Path.home() / "Library" / "LaunchAgents"
    la.mkdir(parents=True, exist_ok=True)
    plist = la / (ROTULO_MAC + ".plist")
    dados = {
        "Label": ROTULO_MAC,
        "ProgramArguments": [sys.executable, "--servidor"],
        "RunAtLoad": True,
        "KeepAlive": True,
        "ProcessType": "Background",
    }
    try:
        atual = plistlib.loads(plist.read_bytes()) if plist.exists() else None
    except Exception:
        atual = None
    if atual == dados:
        return True   # ja registrado e igual: o launchd ja cuida dele
    plist.write_bytes(plistlib.dumps(dados))
    uid = str(os.getuid())
    subprocess.run(["launchctl", "bootout", "gui/%s/%s" % (uid, ROTULO_MAC)],
                   capture_output=True)
    r = subprocess.run(["launchctl", "bootstrap", "gui/" + uid, str(plist)],
                       capture_output=True)
    return r.returncode == 0


_PAGINA_INICIANDO = """<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__NOME__</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0e0e10;color:#f2ecdc;font-family:system-ui,sans-serif;text-align:center;padding:24px}
.s{width:34px;height:34px;border:3px solid #3a3a40;border-top-color:#ff2a2a;border-radius:50%;
margin:0 auto 18px;animation:g 1s linear infinite}@keyframes g{to{transform:rotate(360deg)}}
p{color:#a8a296;font-size:14px;line-height:1.5;max-width:340px}</style></head><body><div>
<div class="s" id="s"></div><h2 id="t">Iniciando o __NOME__...</h2>
<p id="m">Isso leva alguns segundos na primeira vez. Esta pagina abre o app sozinha.</p></div>
<script>var alvo="__URL__",n=0;
function tenta(){fetch(alvo+"/api/auth/status",{mode:"no-cors"}).then(function(){location.replace(alvo)})
.catch(function(){if(++n>90){document.getElementById("s").style.display="none";
document.getElementById("t").textContent="O servidor esta demorando";
document.getElementById("m").textContent="Feche e abra o app de novo. Se continuar, veja o arquivo media-server.log na pasta de cache.";}
else setTimeout(tenta,1000)})}tenta();</script></body></html>"""


def _abrir_pagina_iniciando():
    """Abre ja a pagina de espera: o navegador nao mostra erro enquanto o
    servidor sobe, e ela troca sozinha para o app quando ele responde."""
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        arq = CACHE_DIR / "iniciando.html"
        arq.write_text(_PAGINA_INICIANDO.replace("__NOME__", NOME)
                       .replace("__URL__", _url()), encoding="utf-8")
        return webbrowser.open(arq.as_uri())
    except OSError:
        return False


def abrir():
    """Atalho do usuario: garante o servidor e abre o navegador."""
    if servidor_responde():
        webbrowser.open(_url())
        return
    usou_launchd = sys.platform == "darwin" and _registrar_inicio_mac()
    if not usou_launchd:
        _iniciar_servidor_desacoplado()
    if _abrir_pagina_iniciando():
        return
    for _ in range(60):
        if servidor_responde():
            break
        time.sleep(0.5)
    webbrowser.open(_url())


def iniciar():
    """Ponto de entrada do executavel empacotado."""
    if "--servidor" in sys.argv[1:]:
        _redirecionar_saida()
        from .app import main
        main()
        return
    abrir()
