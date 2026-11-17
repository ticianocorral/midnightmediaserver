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
        const el = document.getElementById('cacheUsageSize'); if (el) el.textContent = '0B';
        // O botao agora fica dentro do gerenciador: se ele estiver aberto,
        // a lista precisa refletir que nada esta mais baixado.
        if (document.getElementById('cacheManagerModal').classList.contains('active')) {
          _cmRecarregar();
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
      html += '<div class="movie-card"' + attrAcao('showMovieInfo', [path, {$: 'event'}]) + ' title="' + escHtml(name) + '">'
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

  // ==================== DOWNLOADS OFFLINE (modal) ====================
  // Filmes e séries da nuvem. Quem baixa é o servidor, numa fila de um arquivo
  // por vez (ver mediaserver/cachefila.py): a janela só mostra o estado e pode
  // ser fechada e reaberta sem perder o andamento.
  const _cm = { aba: 'filmes', filtro: 'todos', filmes: [], series: [], det: {}, abertas: {},
                fila: { itens: [], ativos: 0, total: 0, baixado: 0, feitos: 0, erros: 0 },
                timer: null, oculta: false, ultimosFeitos: 0 };
  let _cmMovies = _cm.filmes;     // clearCache() ainda marca estes como "online"

  const _np = p => String(p || '').split('/').filter(Boolean).join('/');
  const _gb = n => n >= 1073741824 ? (n / 1073741824).toFixed(1).replace('.', ',') + ' GB'
    : (n >= 1048576 ? Math.round(n / 1048576) + ' MB' : (n > 0 ? Math.round(n / 1024) + ' KB' : '—'));
  const _cmPost = (url, params) => fetch(url + '?' + params, { method: 'POST' }).then(r => r.json());

  function openCacheManager() {
    document.getElementById('cacheManagerModal').classList.add('active');
    document.body.style.overflow = 'hidden';
    _cm.oculta = false;
    _syncCachedFromServer().then(() => _cmRecarregar(true));
    _cmPollFila();
    _cm.timer = setInterval(_cmPollFila, 1000);
  }

  function closeCacheManager() {
    document.getElementById('cacheManagerModal').classList.remove('active');
    document.body.style.overflow = '';
    clearInterval(_cm.timer);
    _cm.timer = null;
  }

  document.getElementById('cacheManagerModal').addEventListener('click', function(e) {
    if (e.target === this) closeCacheManager();
  });

  // Estado de um arquivo: baixando/na fila (pela fila do servidor), offline ou online.
  function _cmEstado(np, cached) {
    const it = _cm.fila.itens.find(i => i.path === np && (i.status === 'queued' || i.status === 'downloading'));
    if (it) return { tipo: it.status === 'queued' ? 'fila' : 'baixando', pct: it.percent || 0 };
    return { tipo: cached ? 'offline' : 'online', pct: 0 };
  }

  function _cmChip(est) {
    const ic = n => '<svg class="icon-svg"><use href="#i-' + n + '"></use></svg> ';
    if (est.tipo === 'baixando') return '<span class="cache-item-status downloading" data-cmpct="1">' + ic('download') + est.pct + '%</span>';
    if (est.tipo === 'fila') return '<span class="cache-item-status downloading">' + ic('clock') + 'Na fila</span>';
    if (est.tipo === 'offline') return '<span class="cache-item-status cached">' + ic('download') + 'Offline</span>';
    return '<span class="cache-item-status uncached">' + ic('cloud') + 'Online</span>';
  }

  const _cmBarra = (np, est) => '<div class="cm-barra"' + (est.tipo === 'baixando' ? '' : ' style="display:none"')
    + ' data-cmbar="' + escHtml(np) + '"><span style="width:' + est.pct + '%"></span></div>';

  async function _cmRecarregar(primeira) {
    const list = document.getElementById('cmList');
    if (primeira) list.innerHTML = '<div class="loading" style="min-height:100px"><div class="spinner"></div><span>Carregando...</span></div>';
    try {
      const [filmes, series] = await Promise.all([
        fetch('/api/cache-manager').then(r => r.json()),
        fetch('/api/cache-series').then(r => r.json()),
      ]);
      _cm.filmes = Array.isArray(filmes) ? filmes : [];
      _cmMovies = _cm.filmes;
      _cm.series = Array.isArray(series) ? series : [];
      // séries abertas relêem os episódios (o estado offline mudou)
      await Promise.all(Object.keys(_cm.abertas).filter(k => _cm.abertas[k] === true && !k.includes('|')).map(k =>
        fetch('/api/cache-serie?path=' + encodeURIComponent(k)).then(r => r.json()).then(d => { _cm.det[k] = d; })));
      _renderCacheList();
    } catch (e) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg class="icon-svg"><use href="#i-error"></use></svg></div><h3>Erro ao carregar</h3></div>';
    }
  }

  function _updateCacheStats() {
    const lista = _cm.aba === 'filmes' ? _cm.filmes.filter(m => !isLocalPath(m.path)) : _cm.series;
    document.getElementById('cmTotalMovies').textContent = lista.length;
    document.getElementById('cmCachedMovies').textContent =
      _cm.aba === 'filmes' ? lista.filter(m => m.cached).length : lista.filter(s => s.offline > 0).length;
    document.getElementById('cmStatTotalRot').textContent = _cm.aba === 'filmes' ? 'Filmes na nuvem' : 'Séries na nuvem';
    document.getElementById('cmStatOffRot').textContent = _cm.aba === 'filmes' ? 'Offline' : 'Com episódios offline';
    fetch('/api/cache-status').then(r => r.json()).then(st => {
      if (st && st.usage) document.getElementById('cmUsageSize').textContent = _gb(st.usage.total);
    }).catch(() => {});
  }

  function _cmAba(aba) { _cm.aba = aba; _cm.filtro = 'todos'; _renderCacheList(); }
  function _cmFiltro(f) { _cm.filtro = f; _renderCacheList(); }
  function filterCacheList() { _renderCacheList(); }

  function _cmCabecalho(itens, estadoDe) {
    // abas, filtros com contagem e o botão de baixar em lote
    const conta = { todos: itens.length, offline: 0, online: 0 };
    itens.forEach(i => { estadoDe(i) ? conta.offline++ : conta.online++; });
    const chip = (id, rot) => '<button class="serie-temp' + (_cm.filtro === id ? ' on' : '') + '"' + attrAcao('_cmFiltro', [id]) + '>'
      + rot + '<small>' + conta[id] + '</small></button>';
    return '<div class="serie-temps serie-faixas" style="padding-bottom:6px">'
      + chip('todos', 'Todos') + chip('offline', 'Offline') + chip('online', 'Online') + '</div>';
  }

  function _renderCacheList() {
    document.getElementById('cmAbaFilmes').classList.toggle('on', _cm.aba === 'filmes');
    document.getElementById('cmAbaSeries').classList.toggle('on', _cm.aba === 'series');
    document.getElementById('cmSearchInput').placeholder = _cm.aba === 'filmes' ? 'Filtrar filmes...' : 'Filtrar séries...';
    _updateCacheStats();
    _cmDesenharFila();
    document.getElementById('cmList').innerHTML = _cm.aba === 'filmes' ? _cmListaFilmes() : _cmListaSeries();
  }

  // ----- Filmes -----
  function _cmListaFilmes() {
    const busca = document.getElementById('cmSearchInput').value.toLowerCase().trim();
    const nuvem = _cm.filmes.filter(m => !isLocalPath(m.path));
    const locais = _cm.filmes.length - nuvem.length;
    if (!nuvem.length) {
      return '<div class="empty-state" style="padding:30px"><div class="empty-icon"><svg class="icon-svg"><use href="#i-cloud"></use></svg></div>'
        + '<h3>Nenhum filme na nuvem</h3><p>' + (locais ? 'Os filmes das fontes locais já estão no disco: não há o que baixar.' : 'Conecte a nuvem e escaneie as fontes.') + '</p></div>';
    }
    let itens = nuvem.filter(m => !busca || (m.title || m.name || '').toLowerCase().indexOf(busca) !== -1);
    const cab = _cmCabecalho(itens, m => m.cached);
    if (_cm.filtro !== 'todos') itens = itens.filter(m => (_cm.filtro === 'offline') === !!m.cached);
    const faltam = itens.filter(m => !m.cached && !_cm.fila.itens.some(i => i.path === _np(m.video) && (i.status === 'queued' || i.status === 'downloading')));
    let html = cab;
    if (faltam.length > 1) {
      html += '<div class="cm-lote"><button class="rclone-action-btn"' + attrAcao('_cmBaixarLote', [faltam.map(m => m.path)]) + '>'
        + '<svg class="icon-svg"><use href="#i-download"></use></svg> Baixar ' + faltam.length + ' filmes · '
        + _gb(faltam.reduce((n, m) => n + (m.size || 0), 0)) + '</button></div>';
    }
    if (!itens.length) return html + '<div class="empty-state" style="padding:30px"><h3>Nenhum filme encontrado</h3></div>';
    return html + itens.map(m => {
      const nome = (m.title || m.name || '').replace(/[._]/g, ' ').replace(/\.[^.]+$/, '');
      const np = _np(m.video);
      const est = _cmEstado(np, m.cached);
      const botao = (est.tipo === 'baixando' || est.tipo === 'fila')
        ? '<button class="cache-item-btn"' + attrAcao('_cmCancelar', [m.video]) + '>Cancelar</button>'
        : (m.cached
            ? '<button class="cache-item-btn delete"' + attrAcao('_cmDeleteCache', [enc(m.path)]) + '><svg class="icon-svg"><use href="#i-trash"></use></svg> Apagar</button>'
            : '<button class="cache-item-btn download"' + attrAcao('_cmDownload', [enc(m.path)]) + '><svg class="icon-svg"><use href="#i-download"></use></svg> Baixar</button>');
      return '<div class="cache-item" data-path="' + escHtml(m.path) + '">'
        + (m.poster ? '<img class="cache-item-poster" src="' + posterUrl(m.path, m.poster) + '" alt=""' + attrAcao('imgComoPosterDoCache', null, false, 'data-act-error') + '>'
                    : '<div class="cache-item-poster"><svg class="icon-svg"><use href="#i-film"></use></svg></div>')
        + '<div class="cache-item-info"><div class="cache-item-title" title="' + escHtml(nome) + '">' + escHtml(nome) + '</div>'
        + '<div class="cache-item-sub"><span>' + _gb(m.size || 0) + '</span>' + _cmChip(est) + '</div>' + _cmBarra(np, est) + '</div>'
        + botao + '</div>';
    }).join('');
  }

  // ----- Séries -----
  function _cmListaSeries() {
    const busca = document.getElementById('cmSearchInput').value.toLowerCase().trim();
    if (!_cm.series.length) {
      return '<div class="empty-state" style="padding:30px"><div class="empty-icon"><svg class="icon-svg"><use href="#i-tv"></use></svg></div>'
        + '<h3>Nenhuma série na nuvem</h3><p>Séries de fontes locais já estão no disco.</p></div>';
    }
    let itens = _cm.series.filter(s => !busca || (s.title || '').toLowerCase().indexOf(busca) !== -1);
    const cab = _cmCabecalho(itens, s => s.offline > 0 && s.offline >= s.episodios);
    if (_cm.filtro === 'offline') itens = itens.filter(s => s.offline > 0);
    else if (_cm.filtro === 'online') itens = itens.filter(s => s.offline < s.episodios);
    if (!itens.length) return cab + '<div class="empty-state" style="padding:30px"><h3>Nenhuma série encontrada</h3></div>';
    return cab + itens.map(s => {
      const aberta = _cm.abertas[s.path] === true;
      const pct = s.episodios ? Math.round(s.offline * 100 / s.episodios) : 0;
      const naFila = _cm.fila.itens.some(i => (i.status === 'queued' || i.status === 'downloading') && i.grupo.indexOf(s.title + ' · ') === 0);
      return '<div class="cache-serie">'
        + '<div class="cache-item">'
        + (s.poster ? '<img class="cache-item-poster" src="' + capaUrl(s.poster) + '" alt=""' + attrAcao('imgComoPosterDoCache', null, false, 'data-act-error') + '>'
                    : '<div class="cache-item-poster"><svg class="icon-svg"><use href="#i-tv"></use></svg></div>')
        + '<div class="cache-item-info"><div class="cache-item-title" title="' + escHtml(s.title) + '">' + escHtml(s.title) + '</div>'
        + '<div class="cache-item-sub"><span>' + s.offline + ' de ' + s.episodios + ' episódios offline · ' + _gb(s.size) + '</span>'
        + (naFila ? '<span class="cache-item-status downloading"><svg class="icon-svg"><use href="#i-download"></use></svg> Baixando</span>'
                  : (pct === 100 ? '<span class="cache-item-status cached">Offline</span>' : '')) + '</div>'
        + '<div class="cm-barra cm-barra-fixa"><span style="width:' + pct + '%"></span></div></div>'
        + (s.offline < s.episodios ? '<button class="cache-item-btn download"' + attrAcao('_cmBaixarSerie', [s.path, null]) + '><svg class="icon-svg"><use href="#i-download"></use></svg> Tudo</button>' : '')
        + '<button class="cache-item-btn"' + attrAcao('_cmAbrirSerie', [s.path]) + ' title="Temporadas e episódios">' + (aberta ? '▴' : '▾ Episódios') + '</button>'
        + '</div>'
        + (aberta ? _cmDetalheSerie(s) : '') + '</div>';
    }).join('');
  }

  function _cmDetalheSerie(s) {
    const det = _cm.det[s.path];
    if (!det) return '<div class="loading" style="min-height:50px"><div class="spinner"></div></div>';
    return '<div class="cache-serie-det">' + det.temporadas.map(t => {
      const off = t.episodios.filter(e => e.cached).length;
      const chave = s.path + '|' + t.nome;
      const aberta = _cm.abertas[chave] === true;
      const tam = t.episodios.reduce((n, e) => n + (e.size || 0), 0);
      return '<div class="cache-temp"><div class="cache-temp-cab">'
        + '<button class="cache-temp-nome"' + attrAcao('_cmAbrirTemporada', [chave]) + '>' + (aberta ? '▾ ' : '▸ ') + escHtml(_nomeTemporada(t.nome))
        + ' <small>' + off + '/' + t.episodios.length + ' · ' + _gb(tam) + '</small></button>'
        + (off < t.episodios.length ? '<button class="cache-item-btn download"' + attrAcao('_cmBaixarSerie', [s.path, t.nome]) + '><svg class="icon-svg"><use href="#i-download"></use></svg> Temporada</button>' : '')
        + (off > 0 ? '<button class="cache-item-btn delete"' + attrAcao('_cmApagarSerie', [s.path, t.nome]) + '><svg class="icon-svg"><use href="#i-trash"></use></svg></button>' : '')
        + '</div>'
        + (aberta ? t.episodios.map(e => {
            const np = _np(e.path), est = _cmEstado(np, e.cached);
            const btn = (est.tipo === 'baixando' || est.tipo === 'fila')
              ? '<button class="cache-item-btn"' + attrAcao('_cmCancelar', [e.path]) + '>Cancelar</button>'
              : (e.cached
                  ? '<button class="cache-item-btn delete"' + attrAcao('_cmApagarArquivo', [e.path]) + '><svg class="icon-svg"><use href="#i-trash"></use></svg></button>'
                  : '<button class="cache-item-btn download"' + attrAcao('_cmBaixarArquivo', [e.path]) + '><svg class="icon-svg"><use href="#i-download"></use></svg></button>');
            return '<div class="cache-item cache-ep"><div class="cache-item-info"><div class="cache-item-title" title="' + escHtml(_tituloEp(e)) + '">'
              + escHtml(_tituloEp(e)) + '</div><div class="cache-item-sub"><span>' + _gb(e.size || 0) + '</span>' + _cmChip(est) + '</div>' + _cmBarra(np, est) + '</div>' + btn + '</div>';
          }).join('') : '')
        + '</div>';
    }).join('') + '</div>';
  }

  function _cmAbrirSerie(path) {
    _cm.abertas[path] = !_cm.abertas[path];
    if (_cm.abertas[path] && !_cm.det[path]) {
      fetch('/api/cache-serie?path=' + encodeURIComponent(path)).then(r => r.json()).then(d => { _cm.det[path] = d; _renderCacheList(); });
    }
    _renderCacheList();
  }
  function _cmAbrirTemporada(chave) { _cm.abertas[chave] = !_cm.abertas[chave]; _renderCacheList(); }

  // ----- Ações: tudo entra na fila do servidor -----
  async function _cmEnfileirar(params, rotulo) {
    try {
      const d = await _cmPost('/api/cache-fila-add', params);
      if (d.status !== 'ok') { showToast('Erro: ' + (d.error || 'não foi possível baixar'), 'error'); return; }
      showToast(d.added ? '📥 ' + rotulo(d.added) + ' na fila (' + _gb(d.bytes) + ')' : 'Já está offline ou na fila', d.added ? 'info' : '');
      _cm.oculta = false;
      _cmPollFila();
    } catch (e) { showToast('Erro: ' + e.message, 'error'); }
  }
  const _eps = n => n + (n === 1 ? ' item' : ' itens');

  function _cmDownload(encPath) { _cmEnfileirar('path=' + encodeURIComponent(decodeURIComponent(encPath)), _eps); }
  function _cmBaixarLote(paths) {
    if (!window.confirm('Baixar ' + paths.length + ' filmes para o cache offline?')) return;
    _cmEnfileirar(paths.map(p => 'path=' + encodeURIComponent(p)).join('&'), _eps);
  }
  function _cmBaixarSerie(serie, temporada) {
    _cmEnfileirar('serie=' + encodeURIComponent(serie) + (temporada ? '&temporada=' + encodeURIComponent(temporada) : ''),
      n => n + (n === 1 ? ' episódio' : ' episódios'));
  }
  function _cmBaixarArquivo(file) { _cmEnfileirar('file=' + encodeURIComponent(file), _eps); }
  function _cmCancelar(file) { _cmPost('/api/cache-fila-cancelar', 'path=' + encodeURIComponent(file)).then(_cmPollFila); }
  function _cmCancelarFila() { _cmPost('/api/cache-fila-cancelar', '').then(() => { showToast('Downloads cancelados', ''); _cmPollFila(); }); }

  async function _cmApagar(params, aviso) {
    try {
      await _cmPost('/api/uncache-arquivos', params);
      showToast('🗑 ' + aviso, 'success');
    } catch (e) { showToast('Erro ao remover: ' + e.message, 'error'); }
    _cm.filmes.forEach(m => { /* o estado real volta do servidor */ });
    _syncCachedFromServer();
    _renderOfflineGrid();
    updateCacheUsage();
    _cmRecarregar();
  }
  function _cmDeleteCache(encPath) { _cmApagar('path=' + encodeURIComponent(decodeURIComponent(encPath)), 'Filme removido do offline'); }
  function _cmApagarArquivo(file) { _cmApagar('file=' + encodeURIComponent(file), 'Episódio removido do offline'); }
  function _cmApagarSerie(serie, temporada) {
    if (!window.confirm('Tirar ' + (temporada ? _nomeTemporada(temporada) : 'a série inteira') + ' do offline? Continua na nuvem.')) return;
    _cmApagar('serie=' + encodeURIComponent(serie) + (temporada ? '&temporada=' + encodeURIComponent(temporada) : ''), 'Removido do offline');
  }

  // ----- Fila: painel no topo e andamento nas linhas -----
  async function _cmPollFila() {
    let f;
    try { f = await fetch('/api/cache-fila').then(r => r.json()); } catch (e) { return; }
    if (!f || !Array.isArray(f.itens)) return;
    const mudou = f.feitos !== _cm.ultimosFeitos || (_cm.fila.ativos > 0 && f.ativos === 0)
      || f.itens.length !== _cm.fila.itens.length
      || f.itens.some(i => { const a = _cm.fila.itens.find(x => x.path === i.path); return !a || a.status !== i.status; });
    const concluiu = f.feitos > _cm.ultimosFeitos || (_cm.fila.ativos > 0 && f.ativos === 0);
    _cm.ultimosFeitos = f.feitos;
    _cm.fila = f;
    if (!document.getElementById('cacheManagerModal').classList.contains('active')) return;
    _cmDesenharFila();
    if (concluiu) {
      _invalidateCache('/api/cache-status');
      _syncCachedFromServer().then(() => { _renderOfflineGrid(); updateCacheUsage(); });
      _cmRecarregar();
    } else if (mudou) {
      _renderCacheList();
    }
    // só o andamento: sem redesenhar a lista (não perde rolagem nem foco)
    const porPath = {};
    f.itens.forEach(i => { porPath[i.path] = i; });
    document.querySelectorAll('[data-cmbar]').forEach(b => {
      const i = porPath[b.getAttribute('data-cmbar')];
      if (i) {
        b.style.display = i.status === 'downloading' ? '' : 'none';
        b.firstElementChild.style.width = (i.percent || 0) + '%';
        const chip = b.previousElementSibling && b.previousElementSibling.querySelector('[data-cmpct]');
        if (chip) chip.lastChild.textContent = (i.percent || 0) + '%';
      }
    });
  }

  function _cmDesenharFila() {
    const el = document.getElementById('cmFila');
    const f = _cm.fila;
    if (f.ativos === 0 && (_cm.oculta || (!f.feitos && !f.erros))) { el.style.display = 'none'; return; }
    el.style.display = '';
    const atual = f.itens.find(i => i.status === 'downloading') || f.itens.find(i => i.status === 'queued');
    const pct = f.total > 0 ? Math.min(100, Math.round(f.baixado * 100 / f.total)) : 0;
    if (f.ativos > 0) {
      const n = f.feitos + 1;
      el.innerHTML = '<div class="cm-fila-topo"><b>Baixando ' + n + ' de ' + f.itens.filter(i => i.status !== 'cancelled').length + '</b>'
        + '<span>' + escHtml(atual ? (atual.grupo ? atual.grupo + ' — ' : '') + _tituloEp({ title: atual.titulo }) : '') + '</span>'
        + '<button class="cache-item-btn" data-act="_cmCancelarFila">Cancelar tudo</button></div>'
        + '<div class="cm-barra cm-barra-grande"><span style="width:' + pct + '%"></span></div>'
        + '<div class="cm-fila-sub">' + pct + '% · ' + _gb(f.baixado) + ' de ' + _gb(f.total)
        + (f.erros ? ' · <span style="color:#ef9a9a">' + f.erros + ' com erro</span>' : '') + '</div>';
    } else {
      el.innerHTML = '<div class="cm-fila-topo"><b>' + (f.erros ? '⚠ ' + f.feitos + ' baixados, ' + f.erros + ' com erro' : '✓ ' + f.feitos + (f.feitos === 1 ? ' item offline' : ' itens offline'))
        + '</b><span></span><button class="cache-item-btn" data-act="_cmOcultarFila">Fechar</button></div>';
    }
  }
  function _cmOcultarFila() { _cm.oculta = true; _cmDesenharFila(); }

  // Botão "Baixar temporada" da tela da série (nuvem). Vai para a mesma fila.
  function _serieBaixarTemporada(serie, temporada) {
    _cmPost('/api/cache-fila-add', 'serie=' + encodeURIComponent(serie) + '&temporada=' + encodeURIComponent(temporada)).then(d => {
      if (d.status !== 'ok') showToast('Erro: ' + (d.error || 'não foi possível baixar'), 'error');
      else showToast(d.added ? '📥 ' + d.added + ' episódios na fila (' + _gb(d.bytes) + ') — acompanhe em Downloads offline' : 'A temporada já está offline ou na fila', d.added ? 'info' : '');
    }).catch(() => showToast('Erro ao baixar', 'error'));
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

