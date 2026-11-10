"""Guarda contra a classe de bug que quase passou ao mover metodos entre modulos:
nome indefinido ou variavel local usada antes de atribuir (UnboundLocalError)."""
import subprocess
import sys
from pathlib import Path

import pytest

pytest.importorskip("pyflakes")

RAIZ = Path(__file__).resolve().parent.parent
GRAVES = ("undefined name", "referenced before assignment", "redefinition of unused", "unable to detect undefined names")


def test_sem_nomes_indefinidos_no_pacote():
    r = subprocess.run([sys.executable, "-m", "pyflakes", str(RAIZ / "mediaserver"), str(RAIZ / "server.py")],
                       capture_output=True, text=True)
    graves = [l for l in r.stdout.splitlines() if any(g in l for g in GRAVES)]
    assert not graves, "\n".join(graves)
