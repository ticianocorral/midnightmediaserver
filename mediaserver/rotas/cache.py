"""Scan, backup/restauracao e cache de video.

Metodos _get_<caminho> chamados pela tabela de rotas do MediaServerHandler (handler.py).
"""

import json
import urllib.parse
import urllib.request
import urllib.error
import threading
import time
import sqlite3
from ..log import aviso
from pathlib import Path
from ..config import (
    RCLONE_SERVE_PORT,
    DB_PATH,
    CACHED_FILES_PATH,
)
from ..paths import (
    remote_configurado,
    serve_path as _serve_path,
)
from ..db import (
    invalidar_uso_cache,
    get_db,
    get_cache_time,
    is_cache_stale,
    get_cache_usage,
)
from ..rclone import (
    _vfs_segment_match,
    _mark_file_cached,
    _is_file_cached,
    _cached_files,
    _cached_files_lock,
)
from .. import scanner as _scanner
from .. import sources as _sources
from ..queries import (
    cached_all_movies,
    cached_movie_count,
    cached_series_count,
)
from .estado import _download_progress, _download_progress_lock


class CacheRotas:
    """Scan, backup/restauracao e cache de video."""

    # API: Refresh cache (escaneia todas as fontes, ou so uma)
    def _get_api_refresh(self, path, params):
        """GET /api/refresh"""
        source_id = params.get("source", [""])[0].strip() or None
        self._send_json({"status": _scanner.start_background_scan(source_id)})
        return

    # API: Scan progress
    def _get_api_scan_progress(self, path, params):
        """GET /api/scan-progress"""
        self._send_json(_scanner.get_progress())
        return

    # API: Download backup (.zip)
    def _get_api_backup(self, path, params):
        """GET /api/backup"""
        self._serve_backup()
        return

    # API: Backup local (salva em ~/Downloads/ + serve)
    def _get_api_backup_local(self, path, params):
        """GET /api/backup/local"""
        db_path = DB_PATH
        if not db_path.exists():
            self._send_error("Database not found", 404)
            return

        downloads = Path.home() / "Downloads"
        downloads.mkdir(exist_ok=True)
        today = time.strftime("%Y-%m-%d")
        backup_name = f"media-server-backup-{today}.db"
        backup_path = downloads / backup_name

        try:
            import shutil as _shutil
            _shutil.copy2(db_path, backup_path)
            saved_path = str(backup_path)
        except Exception:
            saved_path = str(db_path)

        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", f'attachment; filename="{backup_name}"')
        self.send_header("Content-Length", str(db_path.stat().st_size))
        self._send_media_cors()
        self.send_header("X-Backup-Path", saved_path)
        self.end_headers()
        with open(db_path, "rb") as f:
            self.wfile.write(f.read())
        return

    # API: Backup para a nuvem
    def _get_api_backup_b2(self, path, params):
        """GET /api/backup/b2"""
        if not remote_configurado():
            self._send_error(
                "Nuvem nao configurada — conecte em Ajustes > Nuvem.", 400)
            return
        result = self._backup_to_cloud()
        if result["ok"]:
            self._send_json({"status": "ok", "path": result["path"]})
        else:
            self._send_json({"status": "error", "error": result["error"]}, 500)
        return

    # API: Restore do backup da nuvem
    def _get_api_restore_b2(self, path, params):
        """GET /api/restore/b2"""
        if not remote_configurado():
            self._send_error(
                "Nuvem nao configurada — conecte em Ajustes > Nuvem.", 400)
            return
        self._handle_restore_from_cloud()
        return

    # API: Cache manager — returns all movies with cached status
    def _get_api_cache_manager(self, path, params):
        """GET /api/cache-manager"""
        try:
            movies = cached_all_movies(so_infantil=self._so_infantil())
            # Um unico SELECT para o primeiro video de cada pasta. Antes eram
            # 1 a 2 conexoes SQLite (com 3 PRAGMAs) por filme a cada abertura
            # do app: 5.000 filmes = ate 10 mil conexoes.
            conn_ck = get_db()
            try:
                primeiro = {r["folder_path"]: r["name"] for r in conn_ck.execute(
                    "SELECT folder_path, name FROM files WHERE file_type='video' "
                    "AND rowid IN (SELECT MIN(rowid) FROM files "
                    "WHERE file_type='video' GROUP BY folder_path)")}
            finally:
                conn_ck.close()
            result = []
            for m in movies:
                folder_path = m["path"]
                nome = primeiro.get(folder_path)
                if nome is None:
                    nome = primeiro.get(folder_path.strip("/"))
                cached = bool(nome) and _is_file_cached(folder_path.strip("/") + "/" + nome)
                result.append({
                    "path": folder_path,
                    "name": m["name"],
                    "title": m["title"],
                    "poster": m["poster"],
                    "cached": cached,
                })
            self._send_json(result)
        except Exception as e:
            self._send_exception(e)
        return

    # API: Download a movie file to cache (forces VFS caching in background)
    def _get_api_cache_download(self, path, params):
        """GET /api/cache-download"""
        folder_path = params.get("path", [""])[0]
        if not folder_path:
            self._send_json({"status": "error", "error": "Missing path"}, 400)
            return
        if _sources.is_local(folder_path):
            self._send_json({"status": "ok", "local": True,
                             "message": "Filme em fonte local — ja disponivel offline."})
            return
        try:
            # Find the video file for this folder
            conn = get_db()
            row = conn.execute(
                "SELECT name FROM files WHERE folder_path=? AND file_type='video' LIMIT 1",
                (folder_path,)
            ).fetchone()
            conn.close()
            if not row:
                # Try without leading slash
                conn2 = get_db()
                row2 = conn2.execute(
                    "SELECT name FROM files WHERE folder_path=? AND file_type='video' LIMIT 1",
                    (folder_path.strip("/"),)
                ).fetchone()
                conn2.close()
                if not row2:
                    self._send_json({"status": "error", "error": "No video found"}, 404)
                    return
                row = row2
            video_name = row["name"]
            video_path = folder_path.strip("/") + "/" + video_name

            # Check if already cached
            if _is_file_cached(video_path):
                self._send_json({"status": "already_cached", "path": video_path})
                return

            # Start background download (forces VFS caching via rclone serve HTTP)
            def _do_cache_download(file_path, total_bytes):
                try:
                    print(f"[Midnight Media Server] Cache download starting: {file_path} ({total_bytes}B)", flush=True)

                    with _download_progress_lock:
                        _download_progress[file_path] = {"percent": 0, "status": "downloading", "total": total_bytes, "downloaded": 0}

                    if total_bytes <= 0:
                        # Can't track progress without size, just mark as cached
                        _mark_file_cached(file_path)
                        with _download_progress_lock:
                            _download_progress[file_path] = {"percent": 100, "status": "done"}
                        print(f"[Midnight Media Server] Cache marked (no size info): {file_path}", flush=True)
                        return

                    # Use HTTP range requests against rclone serve to force VFS caching
                    safe_url_path = urllib.parse.quote(_serve_path(file_path), safe="/")
                    rclone_url = f"http://localhost:{RCLONE_SERVE_PORT}/{safe_url_path}"
                    CHUNK = 5 * 1024 * 1024  # 5MB chunks (same as frontend)
                    downloaded = 0

                    while downloaded < total_bytes:
                        end = min(downloaded + CHUNK - 1, total_bytes - 1)
                        range_hdr = f"bytes={downloaded}-{end}"
                        try:
                            req = urllib.request.Request(rclone_url, method="GET")
                            req.add_header("Range", range_hdr)
                            with urllib.request.urlopen(req, timeout=120) as resp:
                                while True:
                                    buf = resp.read(65536)
                                    if not buf:
                                        break
                                    downloaded += len(buf)
                                    pct = min(99, int((downloaded / total_bytes) * 100))
                                    with _download_progress_lock:
                                        _download_progress[file_path] = {
                                            "percent": pct, "status": "downloading",
                                            "total": total_bytes, "downloaded": downloaded
                                        }
                        except Exception as chunk_err:
                            print(f"[Midnight Media Server] Cache chunk error at {downloaded}: {chunk_err}", flush=True)
                            # Retry once
                            try:
                                req2 = urllib.request.Request(rclone_url, method="GET")
                                req2.add_header("Range", range_hdr)
                                with urllib.request.urlopen(req2, timeout=120) as resp2:
                                    while True:
                                        buf = resp2.read(65536)
                                        if not buf:
                                            break
                                        downloaded += len(buf)
                                        pct = min(99, int((downloaded / total_bytes) * 100))
                                        with _download_progress_lock:
                                            _download_progress[file_path] = {
                                                "percent": pct, "status": "downloading",
                                                "total": total_bytes, "downloaded": downloaded
                                            }
                            except Exception:
                                raise

                    # Mark as fully cached
                    _mark_file_cached(file_path)
                    with _download_progress_lock:
                        _download_progress[file_path] = {"percent": 100, "status": "done"}
                    print(f"[Midnight Media Server] Cache download complete: {file_path}", flush=True)
                except Exception as e:
                    print(f"[Midnight Media Server] Cache download error: {e}", flush=True)
                    with _download_progress_lock:
                        _download_progress[file_path] = {"percent": 0, "status": "error"}

            # Get file size first (needed for progress tracking)
            file_size = 0
            # Prefer DB size (fastest, most reliable)
            try:
                conn_sz = get_db()
                row_sz = conn_sz.execute(
                    "SELECT size FROM files WHERE folder_path=? AND file_type='video' LIMIT 1",
                    (folder_path.strip("/"),)
                ).fetchone()
                if not row_sz:
                    row_sz = conn_sz.execute(
                        "SELECT size FROM files WHERE folder_path=? AND file_type='video' LIMIT 1",
                        (folder_path,)
                    ).fetchone()
                conn_sz.close()
                if row_sz and row_sz["size"] > 0:
                    file_size = row_sz["size"]
            except (sqlite3.Error, OSError) as e:
                aviso("cache-download: tamanho do arquivo nao veio do banco", e)

            t = threading.Thread(target=_do_cache_download, args=(video_path, file_size), daemon=True)
            t.start()
            self._send_json({"status": "started", "path": video_path, "name": video_name, "size": file_size})
        except Exception as e:
            self._send_exception(e)
        return

    # API: Download progress for a video being cached
    def _get_api_cache_download_progress(self, path, params):
        """GET /api/cache-download-progress"""
        file_path = params.get("path", [""])[0]
        if not file_path:
            self._send_json({"percent": 0, "status": "unknown"})
            return
        with _download_progress_lock:
            prog = dict(_download_progress.get(file_path, {"percent": 0, "status": "unknown"}))
        self._send_json(prog)
        return

    # API: Check if file is fully cached in rclone VFS
    def _get_api_check_cached(self, path, params):
        """GET /api/check-cached"""
        file_path = params.get("path", [""])[0]
        if not file_path:
            self._send_json({"cached": False})
            return
        # Arquivo em fonte local ja esta no disco: offline por definicao,
        # e o cache VFS do rclone nao tem nada a ver com ele.
        if _sources.is_local(file_path):
            self._send_json({"cached": True, "local": True})
            return
        self._send_json({"cached": _is_file_cached(file_path)})
        return

    # API: Clear all caches (VFS, DB cache markers)
    def _get_api_clear_cache(self, path, params):
        """GET /api/clear-cache"""
        try:
            import shutil as sh
            invalidar_uso_cache()
            # Clear VFS cache (downloaded videos)
            vfs_cache = Path.home() / ".cache" / "rclone" / "vfs"
            if vfs_cache.exists():
                for entry in vfs_cache.iterdir():
                    if entry.is_dir():
                        sh.rmtree(entry)
            # Clear cached files list
            with _cached_files_lock:
                _cached_files.clear()
                if CACHED_FILES_PATH.exists():
                    CACHED_FILES_PATH.unlink()
            # Clear DB cache timestamps
            conn = get_db()
            conn.execute("DELETE FROM cache_meta")
            conn.commit()
            conn.close()
            self._send_json({"status": "ok"})
        except Exception as e:
            self._send_exception(e)
        return

    # API: Remove single movie from VFS cache
    def _get_api_uncache(self, path, params):
        """GET /api/uncache"""
        folder_path = params.get("path", [""])[0]
        if not folder_path:
            self._send_json({"status": "error", "error": "Missing path"}, 400)
            return
        # Um caminho vazio ou minusculo casaria com todo o cache VFS.
        if len(folder_path.strip("/")) < 2 or folder_path.strip("/") in (".", ".."):
            self._send_json({"status": "error", "error": "Caminho invalido"}, 400)
            return
        # Fonte local nao passa pelo cache VFS: apagar aqui seria apagar o
        # filme do HD do usuario.
        if _sources.is_local(folder_path):
            self._send_json(
                {"status": "error",
                 "error": "Esse filme esta numa fonte local — nao ha cache a remover."},
                400)
            return
        try:
            # Get the video file name from the database directly
            video_name = ""
            try:
                conn = get_db()
                folder = folder_path.strip("/")
                cur = conn.execute(
                    "SELECT name FROM files WHERE folder_path = ? AND extension IN ('.mp4','.mkv','.avi','.mov','.webm') LIMIT 1",
                    (folder,)
                )
                row = cur.fetchone()
                if row:
                    video_name = row[0]
                conn.close()
            except (sqlite3.Error, OSError) as e:
                aviso("uncache: nome do video nao veio do banco", e)
            
            # Remove from cached_files list
            with _cached_files_lock:
                to_remove = {p for p in _cached_files if folder_path.strip("/") in p}
                # No do_GET original um `global _cached_files` (de outra rota) valia para a funcao
                # inteira; como metodo isolado, `-=` viraria variavel local. Altera o proprio conjunto.
                _cached_files.difference_update(to_remove)
                CACHED_FILES_PATH.write_text(json.dumps(list(_cached_files)))

            # Remove VFS cache files from rclone cache directory
            vfs_cache = Path.home() / ".cache" / "rclone" / "vfs"
            if vfs_cache.exists():
                removed = 0
                # rclone VFS cache stores files under <remote>{hash}/<full remote path>
                # Search recursively for any file/dir containing the folder path
                folder_stripped = folder_path.strip("/")
                for entry in vfs_cache.rglob("*"):
                    if entry.is_file():
                        if _vfs_segment_match(str(entry), folder_stripped):
                            entry.unlink()
                            removed += 1
                    elif entry.is_dir() and _vfs_segment_match(str(entry), folder_stripped):
                        import shutil
                        shutil.rmtree(entry, ignore_errors=True)
                        removed += 1
                # Also try matching just the folder name (last path component)
                folder_last = folder_stripped.split("/")[-1]
                for entry in vfs_cache.rglob("*"):
                    if entry.is_file() and _vfs_segment_match(str(entry), folder_last):
                        # Check if it's a parent match (not already deleted)
                        if entry.exists():
                            entry.unlink()
                            removed += 1
                if removed > 0:
                    print(f"[Midnight Media Server] Removed {removed} VFS cache entries for {folder_path}", flush=True)
                else:
                    # Fallback: clear entire VFS cache for this folder path using simple hash search
                    for entry in vfs_cache.iterdir():
                        if entry.is_dir():
                            for cached_file in entry.rglob("*"):
                                if cached_file.is_file():
                                    cached_str = str(cached_file)
                                    _flat = folder_path.strip("/").replace("/", "_")
                                    if len(_flat) >= 2 and _flat in cached_str:
                                        cached_file.unlink()
                                        removed += 1
                    if removed > 0:
                        print(f"[Midnight Media Server] Removed {removed} VFS cache entries (deep) for {folder_path}", flush=True)

            self._send_json({"status": "ok"})
        except Exception as e:
            self._send_exception(e)
        return

    # API: Cache status
    def _get_api_cache_status(self, path, params):
        """GET /api/cache-status"""
        cache_time = get_cache_time()
        stale = is_cache_stale()
        usage = get_cache_usage()
        so_infantil = self._so_infantil()
        conn = get_db()
        genres = 0  # gênero por pasta deixou de existir
        files = conn.execute("SELECT COUNT(*) as c FROM files").fetchone()["c"]
        conn.close()
        self._send_json({
            "cached": cache_time is not None,
            "last_updated": cache_time,
            "stale": stale,
            "genres": genres,
            # Contagens com a mesma definição das páginas A-Z e Séries —
            # a home espelha exatamente o que o usuário vê ao clicar.
            "movies": cached_movie_count(so_infantil),
            "series": cached_series_count(so_infantil),
            "files": files,
            "usage": usage,
        })
        return
