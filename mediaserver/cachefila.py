"""Fila de downloads do cache offline (nuvem -> VFS do rclone).

Antes cada filme baixava numa thread propria, e quem acompanhava o progresso era
a tela: fechar a janela perdia o fio. Agora ha UMA fila no servidor, com um
trabalhador que baixa um arquivo por vez (nao disputa a banda consigo mesmo).
A tela so consulta o estado, entao dá para fechar e reabrir sem perder nada.
Serve filme (1 video) e serie (episodios soltos ou temporadas inteiras).
"""

import threading
import urllib.parse
import urllib.request
from pathlib import Path

from . import rclone_auth
from .config import CACHED_FILES_PATH, RCLONE_SERVE_PORT
from .log import aviso
from .paths import serve_path as _serve_path
from .rclone import (
    _cached_files,
    _cached_files_lock,
    _is_file_cached,
    _mark_file_cached,
    _norm_cache_path,
    _vfs_segment_match,
)
from .rotas.estado import _download_progress, _download_progress_lock

_CHUNK = 5 * 1024 * 1024
_lock = threading.RLock()
_itens = []                 # dicts na ordem de chegada
_cancelar_atual = threading.Event()
_trabalhador = None


def _item(path, size, titulo, grupo):
    return {"path": path, "size": int(size or 0), "titulo": titulo or path.rsplit("/", 1)[-1],
            "grupo": grupo or "", "status": "queued", "percent": 0, "downloaded": 0}


def adicionar(arquivos):
    """arquivos: [(path, size, titulo, grupo)]. Pula o que ja esta no cache ou
    na fila. Devolve (quantos entraram, bytes que faltam baixar)."""
    global _trabalhador
    novos, bytes_ = 0, 0
    with _lock:
        if not any(i["status"] in ("queued", "downloading") for i in _itens):
            _itens.clear()                       # lote novo: esquece os concluidos
        vivos = {i["path"] for i in _itens if i["status"] in ("queued", "downloading")}
        for path, size, titulo, grupo in arquivos:
            p = _norm_cache_path(path)
            if p in vivos or _is_file_cached(p):
                continue
            _itens[:] = [i for i in _itens if i["path"] != p]   # refaz um que falhou/cancelou
            _itens.append(_item(p, size, titulo, grupo))
            vivos.add(p)
            novos += 1
            bytes_ += int(size or 0)
        if novos and (_trabalhador is None or not _trabalhador.is_alive()):
            _trabalhador = threading.Thread(target=_trabalhar, daemon=True)
            _trabalhador.start()
    return novos, bytes_


def estado():
    with _lock:
        itens = [dict(i) for i in _itens]
    ativos = [i for i in itens if i["status"] in ("queued", "downloading")]
    total = sum(i["size"] for i in itens)
    baixado = sum(i["size"] if i["status"] == "done" else i["downloaded"] for i in itens
                  if i["status"] in ("done", "downloading"))
    return {"itens": itens, "ativos": len(ativos), "total": total, "baixado": baixado,
            "feitos": sum(1 for i in itens if i["status"] == "done"),
            "erros": sum(1 for i in itens if i["status"] == "error")}


def cancelar(path=None):
    """Tira da fila o que ainda nao comecou e interrompe o que esta baixando
    (so esse, se `path` vier). Devolve quantos itens foram cancelados."""
    n = 0
    alvo = _norm_cache_path(path) if path else None
    with _lock:
        for i in _itens:
            if alvo and i["path"] != alvo:
                continue
            if i["status"] == "queued":
                i["status"] = "cancelled"
                n += 1
            elif i["status"] == "downloading":
                _cancelar_atual.set()
                n += 1
    return n


def _atualizar(item, **campos):
    with _lock:
        item.update(campos)
    with _download_progress_lock:
        _download_progress[item["path"]] = {
            "percent": item["percent"], "status": {"downloading": "downloading", "done": "done",
                                                    "error": "error"}.get(item["status"], "unknown"),
            "total": item["size"], "downloaded": item["downloaded"]}


class _Cancelado(Exception):
    pass


def _baixar(item):
    path, total = item["path"], item["size"]
    if total <= 0:                      # sem tamanho nao ha progresso: so marca
        _mark_file_cached(path)
        return
    url = "http://localhost:%d/%s" % (RCLONE_SERVE_PORT, urllib.parse.quote(_serve_path(path), safe="/"))
    baixado = 0
    while baixado < total:
        fim = min(baixado + _CHUNK - 1, total - 1)
        for tentativa in (1, 2):
            try:
                req = urllib.request.Request(url, method="GET", headers=rclone_auth.cabecalho())
                req.add_header("Range", "bytes=%d-%d" % (baixado, fim))
                with urllib.request.urlopen(req, timeout=120) as resp:
                    while True:
                        if _cancelar_atual.is_set():
                            raise _Cancelado()
                        buf = resp.read(65536)
                        if not buf:
                            break
                        baixado += len(buf)
                        _atualizar(item, downloaded=baixado,
                                   percent=min(99, int(baixado * 100 / total)))
                break
            except _Cancelado:
                raise
            except Exception as e:
                if tentativa == 2:
                    raise
                aviso("cache offline: trecho falhou, tentando de novo", e)
    _mark_file_cached(path)


def _trabalhar():
    while True:
        with _lock:
            item = next((i for i in _itens if i["status"] == "queued"), None)
            if item is None:
                return
            item["status"] = "downloading"
        _cancelar_atual.clear()
        try:
            _baixar(item)
            _atualizar(item, status="done", percent=100, downloaded=item["size"])
        except _Cancelado:
            _atualizar(item, status="cancelled")
        except Exception as e:
            aviso("cache offline: download falhou", e)
            _atualizar(item, status="error")


# ── Apagar do cache ──────────────────────────────────────────

def apagar(arquivos):
    """Tira arquivos (paths logicos) do cache do VFS. Devolve quantas entradas
    do disco saíram. Uma unica varredura da pasta do cache para todos."""
    alvos = {_norm_cache_path(p) for p in arquivos if len(_norm_cache_path(p)) >= 2}
    if not alvos:
        return 0
    with _lock:
        for i in _itens:
            if i["path"] in alvos and i["status"] == "done":
                i["status"] = "cancelled"
    with _cached_files_lock:
        _cached_files.difference_update(alvos)
        try:
            import json
            CACHED_FILES_PATH.write_text(json.dumps(list(_cached_files)))
        except OSError as e:
            aviso("cache offline: nao salvou a lista de baixados", e)
    removidos = 0
    vfs = Path.home() / ".cache" / "rclone" / "vfs"
    if vfs.exists():
        for entry in list(vfs.rglob("*")):
            if entry.is_file() and any(_vfs_segment_match(str(entry), a) for a in alvos):
                try:
                    entry.unlink()
                    removidos += 1
                except OSError:
                    pass
    return removidos
