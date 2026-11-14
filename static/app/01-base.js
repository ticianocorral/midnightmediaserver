// Sessao expirada: qualquer chamada que volte 401 leva de volta ao login.
  (function () {
    var _fetch = window.fetch;
    window.fetch = function () {
      return _fetch.apply(this, arguments).then(function (res) {
        if (res.status === 401 && window.location.pathname !== '/login') {
          window.location.replace('/login');
        }
        return res;
      });
    };
  })();

  // Atributos de uma acao de clique: no lugar de onclick="fn('...')" (JS inline, que
  // exige tratar aspas dentro de aspas e impede uma CSP), o elemento leva o NOME da
  // acao e os argumentos em JSON. Valores crus: nao ha enc()/decodeURIComponent.
  // {$:'this'} / {$:'event'} passam o elemento / o evento; parar=true faz
  // event.stopPropagation() antes de chamar. Quem executa e o despachante em 12-acoes.js.
  // Nao usa escHtml (definida em 07-ajustes.js): codigo que roda na CARGA de uma parte
  // anterior (ex.: 06-cast.js) ja chama attrAcao, e funcoes de partes posteriores ainda
  // nao existem. Num arquivo unico elas eram "icadas"; em partes separadas, nao.
  function attrAcao(nome, args, parar, evento) {
    return ' ' + (evento || 'data-act') + '="' + nome + '"'
      + (args && args.length
        ? ' data-args="' + JSON.stringify(args).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;') + '"'
        : '')
      + (parar ? ' data-stop="1"' : '');
  }

  // ==================== STATE ====================
  let currentPath = "";

  // History navigation support
  window.addEventListener('popstate', function(e) {
    const path = (e.state && e.state.path) || '';
    // Close movie info overlay if open
    const overlay = document.getElementById('movieInfoOverlay');
    if (overlay && overlay.classList.contains('active')) {
      closeMovieInfo();
    }
    // Always load, even if same path (handles initial pop)
    loadPathInternal(path);
  });

  // ==================== API ====================
  async function apiFetch(endpoint) {
    try {
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.error("API error:", e);
      return null;
    }
  }

  function streamUrl(filePath) {
    return '/api/stream?path=' + encodeURIComponent(filePath);
  }

  // Capa já com caminho completo (mesmo "&i=2" de posterUrl).
  function capaUrl(filePath) {
    return streamUrl(filePath) + '&i=2';
  }

  function posterUrl(folderPath, imageName) {
    if (!imageName) return null;
    // Algumas APIs (séries, coleções) já entregam o caminho completo da
    // imagem; colar de novo virava ".../Série//Local/.../poster.jpg" (404).
    // Nome de arquivo nunca tem "/" — a barra é o sinal de caminho pronto.
    const fullPath = imageName.indexOf('/') === -1
      ? folderPath + '/' + imageName
      : imageName;
    // "&i=2": endereço novo para as capas. As antigas ficaram no cache do
    // navegador por 1 dia; agora o servidor manda revalidar (ETag) a cada uso.
    return '/api/stream?path=' + encodeURIComponent(fullPath) + '&i=2';
  }

  // ==================== FORMAT ====================
  function formatSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return size.toFixed(1) + ' ' + units[i];
  }

  function formatDate(t) {
    if (!t) return '';
    const d = new Date(t);
    return d.toLocaleDateString('pt-BR');
  }

  function fileIcon(name) {
    return '<svg class="icon-svg"><use href="#i-film"></use></svg>';
  }

  // ==================== SIMPLE FRONTEND CACHE ====================
  let _frontCache = {};
  const _CACHE_TTL = 120000; // 2 min
  const _CACHE_ERROR_TTL = 5000; // 5s for error responses

  function _invalidateCache(url) {
    delete _frontCache[url];
  }

  function cachedFetch(url) {
    const now = Date.now();
    const entry = _frontCache[url];
    if (entry && (now - entry.time) < _CACHE_TTL) {
      return Promise.resolve(entry.data);
    }
    return apiFetch(url).then(data => {
      // Don't cache null/error responses for the full TTL — use shorter error TTL
      if (data === null) {
        _frontCache[url] = { data, time: Date.now() - (_CACHE_TTL - _CACHE_ERROR_TTL) };
      } else {
        _frontCache[url] = { data, time: Date.now() };
      }
      return data;
    });
  }

  // Override apiFetch calls to use cache where possible
  // ==================== SEARCH ====================
  let _searchTimer = null;
  let _lastSearchQuery = null;

  function _updateSearchClear() {
    const clear = document.getElementById('searchClear');
    if (clear) clear.classList.toggle('show', document.getElementById('searchInput').value.length > 0);
  }

  // Busca ao vivo: debounce enquanto digita; Enter dispara na hora
  function onSearchInput() {
    clearTimeout(_searchTimer);
    _updateSearchClear();
    const q = document.getElementById('searchInput').value.trim();
    if (!q) { loadPath(''); return; }
    _searchTimer = setTimeout(search, 250);
  }

  function clearSearch() {
    clearTimeout(_searchTimer);
    const input = document.getElementById('searchInput');
    input.value = '';
    _updateSearchClear();
    _lastSearchQuery = null;
    loadPath('');
    input.focus();
  }

  function search() {
    const q = document.getElementById('searchInput').value.trim();
    if (!q) { loadPath(''); return; }
    _updateSearchClear();
    // Só mostra o loading quando o termo mudou (evita flicker ao refinar a busca)
    if (_lastSearchQuery !== q) {
      _lastSearchQuery = q;
      document.getElementById('content').innerHTML = '<div class="loading"><div class="spinner"></div><span>Pesquisando...</span></div>';
    }

    cachedFetch('/api/search?q=' + encodeURIComponent(q)).then(data => {
      if (!data || !data.results) {
        document.getElementById('content').innerHTML = '<div class="empty-state"><div class="empty-icon"><svg class="icon-svg"><use href="#i-frown"></use></svg></div><h3>Erro na pesquisa</h3></div>';
        return;
      }
      renderResults(data.results, q);
    });
  }

  function renderResults(results, query) {
    const container = document.getElementById('content');
    if (results.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><svg class="icon-svg"><use href="#i-search"></use></svg></div>
          <h3>Nenhum resultado encontrado</h3>
          <p>Tente outro termo de busca.</p>
        </div>
        <div class="genre-section">
          <div class="genre-header" data-act="loadPath" data-args="[&quot;&quot;]">
            <div class="genre-title"><span class="arrow"><svg class="icon-svg"><use href="#i-arrow-left"></use></svg></span> Voltar ao início</div>
          </div>
        </div>`;
      return;
    }

    let html = `<div class="genre-section">
      <div class="genre-header" style="cursor:default;border:none">
        <div class="genre-title"><svg class="icon-svg"><use href="#i-search"></use></svg> Resultados para "${escHtml(query)}" <span class="genre-count">(${results.length})</span></div>
      </div>
      <div class="movie-grid">`;

    results.forEach(item => {
      const name = item.Name || '';
      const filePath = item.Path ? '/' + item.Path : '';
      const posterSrc = item.poster ? posterUrl(filePath.replace(/\/[^/]*$/, ''), item.poster) : null;
      html += renderMovieCardHtml(name, filePath, item.Size, posterSrc, item.watched);
    });

    html += `</div></div>
      <div class="genre-section">
        <div class="genre-header" data-act="loadPath" data-args="[&quot;&quot;]">
          <div class="genre-title"><span class="arrow"><svg class="icon-svg"><use href="#i-arrow-left"></use></svg></span> Voltar ao início</div>
        </div>
      </div>`;

    container.innerHTML = html;
    document.getElementById('hero').style.display = 'none';
  }

  // ==================== GAVETA (celular) ====================
  // No celular a barra lateral sai do fluxo e vira gaveta; a barra superior
  // cuida do acesso. No desktop nada disso e usado — a barra fica fixa como
  // sempre esteve e estas funcoes nunca sao chamadas.
  function abrirGaveta(aberta) {
    const sb = document.getElementById('sidebar');
    const bd = document.getElementById('sidebarBackdrop');
    if (!sb) return;
    sb.classList.toggle('aberta', aberta);
    if (bd) bd.classList.toggle('ativo', aberta);
    // Trava a rolagem do fundo enquanto a gaveta cobre a tela.
    document.body.style.overflow = aberta ? 'hidden' : '';
  }

  function toggleSidebar() {
    const sb = document.getElementById('sidebar');
    abrirGaveta(!(sb && sb.classList.contains('aberta')));
  }

  function closeSidebar() { abrirGaveta(false); }

  function gavetaAberta() {
    const sb = document.getElementById('sidebar');
    return !!(sb && sb.classList.contains('aberta'));
  }

  // A lupa da barra superior: o campo de busca mora dentro da gaveta, entao
  // abrir uma coisa sem a outra deixaria o usuario sem caminho.
  function abrirBusca() {
    abrirGaveta(true);
    const campo = document.getElementById('searchInput');
    if (campo) setTimeout(function() { campo.focus(); }, 240);
  }

  // ==================== SIDEBAR ====================
  let _sidebarGenresLoaded = false;

  function sourceIcon(kind) {
    return kind === 'cloud'
      ? '<svg class="icon-svg"><use href="#i-cloud"></use></svg>'
      : '<svg class="icon-svg"><use href="#i-hard-drive"></use></svg>';
  }

  // Agrupa os generos pela fonte dona deles. O servidor manda o Path completo
  // de cada genero, entao nao ha prefixo remontado no cliente.
  // Marca no menu o item da tela atual. O HTML nasce com "Início" ativo, mas
  // quem manda é esta função: toda navegação passa por loadPathInternal ou
  // loadAZ, e eles redesenham a seleção — inclusive para tag, série e
  // coleção, que não são pastas.
  function _updateSidebarActive() {
    const atual = currentPath || '';
    document.querySelectorAll('#sidebarNav .sidebar-item[data-nav]').forEach(function (btn) {
      const alvo = btn.getAttribute('data-nav');
      let ativo = (alvo === atual);
      if (!ativo && alvo === 'home') ativo = isHomePage(atual);
      if (!ativo && alvo === 'series') ativo = atual.indexOf(SERIE_PREFIXO) === 0;
      if (!ativo && alvo === 'colecoes') ativo = atual.indexOf(COLECAO_PREFIXO) === 0;
      btn.classList.toggle('active', ativo);
    });
  }

  function toggleGeneros() {
    const t = document.querySelector('.sidebar-generos-toggle');
    const l = document.querySelector('.sidebar-generos-lista');
    if (!t || !l) return;
    const abrir = l.hidden;
    l.hidden = !abrir;
    t.classList.toggle('aberto', abrir);
    try { localStorage.setItem('generosAbertos', abrir ? '1' : '0'); } catch (e) {}
  }

  function filtrarGeneros(q) {
    q = (q || '').trim().toLowerCase();
    document.querySelectorAll('.sidebar-generos-lista .sidebar-item').forEach(function (b) {
      b.hidden = q && b.getAttribute('data-nome').indexOf(q) === -1;
    });
  }
  document.addEventListener('input', function (e) {
    if (e.target.classList && e.target.classList.contains('sidebar-generos-busca')) filtrarGeneros(e.target.value);
  });

  function loadSidebarGenres(force) {
    const container = document.getElementById('sidebarGenres');
    if (_sidebarGenresLoaded && !force) return;
    _sidebarGenresLoaded = true;
    // A barra lateral lista só as tags criadas na interface — gênero por
    // pasta deixou de existir. O "+" (admin) cria uma tag nova na hora.
    Promise.all([
      cachedFetch('/api/generos'),
      cachedFetch('/api/generos-nfo').catch(() => [])
    ]).then(([generos, generosNfo]) => {
      const isAdmin = _me && _me.role === 'admin';
      let html = '';
      html += '<div class="sidebar-source-label"><svg class="icon-svg">'
        + '<use href="#i-layers"></use></svg> Tags'
        + (isAdmin
            ? ' <button class="sidebar-genre-add" data-act="openGeneroNovoModal" title="Criar tag">+</button>'
            : '')
        + '</div>';
      (generos || []).forEach(g => {
        html += '<button class="sidebar-item" data-nav="' + GENERO_PREFIXO + g.id + '"' + attrAcao('loadPath', [GENERO_PREFIXO + g.id]) + '>'
          + '<span class="icon"><svg class="icon-svg"><use href="#i-layers"></use></svg></span> '
          + escHtml(g.nome) + '</button>';
      });
      if (!generos || !generos.length) {
        html += '<div class="sidebar-sem-genero">Use o <b>+</b> para criar tags '
          + 'e reunir filmes nelas.</div>';
      }
      // Gêneros do NFO: filtro automático, mas as tags é que importam — por
      // isso ficam DEPOIS delas, recolhidos, em lista rolável com busca.
      if (generosNfo && generosNfo.length) {
        const ativoNfo = (currentPath || '').indexOf(GENERO_NFO_PREFIXO) === 0;
        let aberto = ativoNfo;
        try { aberto = aberto || localStorage.getItem('generosAbertos') === '1'; } catch (e) {}
        html += '<button class="sidebar-source-label sidebar-generos-toggle' + (aberto ? ' aberto' : '') + '"'
          + attrAcao('toggleGeneros', []) + '><svg class="icon-svg"><use href="#i-film"></use></svg> Gêneros'
          + ' <span class="sidebar-conta">' + generosNfo.length + '</span>'
          + '<span class="sidebar-generos-seta">▾</span></button>'
          + '<div class="sidebar-generos-lista"' + (aberto ? '' : ' hidden') + '>';
        if (generosNfo.length > 8) {
          html += '<input type="search" class="sidebar-generos-busca" placeholder="Filtrar gêneros…"'
            + '>';
        }
        generosNfo.forEach(g => {
          html += '<button class="sidebar-item" data-nome="' + escHtml(g.nome.toLowerCase()) + '" data-nav="'
            + escHtml(GENERO_NFO_PREFIXO + encodeURIComponent(g.nome)) + '"'
            + attrAcao('loadPath', [GENERO_NFO_PREFIXO + encodeURIComponent(g.nome)]) + '>'
            + '<span class="icon"><svg class="icon-svg"><use href="#i-film"></use></svg></span> '
            + escHtml(g.nome) + ' <span class="sidebar-conta">' + g.total + '</span></button>';
        });
        html += '</div>';
      }
      container.innerHTML = html;
      _updateSidebarActive();
    }).catch(() => {
      container.innerHTML = '';
    });
  }

