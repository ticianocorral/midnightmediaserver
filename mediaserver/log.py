"""Aviso de falha que o app contorna.

Varios trechos engolem erros de proposito (cache que nao grava, NFO que nao le,
metadado corrompido) e seguem em frente. Engolir em silencio escondia problemas
reais, entao esses trechos passam a avisar aqui, no mesmo formato do resto do log
(stderr, prefixo do app). Um mesmo contexto avisa no maximo uma vez por minuto:
um stream com problema nao deve inundar o terminal.
"""
import sys
import time

_ULTIMO = {}
_INTERVALO = 60.0


def aviso(contexto, erro=None, *, agora=None):
    """Escreve "[Midnight Media Server] AVISO <contexto>: <Tipo>: <msg>" (rate-limited)."""
    t = time.monotonic() if agora is None else agora
    ultimo = _ULTIMO.get(contexto)
    if ultimo is not None and t - ultimo < _INTERVALO:
        return False
    _ULTIMO[contexto] = t
    detalhe = "" if erro is None else ": %s: %s" % (type(erro).__name__, erro)
    try:
        sys.stderr.write("[Midnight Media Server] AVISO %s%s\n" % (contexto, detalhe))
    except Exception:        # o proprio log nunca pode derrubar a requisicao
        return False
    return True
