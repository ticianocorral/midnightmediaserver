"""Credencial do rclone local (serve http e rcd).

Antes, o `rclone serve http` (porta 18082) e o `rclone rcd` (5572, com --rc-no-auth)
aceitavam qualquer um: outro processo ou usuario da maquina, ou uma pagina aberta no
navegador do servidor (DNS rebinding contra localhost), lia o acervo, ou usava a API rc,
que inclui `config/dump` com as credenciais da nuvem. Agora cada execucao do app gera uma
senha aleatoria e so quem a tem fala com o rclone.

A senha vai ao rclone pelo AMBIENTE do processo (RCLONE_USER/RCLONE_PASS, RCLONE_RC_USER/
RCLONE_RC_PASS), nunca por argumento: argumento aparece no `ps` de qualquer usuario.
Fica so em memoria; reiniciar o app gera outra (e o rclone antigo e reiniciado junto).
"""
import base64
import secrets

USUARIO = "media-server"
_SENHA = secrets.token_urlsafe(32)


def senha():
    return _SENHA


def cabecalho():
    """Cabecalho Authorization (Basic) para quem fala com o rclone local."""
    token = base64.b64encode(("%s:%s" % (USUARIO, _SENHA)).encode("utf-8")).decode("ascii")
    return {"Authorization": "Basic " + token}


def env_serve():
    """Variaveis que ligam a autenticacao do `rclone serve http`."""
    return {"RCLONE_USER": USUARIO, "RCLONE_PASS": _SENHA}


def env_rc():
    """Variaveis que ligam a autenticacao da API rc (`rclone rcd`)."""
    return {"RCLONE_RC_USER": USUARIO, "RCLONE_RC_PASS": _SENHA}
