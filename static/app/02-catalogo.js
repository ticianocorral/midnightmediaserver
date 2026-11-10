  // ==================== HOME / GENRE LIST ====================
  function loadPath(path, replace) {
    const s = history.state;
    if (path !== (s && s.path)) {
      if (replace) {
        // Mantem a query na URL: e por ?tv=1 que o modo de controle remoto
        // sobrevive a um recarregamento dentro do app da TV.
        history.replaceState({ path: path }, '', window.location.pathname + window.location.search);
      } else {
        history.pushState({ path: path }, '', window.location.pathname + window.location.search);
      }
    }
    loadPathInternal(path);
  }

  function loadPathInternal(path) {
    closeSidebar();
    currentPath = path;
    _updateSidebarActive();
    document.getElementById('content').innerHTML = '<div class="loading"><div class="spinner"></div><span>Carregando...</span></div>';
    document.getElementById('searchInput').value = '';
    _updateSearchClear();

    // Close any open info overlay
    closeMovieInfo();

    // Coleção não é uma pasta, mas entra pelo mesmo caminho de navegação
    // (pushState/popstate) — assim o botão Voltar do navegador funciona nela
    // igual funciona numa tag, sem um segundo mecanismo de histórico.
    if (path && path.indexOf(COLECAO_PREFIXO) === 0) {
      renderCollectionView(path.slice(COLECAO_PREFIXO.length));
      return;
    }
    if (path && path.indexOf(SERIE_PREFIXO) === 0) {
      renderSerieView(decodeURIComponent(path.slice(SERIE_PREFIXO.length)));
      return;
    }
    if (path === LISTA_SERIES) {
      renderSeriesList();
      return;
    }
    // A página A-Z não é uma pasta: o clique em "Filmes", o refresh depois do
    // scan e uma volta no histórico caem todos aqui.
    if (path === LISTA_FILMES) {
      loadAZ();
      return;
    }
    if (path === LISTA_COLECOES) {
      renderCollectionsList();
      return;
    }
    if (path && path.indexOf(GENERO_PREFIXO) === 0) {
      renderGeneroView(path.slice(GENERO_PREFIXO.length));
      return;
    }

    const isHome = isHomePage(path);
    const url = isHome ? '/api/genres' : ('/api/list?path=' + encodeURIComponent(path));

    cachedFetch(url).then(data => {
      if (!data) {
        document.getElementById('content').innerHTML = '<div class="empty-state"><div class="empty-icon"><svg class="icon-svg"><use href="#i-error"></use></svg></div><h3>Erro ao carregar</h3><p>Não foi possível conectar ao servidor.</p></div>';
        return;
      }
      // Guarda a listagem: ao tocar um episódio desta pasta, a transmissão
      // monta a fila com os vizinhos (ver _playlistDaPastaAberta).
      _pastaAtual = { path: data.path || '', videos: data.videos || [] };
      renderDirectory(data);
    });
  }

  // ==================== A-Z VIEW ====================
  function loadAZ() {
    currentPath = LISTA_FILMES;
    closeSidebar();
    _updateSidebarActive();
    document.getElementById('searchInput').value = '';
    _updateSearchClear();
    closeMovieInfo();
    // Mesmo cabeçalho das outras páginas (Séries, Coleções): o hero com
    // título e contagem, em vez de um título solto dentro do conteúdo.
    const hero = document.getElementById('hero');
    hero.style.display = 'block';
    _heroCapa(null, null);
    document.getElementById('breadcrumb').innerHTML = '';
    document.getElementById('heroBg').style.backgroundImage = 'none';
    hero.style.background = 'linear-gradient(135deg, var(--bg2) 0%, var(--surface) 100%)';
    document.getElementById('heroTitle').innerHTML =
      '<svg class="icon-svg"><use href="#i-sort"></use></svg> Filmes';
    document.getElementById('heroDesc').textContent = '';
    const container = document.getElementById('content');
    container.innerHTML = '<div class="loading"><div class="spinner"></div><span>Carregando filmes...</span></div>';
    // Invalidate cache so we always get fresh data
    _invalidateCache('/api/all-movies');
    cachedFetch('/api/all-movies').then(movies => {
      if (!movies || movies.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg class="icon-svg"><use href="#i-film"></use></svg></div><h3>Nenhum filme encontrado</h3></div>';
        return;
      }
      renderAZView(movies);
    });
  }

  function renderAZView(movies) {
    // Group by first letter
    const groups = {};
    movies.forEach(m => {
      const title = m.title || m.name || '';
      const letter = title.charAt(0).toUpperCase();
      if (!groups[letter]) groups[letter] = [];
      groups[letter].push(m);
    });

    const letters = Object.keys(groups).sort();

    document.getElementById('heroDesc').innerHTML =
      '<svg class="icon-svg"><use href="#i-sort"></use></svg> '
      + movies.length + (movies.length === 1 ? ' filme' : ' filmes');

    let html = '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:24px;padding:0 4px" id="azJump">';
    letters.forEach(l => {
      html += '<a href="javascript:;" onclick="document.getElementById(\'az-' + l + '\').scrollIntoView({behavior:\'smooth\'});return false" style="display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;background:var(--surface);border-radius:6px;text-decoration:none;font-weight:700;font-size:15px;color:var(--accent);transition:background .2s">' + l + '</a>';
    });
    html += '</div>';

    letters.forEach(l => {
      const items = groups[l];
      html += '<div class="genre-section" id="az-' + l + '">';
      html += '<div class="genre-header" style="cursor:default;border:none;position:sticky;top:0;z-index:10;background:var(--bg)">';
      html += '<div class="genre-title">' + l + ' <span class="genre-count">(' + items.length + ')</span></div>';
      html += '</div><div class="movie-grid">';
      items.forEach(m => {
        const nameClean = (m.title || m.name || '').replace(/[._]/g, ' ').replace(/\.[^.]+$/, '');
        const safePath = enc(m.path);
        // Filme solto (arquivo avulso) não tem ficha: o clique toca direto.
        // Filme em pasta abre a ficha, como em todo o app.
        const clique = m.is_file
          ? 'playMovie(decodeURIComponent(\'' + safePath + '\'), decodeURIComponent(\'' + enc(nameClean) + '\'))'
          : 'showMovieInfo(decodeURIComponent(\'' + safePath + '\'), event)';
        const botaoGenero = (_me && _me.role === 'admin')
          ? '<button class="movie-card-genero" onclick="event.stopPropagation(); openGeneroFilmeModal(decodeURIComponent(\'' + safePath + '\'), decodeURIComponent(\'' + enc(nameClean) + '\'))" title="Tags do filme"><svg class="icon-svg"><use href="#i-layers"></use></svg></button>'
          : '';
        html += '<div class="movie-card" onclick="' + clique + '" title="' + escHtml(nameClean) + '">'
          + botaoGenero;
        if (m.poster) {
          html += '<img class="movie-card-poster" src="' + posterUrl(m.path, m.poster) + '" alt="' + escHtml(nameClean) + '" loading="lazy" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">';
          html += '<div class="movie-card-poster-placeholder" style="display:none"><svg class="icon-svg"><use href="#i-film"></use></svg></div>';
        } else {
          html += '<div class="movie-card-poster-placeholder" style="display:flex"><svg class="icon-svg"><use href="#i-film"></use></svg></div>';
        }
        html += _badgeAssistido(m);
        html += '<div class="movie-card-overlay"><div class="movie-card-title">' + escHtml(nameClean) + '</div>'
          + (m.is_file ? '<div class="movie-card-subtitle">arquivo solto</div>' : '')
          + '</div>';
        html += '</div>';
      });
      html += '</div></div>';
    });
    document.getElementById('content').innerHTML = html;
  }

  function isHomePage(path) {
    return path === '' || path === '/' || path === (window.__LOGICAL_ROOT__ || '/Media Server');
  }

  function renderDirectory(data) {
    const container = document.getElementById('content');
    const hero = document.getElementById('hero');
    hero.style.display = 'block';
    _heroCapa(null, null);

    const isHome = isHomePage(data.path);

    // Sem trilha do caminho de pastas: o acervo se navega por tags, series e
    // colecoes, nao pelo caminho do disco.
    document.getElementById('breadcrumb').innerHTML = '';
    const hasFolders = data.folders && data.folders.length > 0;
    const hasVideos = data.videos && data.videos.length > 0;
    const hasImages = data.images && data.images.length > 0;

    // If we're in a genre (1 level deep, has movie subfolders)
    if (!isHome && hasFolders && !hasVideos) {
      renderGenreView(container, data);
      return;
    }

    // If we're in a folder with videos directly
    if (!isHome && hasVideos) {
      renderVideoView(container, data);
      return;
    }

    // HOME PAGE: show all genres as sections
    if (isHome) {
      renderHomeView(container, data);
      return;
    }

    // Empty state
    if (!hasFolders && !hasVideos && !hasImages) {
      renderEmptyState(container, data.path);
      return;
    }

    // Fallback: show folders and videos
    renderGenericView(container, data);
  }

  // ===== HOME VIEW: summary + recent movies =====
  function renderHomeView(container, data) {
    const hero = document.getElementById('hero');
    hero.style.display = 'none';
    document.getElementById('heroTitle').textContent = '';
    document.getElementById('heroDesc').textContent = '';
    document.getElementById('heroBg').style.backgroundImage = 'none';

    // A home tem tres secoes de filme: novidades, o que ficou pela metade e o
    // que esta baixado. Navegar por fonte e por genero e papel da barra
    // lateral, que ja agrupa os generos pela fonte dona.
    container.innerHTML = `
      <div class="home-stats">
        <div class="home-stat" onclick="loadAZ()" title="Ver todos os filmes">
          <div class="home-stat-icon"><svg class="icon-svg"><use href="#i-film"></use></svg></div>
          <div class="home-stat-num" id="statMovies">—</div>
          <div class="home-stat-label">Filmes no acervo</div>
        </div>
        <div class="home-stat" onclick="loadSeries()" title="Ver todas as séries">
          <div class="home-stat-icon"><svg class="icon-svg"><use href="#i-tv"></use></svg></div>
          <div class="home-stat-num" id="statSeries">—</div>
          <div class="home-stat-label">Séries no acervo</div>
        </div>
        <div class="home-stat" onclick="openSourcesOrSettings()" title="Fontes do acervo">
          <div class="home-stat-icon"><svg class="icon-svg"><use href="#i-hard-drive"></use></svg></div>
          <div class="home-stat-num" id="statSources">—</div>
          <div class="home-stat-label" id="statSourcesLabel">Fontes conectadas</div>
        </div>
        <div class="home-stat" onclick="openCacheManager()" title="Gerenciar o cache offline">
          <div class="home-stat-icon"><svg class="icon-svg"><use href="#i-download"></use></svg></div>
          <div class="home-stat-num" id="statDownloaded">—</div>
          <div class="home-stat-label" id="statDownloadedLabel">Baixados da nuvem</div>
        </div>
      </div>
      <div class="genre-section">
        <div class="genre-header" style="cursor:default;border:none">
          <div class="genre-title"><svg class="icon-svg"><use href="#i-download"></use></svg> Últimos Adicionados</div>
        </div>
        <div class="movie-grid" id="recentGrid">
          <div class="loading"><div class="spinner"></div><span>Carregando...</span></div>
        </div>
      </div>
      <div class="genre-section" id="continueWatchingSection" style="display:none">
        <div class="genre-header" style="cursor:default;border:none">
          <div class="genre-title"><svg class="icon-svg"><use href="#i-play"></use></svg> Continuar Assistindo</div>
        </div>
        <div class="movie-grid" id="continueWatchingGrid"></div>
        <div class="episodio-lista" id="continueWatchingLista"></div>
      </div>
      <div class="genre-section" id="offlineSection" style="display:none">
        <div class="genre-header" style="cursor:default;border:none">
          <div class="genre-title"><svg class="icon-svg"><use href="#i-download"></use></svg> Baixados da nuvem</div>
        </div>
        <div class="movie-grid" id="offlineGrid"></div>
      </div>`;

    _loadHomeStats();

    // Fetch recent movies sorted by actual creation time (from server)
    cachedFetch('/api/recent-movies?limit=30').then(movies => {
      renderRecentMovies(movies || []);
    });

    function renderRecentMovies(movies) {
      const grid = document.getElementById('recentGrid');
      if (!grid) return;
      if (movies.length === 0) {
        grid.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg class="icon-svg"><use href="#i-inbox"></use></svg></div><h3>Nenhum filme ainda</h3></div>';
        return;
      }
      // Show up to 7 newest
      const recent = movies.slice(0, 7);

      let html = '';
      recent.forEach((m, idx) => {
        const nameClean = (m.title || m.name || '').replace(/[._]/g, ' ').replace(/\.[^.]+$/, '');
        const safePath = enc(m.path);
        const cliqueRecente = m.is_serie
          ? 'loadPath(\'' + SERIE_PREFIXO + safePath + '\')'
          : 'showMovieInfo(decodeURIComponent(\'' + safePath + '\'), event)';
        html += '<div class="movie-card" onclick="' + cliqueRecente + '" title="' + escHtml(m.name) + '">'
          + '<div class="movie-card-poster-placeholder" style="display:flex"><svg class="icon-svg"><use href="#i-film"></use></svg></div>'
          + _badgeAssistido(m)
          + '<div class="movie-card-overlay">'
          + '<div class="movie-card-title">' + escHtml(nameClean) + '</div>'
          + '</div></div>';
        // Load poster using the poster name from the server response
        if (m.poster) {
          const img = document.createElement('img');
          img.className = 'movie-card-poster';
          img.src = posterUrl(m.path, m.poster);
          img.alt = escHtml(m.name);
          img.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0';
          img.onerror = () => img.remove();
          // Attach after card is in DOM
          setTimeout(() => {
            const cards = grid.querySelectorAll('.movie-card');
            if (cards[idx]) cards[idx].appendChild(img);
          }, 0);
        }
      });
      grid.innerHTML = html;
    }

    // Carrega "Continuar Assistindo"
    cachedFetch('/api/continue-watching').then(items => {
      const section = document.getElementById('continueWatchingSection');
      const grid = document.getElementById('continueWatchingGrid');
      if (!section || !grid) return;
      if (!items || items.length === 0) {
        section.style.display = 'none';
        return;
      }
      section.style.display = '';
      let html2 = '';
      let linhas = '';
      items.forEach((m, idx) => {
        const pct = (m.duration > 0) ? Math.round((m.position / m.duration) * 100) : 0;
        const posStr = Math.floor(m.position / 60) + ':' + String(Math.floor(m.position % 60)).padStart(2, '0');
        const tipo = m.tipo || 'filme';

        // Episódio de série e filme solto: linha com retomada direta.
        if (tipo === 'episodio' || tipo === 'solto') {
          const rotulo = tipo === 'episodio'
            ? m.serie + ' · ' + m.temporada + ' · ' + m.episodio
            : m.name;
          linhas += '<button class="episodio-linha" onclick="playMovie(decodeURIComponent(\''
            + enc(m.path) + '\'), decodeURIComponent(\'' + enc(rotulo) + '\')'
            + (m.subtitle ? ', decodeURIComponent(\'' + enc(m.subtitle) + '\')' : ', null')
            + ', ' + Math.floor(m.position) + ')">'
            + '<span class="episodio-play"><svg class="icon-svg"><use href="#i-play"></use></svg></span>'
            + '<span class="episodio-titulo">' + escHtml(rotulo)
            + ' <span class="episodio-tamanho">' + posStr + ' assistido</span></span>'
            + '<span class="episodio-progresso"><span style="width:' + pct + '%"></span></span>'
            + '</button>';
          return;
        }

        // Filme em pasta: poster card com retomada pela ficha (como sempre).
        const nameClean = (m.title || m.name || '').replace(/[._]/g, ' ');
        const safePath = enc(m.path);
        html2 += '<div class="movie-card" onclick="showMovieInfo(decodeURIComponent(\'' + safePath + '\'), event)" title="' + escHtml(m.name) + '">'
          + '<div class="movie-card-poster-placeholder" style="display:flex"><svg class="icon-svg"><use href="#i-film"></use></svg></div>'
          + '<div class="movie-card-overlay">'
          + '<div class="movie-card-title">' + escHtml(nameClean) + '</div>'
          + '<div class="movie-card-subtitle">' + posStr + ' assistido</div>'
          + '</div>'
          + '<div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:' + pct + '%"></div></div>'
          + '</div>';
        // Load poster
        if (m.poster) {
          const img = document.createElement('img');
          img.className = 'movie-card-poster';
          img.src = posterUrl(m.path, m.poster);
          img.alt = escHtml(m.name);
          img.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0';
          img.onerror = () => img.remove();
          setTimeout(() => {
            const cards = grid.querySelectorAll('.movie-card');
            if (cards[idx]) cards[idx].appendChild(img);
          }, 0);
        }
      });
      // Séries e soltos em progresso entram no MESMO campo, logo abaixo
      // dos cards de filme — um único "Continuar Assistindo".
      const listaEl = document.getElementById('continueWatchingLista');
      if (listaEl) listaEl.innerHTML = linhas;      grid.innerHTML = html2;
    });

    // Carrega filmes marcados como offline
    _renderOfflineGrid();
  }

  // Estatisticas da home. As duas fontes de dado ja existiam; o que muda e
  // mostrar o que importa num acervo com varias fontes, em vez de contar
  // generos. As contagens de filme e serie sao as mesmas das paginas A-Z e
  // Series (ver cached_movie_count/cached_series_count no servidor).
  function _loadHomeStats() {
    cachedFetch('/api/cache-status').then(st => {
      if (!st) return;
      const filmes = document.getElementById('statMovies');
      if (filmes) filmes.textContent = st.movies != null ? st.movies : '—';
      const series = document.getElementById('statSeries');
      if (series) series.textContent = st.series != null ? st.series : '—';
      const baixLabel = document.getElementById('statDownloadedLabel');
      const uso = st.usage && st.usage.details ? st.usage.details.vfs : 0;
      if (baixLabel && uso > 0) {
        baixLabel.textContent = 'Baixados · ' + formatSize(uso);
      }
    });

    const baix = document.getElementById('statDownloaded');
    if (baix) baix.textContent = _cachedSet.size;

    cachedFetch('/api/sources').then(d => {
      if (!d || !d.sources) return;
      const el = document.getElementById('statSources');
      const label = document.getElementById('statSourcesLabel');
      if (!el) return;
      const total = d.sources.length;
      const online = d.sources.filter(s => s.online).length;
      el.textContent = (online === total) ? String(total) : (online + '/' + total);
      if (label) {
        label.textContent = (online === total)
          ? (total === 1 ? 'Fonte conectada' : 'Fontes conectadas')
          : 'Fontes conectadas';
      }
    });
  }

  // O painel de fontes e de admin; quem nao e cai no hub de Ajustes.
  function openSourcesOrSettings() {
    if (_me && _me.role === 'admin') openSourcesModal();
    else openSettingsModal();
  }

  // ==================== COLEÇÕES ====================
  // Agrupamentos de filmes criados na própria interface (sagas, franquias).
  // O valor depois do prefixo é o id da coleção no banco.
  const COLECAO_PREFIXO = 'colecao:';
  const LISTA_COLECOES = 'colecoes';
  const GENERO_PREFIXO = 'genero:';
  const SERIE_PREFIXO = 'serie:';
  const LISTA_SERIES = 'series';
  const LISTA_FILMES = '__az__';

  // url() de CSS com aspas. Sem elas o parser rejeita a regra inteira quando o
  // caminho tem parenteses — e "Filme (1980)" e justamente a convencao de
  // nomes do acervo, entao o fundo simplesmente nao aparecia.
  function cssUrl(u) {
    return 'url("' + String(u).replace(/["\\\n]/g, function(c) {
      return '\\' + (c === '\n' ? 'A ' : c);
    }) + '")';
  }

  // Capa grande no cabecalho. Centralizado num helper porque o hero e
  // compartilhado por todas as telas: sem um ponto unico de limpeza, a capa
  // de uma colecao ficaria pendurada ao navegar pra um genero.
  function _heroCapa(poster, fanart) {
    const img = document.getElementById('heroCapa');
    const hero = document.getElementById('hero');
    const bg = document.getElementById('heroBg');
    if (!img || !hero) return;
    // As telas ligam hero.style.display='block' inline, e estilo inline ganha
    // da classe: por isso o display de linha tambem sai daqui, senao a capa
    // fica empilhada em cima do titulo em vez de ao lado.
    if (poster) {
      img.src = streamUrl(poster);
      img.style.display = '';
      img.onerror = function() {
        this.style.display = 'none';
        hero.classList.remove('com-capa');
        hero.style.display = 'block';
      };
      hero.classList.add('com-capa');
      hero.style.display = 'flex';
    } else {
      img.removeAttribute('src');
      img.style.display = 'none';
      hero.classList.remove('com-capa');
      hero.style.display = 'block';
    }
    if (bg) {
      if (fanart) {
        bg.style.backgroundImage = cssUrl(streamUrl(fanart));
        bg.classList.add('ativo');
      } else {
        bg.style.backgroundImage = 'none';
        bg.classList.remove('ativo');
      }
    }
  }

  function abrirColecao(nome) { loadPath(COLECAO_PREFIXO + nome); }
  function loadCollections() { loadPath(LISTA_COLECOES); }
  function loadSeries() { loadPath(LISTA_SERIES); }

  // ==================== LISTA DE SÉRIES ====================
  function renderSeriesList() {
    const container = document.getElementById('content');
    const hero = document.getElementById('hero');
    hero.style.display = 'block';
    _heroCapa(null, null);
    document.getElementById('breadcrumb').innerHTML = '';
    document.getElementById('heroBg').style.backgroundImage = 'none';
    hero.style.background = 'linear-gradient(135deg, var(--bg2) 0%, var(--surface) 100%)';
    document.getElementById('heroTitle').innerHTML =
      '<svg class="icon-svg"><use href="#i-tv"></use></svg> Séries';
    document.getElementById('heroDesc').textContent = '';

    cachedFetch('/api/series').then(series => {
      if (!series || series.length === 0) {
        container.innerHTML = '<div class="empty-state">'
          + '<div class="empty-icon"><svg class="icon-svg"><use href="#i-tv"></use></svg></div>'
          + '<h3>Nenhuma série no acervo</h3>'
          + '<p>Dentro da pasta <b>tv shows</b> do acervo, crie uma pasta por série '
          + 'e, dentro dela, as temporadas (S01, S02...) com os episódios.</p></div>';
        return;
      }
      document.getElementById('heroDesc').innerHTML =
        '<svg class="icon-svg"><use href="#i-tv"></use></svg> '
        + series.length + (series.length === 1 ? ' série' : ' séries');
      // A-Z igual ao menu de Filmes: navegação por letra + seções.
      const grupos = {};
      series.forEach(s => {
        const letra = (s.title || s.name || '').charAt(0).toUpperCase();
        (grupos[letra] = grupos[letra] || []).push(s);
      });
      const letras = Object.keys(grupos).sort();
      let html = '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:24px;padding:0 4px">';
      letras.forEach(l => {
        html += '<a href="javascript:;" onclick="document.getElementById(\'azs-' + l + '\').scrollIntoView({behavior:\'smooth\'});return false" '
          + 'style="display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;background:var(--surface);border-radius:6px;text-decoration:none;font-weight:700;font-size:15px;color:var(--accent)">' + l + '</a>';
      });
      html += '</div>';
      letras.forEach(l => {
        html += '<div class="genre-section" id="azs-' + l + '">'
          + '<div class="genre-header" style="cursor:default;border:none;position:sticky;top:0;z-index:10;background:var(--bg)">'
          + '<div class="genre-title">' + l
          + ' <span class="genre-count">(' + grupos[l].length + ')</span></div></div>'
          + '<div class="movie-grid">';
        grupos[l].forEach(s => {
          const titulo = escHtml(s.title);
          const poster = s.poster ? streamUrl(s.poster) : null;
          const meta = s.temporadas
            + (s.temporadas === 1 ? ' temporada · ' : ' temporadas · ')
            + s.episodios + (s.episodios === 1 ? ' episódio' : ' episódios');
          html += '<div class="movie-card" onclick="loadPath(\'' + SERIE_PREFIXO + enc(s.path) + '\')" title="' + titulo + '">'
            + (poster
                ? '<img class="movie-card-poster" src="' + poster + '" alt="' + titulo
                  + '" loading="lazy" onerror="this.style.display=\'none\';'
                  + 'this.nextElementSibling.style.display=\'flex\'">'
                  + '<div class="movie-card-poster-placeholder" style="display:none">'
                  + '<svg class="icon-svg"><use href="#i-tv"></use></svg></div>'
                : '<div class="movie-card-poster-placeholder" style="display:flex">'
                  + '<svg class="icon-svg"><use href="#i-tv"></use></svg></div>')
            + '<div class="movie-card-overlay"><div class="movie-card-title">' + titulo + '</div>'
            + '<div class="movie-card-subtitle">' + meta + '</div>'
            + '</div></div>';
        });
        html += '</div></div>';
      });
      container.innerHTML = html;
    });
  }

  function renderCollectionsList() {
    const container = document.getElementById('content');
    const hero = document.getElementById('hero');
    hero.style.display = 'block';
    _heroCapa(null, null);
    document.getElementById('breadcrumb').innerHTML = '';
    document.getElementById('heroTitle').innerHTML =
      '<svg class="icon-svg"><use href="#i-layers"></use></svg> Coleções';
    document.getElementById('heroBg').style.backgroundImage = 'none';
    hero.style.background = 'linear-gradient(135deg, var(--bg2) 0%, var(--surface) 100%)';

    const botaoNova = (_me && _me.role === 'admin')
      ? '<button class="btn btn-primary colecao-nova-btn" onclick="openColecaoModal()">'
        + '<svg class="icon-svg"><use href="#i-plus"></use></svg> Nova coleção</button>'
      : '';
    cachedFetch('/api/collections').then(cols => {
      document.getElementById('heroDesc').innerHTML =
        '<svg class="icon-svg"><use href="#i-layers"></use></svg> '
        + (cols && cols.length ? cols.length + (cols.length === 1 ? ' coleção' : ' coleções') : '');
      if (!cols || cols.length === 0) {
        container.innerHTML = botaoNova + '<div class="empty-state">'
          + '<div class="empty-icon"><svg class="icon-svg"><use href="#i-layers"></use></svg></div>'
          + '<h3>Nenhuma coleção ainda</h3>'
          + '<p>Agrupe filmes num só lugar: uma saga, uma franquia, o que você quiser. '
          + 'Crie a coleção, escolha os filmes e a capa — tudo por aqui.</p></div>';
        return;
      }
      let html = '<div class="genre-section">' + botaoNova + '<div class="colecao-lista">';
      cols.forEach(c => {
        html += '<button class="colecao-item" onclick="abrirColecao(' + c.id + ')">'
          + (c.poster
              ? '<img class="colecao-capa" src="' + streamUrl(c.poster) + '" alt="" '
                + 'loading="lazy" onerror="this.remove()">'
              : '<span class="colecao-icone"><svg class="icon-svg"><use href="#i-layers"></use></svg></span>')
          + '<span class="colecao-nome">' + escHtml(c.name) + '</span>'
          + '<span class="colecao-conta">' + c.total
          + (c.total === 1 ? ' filme' : ' filmes') + '</span></button>';
      });
      container.innerHTML = html + '</div></div>';
    });
  }

  function renderCollectionView(nome) {
    const container = document.getElementById('content');
    const hero = document.getElementById('hero');
    hero.style.display = 'block';
    document.getElementById('heroBg').style.backgroundImage = 'none';
    hero.style.background = 'linear-gradient(135deg, var(--bg2) 0%, var(--surface) 100%)';

    document.getElementById('breadcrumb').innerHTML =
      '<a onclick="loadPath(\'\')"><svg class="icon-svg"><use href="#i-home"></use></svg> Início</a>'
      + ' <span class="sep">›</span> <a onclick="loadCollections()">Coleções</a>'
      + ' <span class="sep">›</span> <span>' + escHtml(nome) + '</span>';

    cachedFetch('/api/collection?key=' + encodeURIComponent(nome)).then(col => {
      if (!col || !col.movies) {
        container.innerHTML = '<div class="empty-state"><div class="empty-icon">'
          + '<svg class="icon-svg"><use href="#i-error"></use></svg></div>'
          + '<h3>Coleção não encontrada</h3></div>';
        return;
      }
      // O endereço guarda o id; o nome de verdade chega na resposta.
      const ultimoBc = document.querySelector('#breadcrumb span:last-child');
      if (ultimoBc) ultimoBc.textContent = col.name;
      _heroCapa(col.poster, col.fanart);
      document.getElementById('heroTitle').innerHTML =
        (col.poster ? '' : '<svg class="icon-svg"><use href="#i-layers"></use></svg> ')
        + escHtml(col.name);
      const acoesAdmin = (_me && _me.role === 'admin')
        ? '<button class="colecao-acao-btn" onclick="openColecaoModal(' + col.id + ')">'
          + '<svg class="icon-svg"><use href="#i-gear"></use></svg> Editar</button>'
          + '<button class="colecao-acao-btn perigo" onclick="excluirColecao(' + col.id
          + ', decodeURIComponent(\'' + enc(col.name) + '\'))">'
          + '<svg class="icon-svg"><use href="#i-trash"></use></svg> Excluir</button>'
        : '';
      document.getElementById('heroDesc').innerHTML =
        '<span class="colecao-acoes">' + acoesAdmin + '</span>'
        + '<svg class="icon-svg"><use href="#i-film"></use></svg> ' + col.movies.length
        + (col.movies.length === 1 ? ' filme' : ' filmes')
        + (col.overview ? '<div class="colecao-sinopse">' + escHtml(col.overview) + '</div>' : '');

      // Ordenados por ano no servidor — é o que põe a saga na ordem certa.
      let html = '<div class="genre-section"><div class="movie-grid">';
      col.movies.forEach(m => {
        // Cartão próprio em vez de renderMovieCardHtml: filme abre a ficha,
        // série abre a página dela (com as temporadas). Pôster e ano vêm
        // prontos da API, sem regex no nome da pasta.
        const titulo = escHtml((m.title || m.name).replace(/[._]/g, ' '));
        const poster = m.poster ? posterUrl(m.path, m.poster) : null;
        const clique = m.is_serie
          ? 'loadPath(\'' + SERIE_PREFIXO + enc(m.path) + '\')'
          : 'showMovieInfo(decodeURIComponent(\'' + enc(m.path) + '\'), event)';
        html += '<div class="movie-card" onclick="' + clique + '" title="' + titulo + '">'
          + (poster
              ? '<img class="movie-card-poster" src="' + poster + '" alt="' + titulo
                + '" loading="lazy" onerror="this.style.display=\'none\';'
                + 'this.nextElementSibling.style.display=\'flex\'">'
                + '<div class="movie-card-poster-placeholder" style="display:none">'
                + '<svg class="icon-svg"><use href="#i-film"></use></svg></div>'
              : '<div class="movie-card-poster-placeholder">'
                + '<svg class="icon-svg"><use href="#i-film"></use></svg></div>')
          + _badgeAssistido(m)
          + '<div class="movie-card-overlay"><div class="movie-card-title">' + titulo + '</div>'
          + '<div class="movie-card-subtitle">' + (m.year ? escHtml(m.year) : 'Filme') + '</div>'
          + '</div></div>';
      });
      container.innerHTML = html + '</div></div>';
    });
  }

  // ==================== COLEÇÕES: CRIAR / EDITAR ====================
  // Estado do modal. filmes é um Set de folder_path; a ordem de escolha é a
  // que a capa picker apresenta. capa é o folder_path do filme escolhido.
  let _colecao = null;
  let _colecaoTodos = null;   // cache de /api/all-movies pro seletor
  let _colecaoBusca = '';

  function _colecaoAbrirEstado(id) {
    document.getElementById('colecaoModalTitulo').innerHTML =
      '<svg class="icon-svg"><use href="#i-layers"></use></svg> '
      + (id ? 'Editar coleção' : 'Nova coleção');
    if (id) {
      return cachedFetch('/api/collection?key=' + id).then(col => {
        if (!col) return null;
        return {
          id: col.id, nome: col.name, descricao: col.overview || '',
          filmes: col.movies.map(m => ({ path: m.path, title: m.title, poster: m.poster })),
          capa: col.capa_path || (col.movies.length === 1 ? col.movies[0].path : ''),
        };
      });
    }
    return Promise.resolve({ id: null, nome: '', descricao: '', filmes: [], capa: '' });
  }

  function openColecaoModal(id) {
    const conteudo = document.getElementById('colecaoModalConteudo');
    conteudo.innerHTML = '<div class="loading" style="min-height:140px">'
      + '<div class="spinner"></div><span>Carregando filmes...</span></div>';
    document.getElementById('colecaoModal').classList.add('active');
    document.body.style.overflow = 'hidden';
    Promise.all([
      _colecaoAbrirEstado(id || null),
      cachedFetch('/api/all-movies'),
      cachedFetch('/api/series'),
    ]).then(([estado, filmes, series]) => {
      if (!estado) {
        conteudo.innerHTML = '<div class="empty-state"><div class="empty-icon">'
          + '<svg class="icon-svg"><use href="#i-error"></use></svg></div>'
          + '<h3>Coleção não encontrada</h3></div>';
        return;
      }
      // Filmes e séries lado a lado no seletor: uma coleção pode misturar.
      const seriesFormatadas = (series || []).map(s => ({
        path: s.path, name: s.name, title: s.title, is_serie: true,
        poster: s.poster, _capaPronta: s.poster ? streamUrl(s.poster) : null,
      }));
      _colecaoTodos = (filmes || []).concat(seriesFormatadas);
      _colecao = {
        id: estado.id, nome: estado.nome, descricao: estado.descricao,
        capa: estado.capa,
        filmes: new Map(estado.filmes.map(f => [f.path, {
          path: f.path, title: f.title, poster: f.poster,
          is_serie: f.is_serie,
          _capaPronta: f.is_serie && f.poster ? streamUrl(f.poster) : null,
        }])),
      };
      _colecaoBusca = '';
      _colecaoRenderPasso1();
    }).catch(() => {
      conteudo.innerHTML = '<div class="user-msg err">Falha ao carregar.</div>';
    });
  }

  function closeColecaoModal() {
    document.getElementById('colecaoModal').classList.remove('active');
    document.body.style.overflow = '';
    _colecao = null;
    _colecaoBusca = '';
  }
  document.getElementById('colecaoModal').addEventListener('click', function(e) {
    if (e.target === this) closeColecaoModal();
  });

  function _colecaoRenderPasso1() {
    const conteudo = document.getElementById('colecaoModalConteudo');
    let html = '<label class="colecao-campo"><span>Nome da coleção</span>'
      + '<input id="colecaoNome" type="text" maxlength="80" placeholder="Ex.: Star Wars — a saga completa" '
      + 'value="' + escHtml(_colecao.nome) + '"></label>'
      + '<label class="colecao-campo"><span>Descrição <em>(opcional)</em></span>'
      + '<textarea id="colecaoDescricao" rows="2" maxlength="300" '
      + 'placeholder="Uma linha sobre o conjunto...">' + escHtml(_colecao.descricao) + '</textarea></label>'
      + '<div class="colecao-secao-titulo">Filmes da coleção '
      + '<span class="colecao-contador" id="colecaoContador"></span></div>'
      + '<input id="colecaoBusca" class="colecao-busca" type="text" '
      + 'placeholder="Filtrar por título..." value="' + escHtml(_colecaoBusca) + '" '
      + 'oninput="_colecaoFiltrar(this.value)">'
      + '<div class="colecao-picker" id="colecaoPicker"></div>'
      + '<div class="colecao-passos">'
      + '<span></span>'
      + '<button class="rclone-action-btn primary" onclick="_colecaoIrParaCapa()">Continuar →</button>'
      + '</div>'
      + '<div id="colecaoMsg"></div>';
    conteudo.innerHTML = html;
    document.getElementById('colecaoBusca').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') e.preventDefault();
    });
    _colecaoRenderPicker();
  }

  function _colecaoFiltrar(valor) {
    _colecaoBusca = valor;
    _colecaoRenderPicker();
  }

  function _colecaoRenderPicker() {
    const picker = document.getElementById('colecaoPicker');
    if (!picker) return;
    const busca = _colecaoBusca.trim().toLowerCase();
    // Selecionados primeiro (na ordem em que entraram), depois o resto — assim
    // a seleção não some ao filtrar. Sem busca, mostra só os escolhidos + aviso.
    const escolhidos = [..._colecao.filmes.keys()];
    const ordem = escolhidos.concat(
      _colecaoTodos.filter(m => !escolhidos.includes(m.path))
        .map(m => m.path));
    const termos = ordem.filter(path => {
      if (busca) {
        const m = _colecaoTodos.find(x => x.path === path)
          || _colecao.filmes.get(path);
        const titulo = ((m && (m.title || m.name)) || '').toLowerCase();
        if (!titulo.includes(busca)) return false;
      }
      return true;
    });
    if (!termos.length) {
      picker.innerHTML = '<div class="colecao-picker-vazio">Nenhum filme encontrado'
        + (busca ? ' para "' + escHtml(_colecaoBusca) + '".' : '.') + '</div>';
      _colecaoAtualizarContador();
      return;
    }
    let html = '';
    termos.forEach(path => {
      const m = _colecaoTodos.find(x => x.path === path) || _colecao.filmes.get(path);
      const escolhido = _colecao.filmes.has(path);
      const titulo = escHtml((m.title || m.name || '').replace(/[._]/g, ' '));
      const poster = m.poster ? posterUrl(m.path, m.poster) : null;
      html += '<button class="colecao-filme' + (escolhido ? ' escolhido' : '') + '" '
        + 'onclick="_colecaoToggle(\'' + enc(path) + '\')" title="' + titulo + '">'
        + (poster
            ? '<img src="' + poster + '" alt="" loading="lazy" onerror="this.remove()">'
            : '<span class="colecao-filme-sem"><svg class="icon-svg"><use href="#i-film"></use></svg></span>')
        + '<span class="colecao-filme-check"><svg class="icon-svg"><use href="#i-check"></use></svg></span>'
        + '<span class="colecao-filme-titulo">' + titulo + '</span>'
        + '</button>';
    });
    picker.innerHTML = html;
    _colecaoAtualizarContador();
  }

  function _colecaoToggle(pathEnc) {
    const path = decodeURIComponent(pathEnc);
    if (_colecao.filmes.has(path)) {
      _colecao.filmes.delete(path);
      if (_colecao.capa === path) _colecao.capa = '';
    } else {
      const m = _colecaoTodos.find(x => x.path === path);
      _colecao.filmes.set(path, { path: path, title: (m && m.title) || path,
        poster: (m && m.poster) || null, _capaPronta: m && m._capaPronta });
    }
    _colecaoRenderPicker();
  }

  function _colecaoAtualizarContador() {
    const el = document.getElementById('colecaoContador');
    if (el) el.textContent = _colecao.filmes.size
      + (_colecao.filmes.size === 1 ? ' filme escolhido' : ' filmes escolhidos');
  }

  // ── Passo 2: capa ──
  function _colecaoIrParaCapa() {
    _colecao.nome = (document.getElementById('colecaoNome').value || '').trim();
    _colecao.descricao = (document.getElementById('colecaoDescricao').value || '').trim();
    if (!_colecao.nome) {
      _colecaoMostrarErro('Dê um nome à coleção.');
      return;
    }
    if (_colecao.filmes.size === 0) {
      _colecaoMostrarErro('Escolha pelo menos um filme.');
      return;
    }
    if (!_colecao.capa) {
      _colecao.capa = _colecao.filmes.keys().next().value;
    }
    _colecaoRenderPasso2();
  }

  function _colecaoRenderPasso2() {
    const conteudo = document.getElementById('colecaoModalConteudo');
    let grade = '';
    for (const [path, f] of _colecao.filmes) {
      const poster = f.poster ? posterUrl(f.path, f.poster) : null;
      grade += '<button class="colecao-capa-opcao' + (_colecao.capa === path ? ' escolhida' : '') + '" '
        + 'onclick="_colecaoEscolherCapa(\'' + enc(path) + '\')">'
        + (poster
            ? '<img src="' + poster + '" alt="" onerror="this.parentElement.classList.add(\'sem-poster\'); this.remove()">'
            : '')
        + '<span class="colecao-capa-titulo">' + escHtml((f.title || '').replace(/[._]/g, ' ')) + '</span>'
        + '<span class="colecao-capa-check"><svg class="icon-svg"><use href="#i-check"></use></svg></span>'
        + '</button>';
    }
    conteudo.innerHTML = '<div class="colecao-secao-titulo">Qual capa usar?</div>'
      + '<p class="colecao-dica">O pôster do filme escolhido representa a coleção — '
      + 'você pode trocar depois em Editar.</p>'
      + '<div class="colecao-capa-grade">' + grade + '</div>'
      + '<div class="colecao-passos">'
      + '<button class="rclone-action-btn" onclick="_colecaoRenderPasso1()">← Voltar</button>'
      + '<button class="rclone-action-btn primary" id="colecaoSalvarBtn" onclick="_colecaoSalvar()">'
      + (_colecao.id ? 'Salvar alterações' : 'Criar coleção') + '</button>'
      + '</div>'
      + '<div id="colecaoMsg"></div>';
  }

  function _colecaoEscolherCapa(pathEnc) {
    _colecao.capa = decodeURIComponent(pathEnc);
    _colecaoRenderPasso2();
  }

  function _colecaoMostrarErro(texto) {
    const msg = document.getElementById('colecaoMsg');
    if (msg) msg.innerHTML = '<div class="user-msg err">' + escHtml(texto) + '</div>';
  }

  function _colecaoSalvar() {
    const btn = document.getElementById('colecaoSalvarBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }
    fetch(_colecao.id ? '/api/colecoes/update' : '/api/colecoes/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: _colecao.id,
        nome: _colecao.nome,
        descricao: _colecao.descricao,
        capa: _colecao.capa,
        filmes: [..._colecao.filmes.keys()],
      }),
    }).then(res => res.json()).then(data => {
      if (data.status === 'ok') {
        closeColecaoModal();
        showToast('✅ ' + (data.message || 'Coleção salva.'), 'success');
        _invalidateCache('/api/collections');
        loadCollections();
      } else {
        _colecaoMostrarErro(data.error || 'Não foi possível salvar.');
        if (btn) { btn.disabled = false; btn.textContent = _colecao.id ? 'Salvar alterações' : 'Criar coleção'; }
      }
    }).catch(() => {
      _colecaoMostrarErro('Falha de conexão com o servidor.');
      if (btn) { btn.disabled = false; btn.textContent = _colecao.id ? 'Salvar alterações' : 'Criar coleção'; }
    });
  }

  function excluirColecao(id, nome) {
    _confirmarGenerico(
      'Excluir coleção?',
      'A coleção "' + nome + '" vai embora. Os filmes não são tocados — continuam no acervo, nas suas tags.',
      function() {
        fetch('/api/colecoes/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id }),
        }).then(res => res.json()).then(data => {
          if (data.status === 'ok') {
            showToast('Coleção excluída', 'success');
            _invalidateCache('/api/collections');
            loadCollections();
          } else {
            showToast('Erro: ' + (data.error || 'falha ao excluir'), 'error');
          }
        }).catch(() => showToast('Erro ao excluir coleção', 'error'));
      });
  }

  // Reaproveita o modal de confirmação do player para qualquer decisão:
  // troca os textos, encaminha o OK e devolve os textos originais ao fechar.
  function _confirmarGenerico(titulo, descricao, aoConfirmar) {
    const modal = document.getElementById('confirmModal');
    const tit = modal.querySelector('.confirm-title');
    const desc = modal.querySelector('.confirm-desc');
    const icon = modal.querySelector('.confirm-icon');
    const cancel = modal.querySelector('.confirm-btn.cancel');
    const sim = document.getElementById('confirmYesBtn');
    const originais = { tit: tit.textContent, desc: desc.textContent,
                        icon: icon.textContent, cancel: cancel.textContent,
                        sim: sim.textContent };
    tit.textContent = titulo;
    desc.textContent = descricao;
    icon.textContent = '🗑️';
    cancel.textContent = 'Manter';
    sim.textContent = 'Excluir';
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
    sim.onclick = function() {
      modal.classList.remove('active');
      _confirmarRestaurar(originais);
      document.body.style.overflow = '';
      aoConfirmar();
    };
    cancel.onclick = function() {
      modal.classList.remove('active');
      _confirmarRestaurar(originais);
      document.body.style.overflow = '';
    };
  }
  // Igual ao _confirmarGenerico, mas com um campo de texto — usado para
  // renomear. O OK entrega o valor digitado (vazio = cancelado).
  function _confirmarGenericoComInput(titulo, valorInicial, aoConfirmar) {
    const modal = document.getElementById('confirmModal');
    const body = modal.querySelector('.confirm-body');
    let input = document.getElementById('confirmInputDinamico');
    if (!input) {
      input = document.createElement('input');
      input.id = 'confirmInputDinamico';
      input.className = 'confirm-input';
      body.insertBefore(input, body.querySelector('.confirm-actions'));
    }
    input.style.display = '';
    input.value = valorInicial || '';
    _confirmarGenerico(titulo, '', function() {
      const v = input.value.trim();
      input.style.display = 'none';
      aoConfirmar(v);
    });
    const cancel = modal.querySelector('.confirm-btn.cancel');
    const cancelOriginal = cancel.onclick;
    cancel.onclick = function() {
      input.style.display = 'none';
      if (cancelOriginal) cancelOriginal();
    };
    setTimeout(() => input.focus(), 80);
  }

  function _confirmarRestaurar(originais) {
    const modal = document.getElementById('confirmModal');
    modal.querySelector('.confirm-title').textContent = originais.tit;
    modal.querySelector('.confirm-desc').textContent = originais.desc;
    modal.querySelector('.confirm-icon').textContent = originais.icon;
    modal.querySelector('.confirm-btn.cancel').textContent = originais.cancel;
    document.getElementById('confirmYesBtn').textContent = originais.sim;
    // O onclick do "Sair" é reatribuído pelo próprio fluxo de saída do player.
  }

