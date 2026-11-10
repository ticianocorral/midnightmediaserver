"""Estado compartilhado entre rotas."""
import threading

# Progresso de download pro cache VFS: video_path -> {percent, status, ...}
_download_progress = {}
_download_progress_lock = threading.Lock()
