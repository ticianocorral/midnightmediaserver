  // ==================== OFFLINE CACHE TRACKER ====================
  // Só filmes da nuvem baixados pro cache VFS. Filme em fonte local está no
  // disco por natureza — não foi "baixado", e misturar os dois esvaziava o
  // sentido da seção. O filter limpa o que versões anteriores gravaram.
  const _cachedSet = new Set(
    JSON.parse(localStorage.getItem('media_server_cached') || '[]')
      .filter(p => !isLocalPath(p))
  );
  function _isCached(folderPath) {
    return _cachedSet.has(folderPath);
  }
  function _markCached(folderPath) {
    if (isLocalPath(folderPath)) return;
    if (!_cachedSet.has(folderPath)) {
      _cachedSet.add(folderPath);
      localStorage.setItem('media_server_cached', JSON.stringify([..._cachedSet]));
    }
  }
  // Sync _cachedSet with server's actual cache state (e.g. after server restart)
  async function _syncCachedFromServer() {
    try {
      const res = await fetch('/api/cache-manager');
      const movies = await res.json();
      if (!movies) return;
      let changed = false;
      movies.forEach(m => {
        // O servidor reporta cached=true para filme local (ele está no disco);
        // aqui a pergunta é outra: foi baixado da nuvem?
        if (isLocalPath(m.path)) return;
        if (m.cached && !_cachedSet.has(m.path)) {
          _cachedSet.add(m.path);
          changed = true;
        } else if (!m.cached && _cachedSet.has(m.path)) {
          _cachedSet.delete(m.path);
          changed = true;
        }
      });
      if (changed) {
        localStorage.setItem('media_server_cached', JSON.stringify([..._cachedSet]));
      }
    } catch(_) {}
  }

  function clearCache() {
    localStorage.removeItem('media_server_cached');
    _cachedSet.clear();
    showToast('🧹 Limpando cache do servidor...', '');
    fetch('/api/clear-cache', { method: 'POST' }).then(r => r.json()).then(d => {
      if (d.status === 'ok') {
        showToast('🧹 Cache limpo com sucesso!', 'success');
        document.getElementById('cacheUsageSize').textContent = '0B';
        // O botao agora fica dentro do gerenciador: se ele estiver aberto,
        // a lista precisa refletir que nada esta mais baixado.
        if (document.getElementById('cacheManagerModal').classList.contains('active')) {
          _cmMovies.forEach(m => { if (!isLocalPath(m.path)) m.cached = false; });
          _renderCacheList(_cmMovies);
          _updateCacheStats();
        }
        loadPath(currentPath || '');
      } else {
        showToast('Erro ao limpar cache: ' + (d.error || 'desconhecido'), 'error');
      }
    }).catch(e => {
      showToast('Erro ao limpar cache: ' + e.message, 'error');
    });
  }

  // Background download — keeps fetching chunks even when video is paused
  let _bgDownloadAbort = null;

  function _startBgDownload(filePath) {
    if (!filePath || _bgDownloadAbort) return;

    // Derive folder path from file path (remove filename)
    const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));

    const controller = new AbortController();
    _bgDownloadAbort = controller;

    // Get file size first
    fetch('/api/info?path=' + encodeURIComponent(filePath)).then(r => r.json()).then(info => {
      if (!info || !info.Size) { _bgDownloadAbort = null; return; }
      const fileSize = info.Size;

      // Fetch the whole file in background via sequential range requests
      // This forces rclone VFS to cache it even when video is paused
      let downloaded = 0;
      const CHUNK = 5 * 1024 * 1024; // 5MB chunks

      function fetchNextChunk() {
        if (!_bgDownloadAbort || downloaded >= fileSize) {
          if (downloaded >= fileSize) {
            // Done — verify and mark as cached
            if (folderPath) {
              _markCached(folderPath);
              _verifyServerCache(folderPath, filePath);
            }
          }
          _bgDownloadAbort = null;
          return;
        }

        const end = Math.min(downloaded + CHUNK - 1, fileSize - 1);
        fetch('/api/stream?path=' + encodeURIComponent(filePath), {
          headers: { 'Range': 'bytes=' + downloaded + '-' + end },
          signal: controller.signal
        }).then(r => {
          return r.blob();
        }).then(blob => {
          downloaded += blob.size;
          // Update cache percentage in controls
          const pct = Math.round((downloaded / fileSize) * 100);
          const el = document.getElementById('streamStatus');
          if (el) {
            if (pct >= 100) {
              el.innerHTML = '<svg class="icon-svg"><use href="#i-save"></use></svg> Cache total';
              el.className = 'stream-status cached';
            } else {
              el.innerHTML = '<svg class="icon-svg"><use href="#i-download"></use></svg> ' + pct + '%';
              el.className = 'stream-status';
            }
          }
          fetchNextChunk();
        }).catch(() => {
          _bgDownloadAbort = null;
        });
      }

      fetchNextChunk();
    }).catch(() => { _bgDownloadAbort = null; });
  }

  function _stopBgDownload() {
    if (_bgDownloadAbort) {
      try { _bgDownloadAbort.abort(); } catch(e) {}
      _bgDownloadAbort = null;
    }
  }

  function _verifyServerCache(folderPath, filePath) {
    if (!filePath) return;
    // Get file size first, then request the last byte
    fetch('/api/info?path=' + encodeURIComponent(filePath)).then(r => r.json()).then(info => {
      if (!info || !info.Size) return;
      const lastByte = info.Size - 1;
      fetch('/api/stream?path=' + encodeURIComponent(filePath), {
        headers: { 'Range': 'bytes=' + lastByte + '-' + lastByte }
      }).then(r => {
        // If we got a valid response, the file is fully cached
        if (r.ok || r.status === 206) {
          _markCached(folderPath);
          // Also notify server to mark it
          fetch('/api/check-cached?path=' + encodeURIComponent(filePath)).catch(() => {});
        }
      }).catch(() => {});
    }).catch(() => {});
  }

  async function _checkServerCached() {
    // Confere com o servidor quais filmes estao 100% baixados no VFS.
    // O A-Z já traz filme de pasta e filme solto; para os de pasta o video
    // vem da listagem da propria pasta, para o solto o arquivo e o proprio
    // path do card.
    try {
      const res = await fetch('/api/all-movies');
      const movies = await res.json();
      if (!movies) return;

      for (const m of movies) {
        if (isLocalPath(m.path) || _cachedSet.has(m.path)) continue;
        let filePath = null;
        if (m.is_file) {
          filePath = m.path;
        } else {
          const listRes = await fetch('/api/list?path=' + encodeURIComponent(m.path));
          const listData = await listRes.json();
          const video = listData && (listData.videos || []).find(v =>
            v.Name && /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|mpg|mpeg)$/i.test(v.Name));
          if (video) filePath = m.path + '/' + video.Name;
        }
        if (!filePath) continue;
        const checkRes = await fetch('/api/check-cached?path=' + encodeURIComponent(filePath));
        const checkData = await checkRes.json();
        if (checkData.cached) {
          _markCached(m.path);
        }
      }

      if (_cachedSet.size > 0) _renderOfflineGrid();
    } catch(e) {}
  }

  function _renderOfflineGrid() {
    const section = document.getElementById('offlineSection');
    const grid = document.getElementById('offlineGrid');
    if (!section || !grid) return;

    const paths = [..._cachedSet].filter(p => !isLocalPath(p));
    if (paths.length === 0) {
      section.style.display = 'none';
      grid.innerHTML = '';
      return;
    }

    section.style.display = 'block';
    let html = '';
    let loaded = 0;

    paths.forEach((path, idx) => {
      const name = path.split('/').pop().replace(/[._]/g, ' ').replace(/\.[^.]+$/, '');
      const safePath = enc(path);
      html += '<div class="movie-card" onclick="showMovieInfo(decodeURIComponent(\'' + safePath + '\'), event)" title="' + escHtml(name) + '">'
        + '<div class="movie-card-poster-placeholder" style="display:flex"><svg class="icon-svg"><use href="#i-box"></use></svg></div>'
        + '<div class="movie-card-overlay">'
        + '<div class="movie-card-title">' + escHtml(name) + '</div>'
        + '<div class="movie-card-subtitle"><svg class="icon-svg"><use href="#i-download"></use></svg> Offline</div>'
        + '</div></div>';

      // Load poster in background
      cachedFetch('/api/movie-detail?path=' + encodeURIComponent(path)).then(detail => {
        if (!detail || !detail.poster) return;
        const cards = grid.querySelectorAll('.movie-card');
        if (cards[idx]) {
          const img = document.createElement('img');
          img.className = 'movie-card-poster';
          img.src = posterUrl(path, detail.poster.Name);
          img.alt = escHtml(name);
          img.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0';
          img.onerror = () => img.remove();
          cards[idx].appendChild(img);
        }
      });
    });
    grid.innerHTML = html;
  }

  // ==================== CACHE MANAGER MODAL ====================
  let _cmMovies = [];
  let _cmDownloading = new Set();     // folder_paths being downloaded
  let _cmVideoPaths = {};            // folder_path -> video_path
  let _cmPollTimers = {};            // folder_path -> timer id

  function openCacheManager() {
    document.getElementById('cacheManagerModal').classList.add('active');
    document.body.style.overflow = 'hidden';
    _cmDownloading.clear();
    // Sync cached state from server so modal shows accurate status
    _syncCachedFromServer().then(() => _loadCacheManagerList());
  }

  function closeCacheManager() {
    document.getElementById('cacheManagerModal').classList.remove('active');
    document.body.style.overflow = '';
    // Stop all poll timers
    for (const k in _cmPollTimers) {
      clearInterval(_cmPollTimers[k]);
    }
    _cmPollTimers = {};
  }

  // Close on backdrop click
  document.getElementById('cacheManagerModal').addEventListener('click', function(e) {
    if (e.target === this) closeCacheManager();
  });

  async function _loadCacheManagerList() {
    const list = document.getElementById('cmList');
    list.innerHTML = '<div class="loading" style="min-height:100px"><div class="spinner"></div><span>Carregando filmes...</span></div>';
    try {
      const res = await fetch('/api/cache-manager');
      const movies = await res.json();
      if (!movies || movies.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg class="icon-svg"><use href="#i-film"></use></svg></div><h3>Nenhum filme encontrado</h3><p>Escaneie suas fontes primeiro.</p></div>';
        return;
      }
      _cmMovies = movies;
      _renderCacheList(movies);
    } catch(e) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg class="icon-svg"><use href="#i-error"></use></svg></div><h3>Erro ao carregar</h3></div>';
    }
  }

  function _updateCacheStats() {
    const total = _cmMovies.length;
    const cached = _cmMovies.filter(m => m.cached).length;
    document.getElementById('cmTotalMovies').textContent = total;
    document.getElementById('cmCachedMovies').textContent = cached;
    // Fetch cache usage
    fetch('/api/cache-status').then(r => r.json()).then(s => {
      if (s && s.usage) {
        const t = s.usage.total;
        let h = '';
        if (t < 1024) h = t + 'B';
        else if (t < 1048576) h = (t / 1024).toFixed(1) + 'K';
        else if (t < 1073741824) h = (t / 1048576).toFixed(1) + 'M';
        else h = (t / 1073741824).toFixed(2) + 'G';
        document.getElementById('cmUsageSize').textContent = h;
      }
    }).catch(() => {});
  }

  function _renderCacheList(movies) {
    const list = document.getElementById('cmList');
    const search = document.getElementById('cmSearchInput').value.toLowerCase().trim();
    _updateCacheStats();

    let filtered = movies;
    if (search) {
      filtered = movies.filter(m => {
        const title = (m.title || m.name || '').toLowerCase();
        return title.indexOf(search) !== -1;
      });
    }

    if (filtered.length === 0) {
      list.innerHTML = '<div class="empty-state" style="padding:30px"><div class="empty-icon"><svg class="icon-svg"><use href="#i-search"></use></svg></div><h3>Nenhum filme encontrado</h3></div>';
      return;
    }

    let html = '';
    filtered.forEach((m, idx) => {
      const title = (m.title || m.name || '').replace(/[._]/g, ' ');
      const nameClean = title.replace(/\.[^.]+$/, '');
      const isLocal = isLocalPath(m.path);
      const isCached = m.cached;
      const isDownloading = !isLocal && _cmDownloading.has(m.path);
      const statusClass = isLocal ? 'cached' : (isDownloading ? 'downloading' : (isCached ? 'cached' : 'uncached'));
      let statusLabel = isLocal
        ? '<svg class="icon-svg"><use href="#i-hard-drive"></use></svg> Local'
        : (isDownloading ? '<svg class="icon-svg"><use href="#i-download"></use></svg> 0%' : (isCached ? '<svg class="icon-svg"><use href="#i-download"></use></svg> Offline' : '<svg class="icon-svg"><use href="#i-cloud"></use></svg> Online'));
      // Reuse cached progress from download tracker if available
      if (isDownloading && _cmPcts && _cmPcts[m.path] !== undefined) {
        statusLabel = '<svg class="icon-svg"><use href="#i-download"></use></svg> ' + _cmPcts[m.path] + '%';
      }

      html += '<div class="cache-item" data-path="' + m.path + '">';

      // Poster thumbnail
      if (m.poster) {
        html += '<img class="cache-item-poster" src="' + posterUrl(m.path, m.poster) + '" alt="" onerror="this.outerHTML=\'<div class=cache-item-poster><svg class=\'icon-svg\'><use href=\'#i-film\'></use></svg></div>\'">';
      } else {
        html += '<div class="cache-item-poster"><svg class="icon-svg"><use href="#i-film"></use></svg></div>';
      }

      html += '<div class="cache-item-title" title="' + escHtml(nameClean) + '">' + escHtml(nameClean) + '</div>';
      html += '<span class="cache-item-status ' + statusClass + '" id="cmStatus-' + idx + '">' + statusLabel + '</span>';

      if (isLocal) {
        // Ja esta no disco do usuario: nao ha o que baixar, e apagar aqui
        // significaria mexer no arquivo dele.
        html += '<button class="cache-item-btn" disabled style="opacity:0.4" title="Filme numa fonte local — sempre disponivel"><svg class="icon-svg"><use href="#i-check"></use></svg></button>';
      } else if (isDownloading) {
        html += '<button class="cache-item-btn" disabled style="opacity:0.4"><svg class="icon-svg"><use href="#i-clock"></use></svg></button>';
      } else if (isCached) {
        html += '<button class="cache-item-btn delete" onclick="_cmDeleteCache(\'' + enc(m.path) + '\', ' + idx + ')"><svg class="icon-svg"><use href="#i-trash"></use></svg> Apagar</button>';
      } else {
        html += '<button class="cache-item-btn download" onclick="_cmDownload(\'' + enc(m.path) + '\', ' + idx + ')"><svg class="icon-svg"><use href="#i-download"></use></svg> Baixar</button>';
      }

      html += '</div>';
    });
    list.innerHTML = html;
  }

  let _cmPcts = {};  // folder_path -> percent (shared across renders)

  function filterCacheList() {
    _renderCacheList(_cmMovies);
  }

  async function _cmDownload(encodedPath, idx) {
    const folderPath = decodeURIComponent(encodedPath);
    _cmDownloading.add(folderPath);

    // Update UI immediately
    const statusEl = document.getElementById('cmStatus-' + idx);
    if (statusEl) {
      statusEl.className = 'cache-item-status downloading';
      statusEl.innerHTML = '<svg class="icon-svg"><use href="#i-download"></use></svg> 0%';
    }
    const btn = statusEl ? statusEl.nextElementSibling : null;
    if (btn) {
      btn.outerHTML = '<button class="cache-item-btn" disabled style="opacity:0.4"><svg class="icon-svg"><use href="#i-clock"></use></svg></button>';
    }

    showToast('📥 Baixando ' + (folderPath.split('/').pop() || 'filme') + '...', '');

    try {
      const res = await fetch('/api/cache-download?path=' + encodeURIComponent(folderPath), { method: 'POST' });
      const data = await res.json();
      if (data.status === 'already_cached') {
        _cmDownloading.delete(folderPath);
        const local = _cmMovies.find(m => m.path === folderPath);
        if (local) local.cached = true;
        _renderCacheList(_cmMovies);
        showToast('📥 Filme já estava em cache', 'success');
        return;
      }
      if (data.status !== 'started') {
        _cmDownloading.delete(folderPath);
        _renderCacheList(_cmMovies);
        showToast('Erro: ' + (data.error || 'desconhecido'), 'error');
        return;
      }

      // Store video path for progress polling
      const videoPath = data.path;
      _cmVideoPaths[folderPath] = videoPath;
      showToast('📥 Download iniciado em segundo plano', 'info');

      // Poll progress
      _cmPcts[folderPath] = 0;
      let attempts = 0;
      _cmPollTimers[folderPath] = setInterval(async () => {
        attempts++;
        try {
          const pRes = await fetch('/api/cache-download-progress?path=' + encodeURIComponent(videoPath));
          const prog = await pRes.json();

          if (prog.status === 'done' || prog.percent >= 100) {
            // Complete!
            clearInterval(_cmPollTimers[folderPath]);
            delete _cmPollTimers[folderPath];
            _cmDownloading.delete(folderPath);
            delete _cmPcts[folderPath];
            // Update local data
            const local = _cmMovies.find(m => m.path === folderPath);
            if (local) local.cached = true;
            _markCached(folderPath);
            _renderCacheList(_cmMovies);
            // Refresh offline section on home and cache usage
            _renderOfflineGrid();
            _invalidateCache('/api/cache-status');
            updateCacheUsage();
            showToast('✅ ' + (folderPath.split('/').pop() || 'Filme') + ' está offline!', 'success');
            return;
          }

          if (prog.status === 'error') {
            clearInterval(_cmPollTimers[folderPath]);
            delete _cmPollTimers[folderPath];
            _cmDownloading.delete(folderPath);
            delete _cmPcts[folderPath];
            _renderCacheList(_cmMovies);
            showToast('❌ Erro no download', 'error');
            return;
          }

          // Update progress percentage on tag
          if (prog.percent !== undefined) {
            _cmPcts[folderPath] = prog.percent;
            const stEl = document.getElementById('cmStatus-' + idx);
            if (stEl) {
              stEl.innerHTML = '<svg class="icon-svg"><use href="#i-download"></use></svg> ' + prog.percent + '%';
            }
          }
        } catch(e) {}

        // Timeout after 5 min
        if (attempts > 300) {
          clearInterval(_cmPollTimers[folderPath]);
          delete _cmPollTimers[folderPath];
          _cmDownloading.delete(folderPath);
          delete _cmPcts[folderPath];
          _renderCacheList(_cmMovies);
        }
      }, 1000);
    } catch(e) {
      _cmDownloading.delete(folderPath);
      delete _cmPcts[folderPath];
      _renderCacheList(_cmMovies);
      showToast('Erro ao iniciar download: ' + e.message, 'error');
    }
  }

  async function _cmDeleteCache(encodedPath, idx) {
    const path = decodeURIComponent(encodedPath);
    showToast('🗑 Removendo cache de ' + (path.split('/').pop() || 'filme') + '...', '');
    try {
      const res = await fetch('/api/uncache?path=' + encodeURIComponent(path), { method: 'POST' });
      const data = await res.json();
      if (data.status === 'ok') {
        // Update local data
        const local = _cmMovies.find(m => m.path === path);
        if (local) local.cached = false;
        _renderCacheList(_cmMovies);

        // Also update _cachedSet in localStorage
        _cachedSet.delete(path);
        localStorage.setItem('media_server_cached', JSON.stringify([..._cachedSet]));
        // Re-render offline grid on home if visible
        _renderOfflineGrid();

        showToast('🗑 Cache removido com sucesso!', 'success');
      } else {
        showToast('Erro: ' + (data.error || 'falha ao remover'), 'error');
      }
    } catch(e) {
      showToast('Erro ao remover cache: ' + e.message, 'error');
    }
    updateCacheUsage();
  }

  // ==================== BACKUP MODAL ====================
  function openBackupModal() {
    document.getElementById('backupModal').classList.add('active');
    document.body.style.overflow = 'hidden';
  }
  function closeBackupModal() {
    document.getElementById('backupModal').classList.remove('active');
    document.body.style.overflow = '';
  }
  document.getElementById('backupModal').addEventListener('click', function(e) {
    if (e.target === this) closeBackupModal();
  });

  // ==================== RCLONE MODAL ====================
  function openRcloneModal() {
    document.getElementById('rcloneModal').classList.add('active');
    document.body.style.overflow = 'hidden';
    _loadRcloneStatus();
  }
  function closeRcloneModal() {
    document.getElementById('rcloneModal').classList.remove('active');
    document.body.style.overflow = '';
  }
  document.getElementById('rcloneModal').addEventListener('click', function(e) {
    if (e.target === this) closeRcloneModal();
  });

