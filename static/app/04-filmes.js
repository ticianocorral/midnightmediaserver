  // ===== GENRE VIEW: show movie folders as cards =====
  function renderGenreView(container, data) {
    const hero = document.getElementById('hero');
    hero.style.display = 'block';

    const parts = data.path.split('/').filter(Boolean);
    const genreName = parts.length > 0 ? parts[parts.length - 1] : 'Género';
    // Pasta de filme e vídeo solto na pasta da tag viram o mesmo cartão na
    // tela, então contam junto: separar os dois era uma distinção interna que
    // não dizia nada a quem lê.
    const total = data.folders.length + (data.videos ? data.videos.length : 0);
    const icon = genreIcon(genreName);
    document.getElementById('heroTitle').innerHTML = icon + ' ' + escHtml(genreName);
    document.getElementById('heroDesc').innerHTML =
      '<svg class="icon-svg"><use href="#i-film"></use></svg> ' + total
      + (total === 1 ? ' filme' : ' filmes');
    hero.style.background = 'linear-gradient(135deg, var(--bg2) 0%, var(--surface) 100%)';
    document.getElementById('heroBg').style.backgroundImage = 'none';

    const movieFolders = data.folders || [];
    const directVideos = data.videos || [];

    if (movieFolders.length === 0 && directVideos.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><svg class="icon-svg"><use href="#i-inbox"></use></svg></div>
          <h3>Nenhum filme em "${escHtml(genreName)}"</h3>
          <p>${isLocalPath(data.path)
              ? 'Adicione pastas de filme nesta pasta do disco e clique em Atualizar.'
              : 'Adicione filmes nesta pasta da nuvem para vê-los aqui.'}</p>
        </div>`;
      return;
    }

    let html = `<div class="genre-section">
      <div class="genre-header" style="cursor:default;border:none;padding-bottom:4px">
        <div class="genre-title"><svg class="icon-svg"><use href="#i-film"></use></svg> Filmes <span class="genre-count">(${movieFolders.length})</span></div>
      </div>
      <div class="movie-grid">`;

    // Show movie folders as cards
    movieFolders.forEach(folder => {
      const name = folder.Name || '';
      const folderPath = (data.path ? data.path + '/' : '') + name;
      html += renderMovieFolderCard(name, folderPath);
    });

    // Also show any direct videos
    directVideos.forEach(video => {
      const name = video.Name || '';
      const filePath = (data.path ? data.path + '/' : '') + name;
      html += renderMovieCardHtml(name, filePath, video.Size, video.poster ? posterUrl(data.path, video.poster) : null, video.watched);
    });

    html += `</div></div>`;
    container.innerHTML = html;

    // Load posters for movie folders
    movieFolders.forEach(folder => {
      const name = folder.Name || '';
      const folderPath = (data.path ? data.path + '/' : '') + name;
      const imgId = 'poster-' + encodeURIComponent(folderPath).replace(/%/g, '_');
      cachedFetch('/api/movie-detail?path=' + encodeURIComponent(folderPath)).then(detail => {
        const imgEl = document.getElementById(imgId);
        if (!imgEl) return;
        if (detail && detail.poster) {
          imgEl.src = posterUrl(folderPath, detail.poster.Name);
          imgEl.style.display = 'block';
          const ph = document.getElementById('ph-' + encodeURIComponent(folderPath).replace(/%/g, '_'));
          if (ph) ph.style.display = 'none';
          imgEl.onerror = () => { imgEl.style.display = 'none'; if (ph) ph.style.display = 'flex'; };
        } else {
          imgEl.style.display = 'none';
          if (imgEl.nextElementSibling) imgEl.nextElementSibling.style.display = 'flex';
        }
      });
    });

    // Load hero background from first movie's fanart or poster - REMOVED, simple header only
  }

  function renderMovieFolderCard(name, folderPath) {
    const encodedPath = encodeURIComponent(folderPath).replace(/%/g, '_');
    const nameClean = name.replace(/[._]/g, ' ');
    const yearMatch = name.match(/(\d{4})/);
    const year = yearMatch ? yearMatch[1] : '';
    const safePath = enc(folderPath);

    return `
      <div class="movie-card"${attrAcao('showMovieInfo', [folderPath, {$: 'event'}])} title="${escHtml(name)}">
        <img class="movie-card-poster" id="poster-${encodedPath}" src="" alt="${escHtml(name)}" style="display:none">
        <div class="movie-card-poster-placeholder" id="ph-${encodedPath}"><svg class="icon-svg"><use href="#i-film"></use></svg></div>
        <div class="movie-card-overlay">
          <div class="movie-card-title">${escHtml(nameClean)}</div>
          <div class="movie-card-subtitle">${year ? year : 'Filme'}</div>
        </div>
      </div>`;
  }

  // ===== VIDEO VIEW: direct video files =====
  function renderVideoView(container, data) {
    let html = `<div class="movie-grid">`;
    (data.videos || []).forEach(video => {
      const name = video.Name || '';
      const filePath = (data.path ? data.path + '/' : '') + name;
      const posterSrc = video.poster ? posterUrl(data.path, video.poster) : null;
      html += renderMovieCardHtml(name, filePath, video.Size, posterSrc, video.watched);
    });
    html += `</div>`;
    container.innerHTML = html;
  }

  // ===== GENERIC / FALLBACK =====
  function renderGenericView(container, data) {
    let html = '';

    if (data.folders && data.folders.length > 0) {
      html += `<div class="genre-section">
        <div class="genre-header" style="cursor:default;border:none">
          <div class="genre-title"><svg class="icon-svg"><use href="#i-folder"></use></svg> Pastas <span class="genre-count">(${data.folders.length})</span></div>
        </div>
        <div class="movie-grid">`;
      data.folders.forEach(folder => {
        const name = folder.Name || '';
        const folderPath = (data.path ? data.path + '/' : '') + name;
        const safePath = enc(folderPath);
    html += `
          <div class="movie-card"${attrAcao('loadPath', [folderPath])} title="${escHtml(name)}">
            <div class="movie-card-poster-placeholder"><svg class="icon-svg"><use href="#i-folder"></use></svg></div>
            <div class="movie-card-overlay">
              <div class="movie-card-title">${escHtml(name)}</div>
            </div>
          </div>`;
      });
      html += `</div></div>`;
    }

    if (data.videos && data.videos.length > 0) {
      html += `<div class="genre-section">
        <div class="genre-header" style="cursor:default;border:none">
          <div class="genre-title"><svg class="icon-svg"><use href="#i-film"></use></svg> Vídeos <span class="genre-count">(${data.videos.length})</span></div>
        </div>
        <div class="movie-grid">`;
      data.videos.forEach(video => {
        const name = video.Name || '';
        const filePath = (data.path ? data.path + '/' : '') + name;
        const posterSrc = video.poster ? posterUrl(data.path, video.poster) : null;
        html += renderMovieCardHtml(name, filePath, video.Size, posterSrc, video.watched);
      });
      html += `</div></div>`;
    }

    container.innerHTML = html || `<div class="empty-state"><div class="empty-icon"><svg class="icon-svg"><use href="#i-folder"></use></svg></div><h3>Pasta vazia</h3></div>`;
  }

  // ===== EMPTY STATE =====
  function renderEmptyState(container, path) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"><svg class="icon-svg"><use href="#i-folder"></use></svg></div>
        <h3>Pasta vazia</h3>
        <p>Nenhum conteúdo encontrado aqui.</p>
      </div>`;
  }

  // ===== MOVIE CARD HTML =====
  function renderMovieCardHtml(name, filePath, size, posterSrc, watched) {
    const nameClean = name.replace(/\.[^.]+$/, '').replace(/[._]/g, ' ');
    // Use encodeURIComponent for safe embedding in onclick attributes
    // DecodeURIComponent in the handler reverses this safely
    const safePath = enc(filePath);
    const safeName = enc(name);
    const yearMatch = name.match(/(\d{4})/);
    const year = yearMatch ? yearMatch[1] : '';

    let html = `
      <div class="movie-card"${attrAcao('playMovie', [filePath, name])} title="${escHtml(name)}">`;

    if (posterSrc) {
      html += `<img class="movie-card-poster" src="${posterSrc}" alt="${escHtml(name)}" loading="lazy"${attrAcao('imgTrocarPorIrmao', null, false, 'data-act-error')}>`;
      html += `<div class="movie-card-poster-placeholder" style="display:none">${fileIcon(name)}</div>`;
    } else {
      html += `<div class="movie-card-poster-placeholder">${fileIcon(name)}</div>`;
    }
    html += _badgeAssistido({ watched: watched });

    html += `
        <div class="movie-card-overlay">
          <div class="movie-card-title">${escHtml(nameClean)}</div>
          <div class="movie-card-subtitle">${formatSize(size)}${year ? ' • ' + escHtml(year) : ''}</div>
        </div>
      </div>`;
    return html;
  }

  // ===== MOVIE INFO =====
  let currentMovieFolder = null;
  // Arte e ficha do filme aberto, para a TV mostrar algo alem do titulo pelado.
  let _castArt = { folder: null, poster: null, fanart: null, year: null, studio: null, plot: null };
  // Ficha da última série aberta (capa, sinopse e episódios em ordem) e da
  // última listagem de pasta: é daqui que saem a capa e a fila ao transmitir
  // um episódio (ver _arteEPlaylistDoEpisodio).
  let _serieAtual = null;
  let _pastaAtual = null;

  function showMovieInfo(folderPath, event) {
    if (event) event.stopPropagation();
    currentMovieFolder = folderPath;

    // Push history state for movie detail
    if (folderPath !== (history.state && history.state.path)) {
      history.pushState({ path: folderPath }, '', window.location.pathname + window.location.search);
    }

    const overlay = document.getElementById('movieInfoOverlay');
    const content = document.getElementById('movieInfoContent');
    const bg = document.getElementById('movieInfoBg');

    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    content.innerHTML = '<div class="loading" style="min-height:400px"><div class="spinner"></div><span>Carregando informações...</span></div>';
    bg.style.backgroundImage = 'none';

    cachedFetch('/api/movie-detail?path=' + encodeURIComponent(folderPath)).then(detail => {
      if (!detail) {
        content.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg class="icon-svg"><use href="#i-error"></use></svg></div><h3>Erro ao carregar</h3></div>';
        return;
      }

      // Cache VFS só existe pra nuvem: em fonte local a pergunta não se aplica
      // e a requisição seria desperdício.
      if (!isLocalPath(folderPath) && !_cachedSet.has(folderPath)
          && detail.video && detail.video.Name) {
        const filePath = folderPath + '/' + detail.video.Name;
        fetch('/api/check-cached?path=' + encodeURIComponent(filePath)).then(r => r.json()).then(d => {
          if (d.cached) _markCached(folderPath);
        }).catch(() => {});
      }

      const title = detail.title || 'Filme';
      const titleClean = title.replace(/[._]/g, ' ');
      const year = detail.year || '';
      const video = detail.video;
      const poster = detail.poster;
      const fanart = detail.fanart;
      const subtitle = detail.subtitle;
      const nfo = detail.nfo;

      // Guarda o que a TV vai mostrar. E aqui que poster, fanart e a ficha
      // existem — no player so ha o caminho do arquivo de video.
      _castArt = {
        folder: folderPath,
        poster: poster ? folderPath + '/' + poster.Name : null,
        fanart: fanart ? folderPath + '/' + fanart.Name : null,
        year: year || null,
        studio: (nfo && nfo.studios && nfo.studios[0]) || null,
        plot: (nfo && (nfo.tagline || nfo.plot)) || null
      };

      // Background fanart
      if (fanart) {
        bg.style.backgroundImage = cssUrl(posterUrl(folderPath, fanart.Name));
      } else if (poster) {
        bg.style.backgroundImage = cssUrl(posterUrl(folderPath, poster.Name));
      }

      // Poster image
      // Havia placeholder para "sem cartaz", mas nao para "cartaz que falhou
      // ao carregar" — nesse caso sobrava o glifo de imagem quebrada, bem
      // visivel no celular, onde o cartaz fica acima do titulo.
      const semCartaz = '<div class=\'placeholder\'><svg class=\'icon-svg\'><use href=\'#i-film\'></use></svg></div>';
      const posterImg = poster
        ? '<img src="' + posterUrl(folderPath, poster.Name) + '" alt="' + escHtml(titleClean)
          + '"' + attrAcao('imgSemCartaz', null, false, 'data-act-error') + '>'
        : semCartaz.replace(/'/g, '"');

      const videoPath = video ? (folderPath + '/' + video.Name) : null;

      // ---- NFO RICH CONTENT ----
      let nfoHtml = '';

      // Rating stars
      if (nfo && nfo.rating) {
        const r = parseFloat(nfo.rating);
        const full = Math.floor(r / 2);
        const half = r % 2 >= 1 ? 1 : 0;
        const starFull = '<svg class="icon-svg"><use href="#i-star-filled"></use></svg>';
        const starEmpty = '<svg class="icon-svg"><use href="#i-star-empty"></use></svg>';
        const stars = starFull.repeat(full) + (half ? starFull : '') + starEmpty.repeat(Math.max(0, 5 - full - half));
        nfoHtml += `<div class="movie-rating">
          <span class="stars">${stars}</span>
          <span class="num">${nfo.rating}</span>
          ${nfo.votes ? '<span class="votes">(' + nfo.votes + ' votos)</span>' : ''}
        </div>`;
      }

      // Genres do metadado (drama, ação...): chip com o ícone da categoria.
      if (nfo && nfo.genres && nfo.genres.length > 0) {
        nfoHtml += '<div class="movie-genres">';
        nfo.genres.forEach(g => {
          nfoHtml += '<span class="movie-genre-tag">' + genreIcon(g) + escHtml(g) + '</span>';
        });
        nfoHtml += '</div>';
      }

      // Tagline
      if (nfo && nfo.tagline) {
        nfoHtml += '<div class="movie-tagline">"' + escHtml(nfo.tagline) + '"</div>';
      }

      // Plot
      if (nfo && nfo.plot) {
        nfoHtml += '<div class="movie-plot">' + escHtml(nfo.plot) + '</div>';
      }

      // Metadata row: runtime, mpaa, country, year, premiered
      let metaParts = [];
      if (nfo && nfo.runtime) metaParts.push('<span><span class="label">Duração</span> ' + escHtml(nfo.runtime) + ' min</span>');
      if (nfo && nfo.mpaa) metaParts.push('<span><span class="label">Classificação</span> ' + escHtml(nfo.mpaa) + '</span>');
      if (year) metaParts.push('<span><span class="label">Ano</span> ' + escHtml(year) + '</span>');
      if (nfo && nfo.premiered) metaParts.push('<span><span class="label">Estreia</span> ' + escHtml(nfo.premiered) + '</span>');
      if (nfo && nfo.country && nfo.country.length > 0) metaParts.push('<span><span class="label">País</span> ' + escHtml(nfo.country.join(', ')) + '</span>');
      if (nfo && nfo.source) metaParts.push('<span><span class="label">Fonte</span> ' + escHtml(nfo.source) + '</span>');
      if (metaParts.length > 0) {
        nfoHtml += '<div class="movie-meta-row">' + metaParts.join('') + '</div>';
      }

      // Directors / Writers
      let creditsHtml = '';
      if (nfo && nfo.directors && nfo.directors.length > 0) {
        creditsHtml += '<span><span class="label">Diretor</span> ' + escHtml(nfo.directors.join(', ')) + '</span>';
      }
      if (nfo && nfo.writers && nfo.writers.length > 0) {
        creditsHtml += '<span><span class="label">Roteiro</span> ' + escHtml(nfo.writers.join(', ')) + '</span>';
      }
      if (nfo && nfo.studios && nfo.studios.length > 0) {
        creditsHtml += '<span><span class="label">Estúdio</span> ' + escHtml(nfo.studios.join(', ')) + '</span>';
      }
      if (creditsHtml) {
        nfoHtml += '<div class="movie-meta-row">' + creditsHtml + '</div>';
      }

      // Cast
      if (nfo && nfo.actors && nfo.actors.length > 0) {
        nfoHtml += '<div class="movie-cast"><h4>Elenco</h4><div class="movie-cast-grid">';
        // Show top 12 actors
        nfo.actors.slice(0, 12).forEach(a => {
          nfoHtml += '<div class="cast-item"><span class="name">' + escHtml(a.name) + '</span> <span class="role">' + escHtml(a.role || '') + '</span></div>';
        });
        nfoHtml += '</div></div>';
      }

      // Tags do metadado (NFO) = palavras-chave. Rótulo explícito para não
      // confundir com as Tags do app, que o usuário cria na mão.
      if (nfo && nfo.tags && nfo.tags.length > 0) {
        nfoHtml += '<div class="movie-tags"><span class="movie-tags-rotulo">Palavras-chave</span>';
        nfo.tags.forEach(t => { nfoHtml += '<span class="movie-tag">#' + escHtml(t.replace(/[^a-z0-9]/gi, '')) + '</span>'; });
        nfoHtml += '</div>';
      }

      // ---- BUILD FINAL HTML ----
      let html = `
        <div class="movie-info-poster">
          ${posterImg}
        </div>
        <div class="movie-info-details">
          ${year ? '<div class="badge">' + escHtml(year) + '</div>' : ''}
          <h1>${escHtml(titleClean)}</h1>
          ${nfoHtml}

          <div class="movie-info-meta">
            ${video ? '<div class="meta-item"><svg class="icon-svg"><use href="#i-box"></use></svg> <span class="label">Tamanho</span> ' + formatSize(video.Size) + '</div>' : ''}
            ${video ? '<div class="meta-item"><svg class="icon-svg"><use href="#i-film"></use></svg> <span class="label">Formato</span> ' + (video.Name ? video.Name.split('.').pop().toUpperCase() : '') + '</div>' : ''}
            ${subtitle ? '<div class="meta-item"><svg class="icon-svg"><use href="#i-message"></use></svg> <span class="label">Legenda</span> ' + formatSize(subtitle.Size) + '</div>' : '<div class="meta-item"><svg class="icon-svg"><use href="#i-message"></use></svg> <span class="label">Legenda</span> Não</div>'}
          </div>

          <div class="movie-info-actions">
            ${videoPath ? '<button class="btn-play"' + attrAcao('playFromInfo', subtitle ? [videoPath, titleClean, folderPath + '/' + subtitle.Name] : [videoPath, titleClean]) + '><svg class="icon-svg"><use href="#i-play"></use></svg> Assistir</button>' : '<button class="btn-play" disabled style="opacity:0.4"><svg class="icon-svg"><use href="#i-play"></use></svg> Indisponível</button>'}
            ${isLocalPath(folderPath)
                ? '<span class="offline-badge"><svg class="icon-svg"><use href="#i-hard-drive"></use></svg> Local</span>'
                : (_isCached(folderPath) ? '<span class="offline-badge"><svg class="icon-svg"><use href="#i-download"></use></svg> Baixado</span>' : '')}
            ${switchAssistidoHtml(folderPath, !!detail.watched)}
            ${(_me && _me.role === 'admin')
                ? pillTagsHtml(folderPath, titleClean, detail.tags)
                : ''}
            ${(_me && _me.role === 'admin' && isLocalPath(folderPath))
                ? pillCapaHtml(folderPath, titleClean)
                : ''}
            ${(_me && _me.role === 'admin')
                ? switchInfantilHtml(folderPath, detail.infantil, 'Perfil infantil')
                : ''}
            ${detail.collection
                ? '<button class="btn-colecao"' + attrAcao('fichaAbrirColecao', [detail.collection.id]) + ' title="Ver a coleção inteira">'
                  + '<svg class="icon-svg"><use href="#i-layers"></use></svg> '
                  + escHtml(detail.collection.name)
                  + ' <span class="btn-colecao-conta">' + detail.collection.total + '</span></button>'
                : ''}
          </div>
          </div>
        </div>`;

      content.innerHTML = html;

      // Check progress and show resume button
      fetch('/api/progress?path=' + encodeURIComponent(folderPath)).then(r => r.json()).then(prog => {
        // O /api/progress é a fonte da verdade do "assistido": corrige o
        // interruptor caso o movie-detail tenha vindo do cache.
        if (prog && typeof prog.watched === 'boolean') {
          _pintarAssistido(content.querySelector('.movie-info-actions .pill-acao'), prog.watched);
        }
        if (!prog || !prog.position || prog.position <= 0) return;
        const actionsEl = content.querySelector('.movie-info-actions');
        if (!actionsEl) return;
        const pct = (prog.duration > 0) ? Math.round((prog.position / prog.duration) * 100) : 0;
        // Don't show resume if >95% done
        if (pct > 95) return;
        const posStr = formatTime(prog.position, false);
        const resumeBtn = document.createElement('button');
        resumeBtn.className = 'btn-play btn-resume';
        resumeBtn.setAttribute('data-path', videoPath || '');
        resumeBtn.innerHTML = '⏯ Continuar de ' + posStr + ' <span class="resume-pct">(' + pct + '%)</span>';
        resumeBtn.onclick = function() {
          const vPath = this.getAttribute('data-path');
          if (vPath) playFromInfo(vPath, titleClean, subtitle ? (folderPath + '/' + subtitle.Name) : null, prog.position);
        };
        // Insert before the first button
        actionsEl.insertBefore(resumeBtn, actionsEl.firstChild);
      }).catch(function() {});
    });
  }

  function closeMovieInfo() {
    const overlay = document.getElementById('movieInfoOverlay');
    overlay.classList.remove('active');
    document.body.style.overflow = '';
    currentMovieFolder = null;
  }

  // Botão de voltar da ficha do filme: sem ele, no PWA instalado (tela cheia,
  // sem barra do navegador) não havia nenhum jeito visível de sair — só quem
  // sabia do gesto de arrastar da borda ou do Escape (desktop) conseguia.
  // Usa o histórico (showMovieInfo empilha um estado ao abrir) pra voltar pra
  // pasta de onde veio, não só fechar; se não houver histórico pra voltar
  // (ex.: chegou aqui direto por um link), cai pra closeMovieInfo() puro.
  function voltarDoFilme() {
    const overlay = document.getElementById('movieInfoOverlay');
    history.back();
    setTimeout(() => {
      if (overlay.classList.contains('active')) closeMovieInfo();
    }, 300);
  }

  function playFromInfo(videoPath, movieName, subtitlePath, resumePosition) {
    closeMovieInfo();
    playMovie(videoPath, movieName, subtitlePath, resumePosition);
  }

  // Close movie info on Escape
  // Modais do sistema em ordem de precedência pro Escape: o primeiro aberto
  // fecha e nada mais acontece — apertar Escape num modal nunca podia derrubar
  // o player que ficou tocando por trás.
  const _MODAIS_ESCAPE = [
    ['confirmModal', 'closeConfirmModal'],
    ['nuvemWizardModal', 'closeNuvemWizard'],
    ['generoFilmeModal', 'closeGeneroFilmeModal'],
    ['generoNovoModal', 'closeGeneroNovoModal'],
    ['colecaoModal', 'closeColecaoModal'],
    ['backupModal', 'closeBackupModal'],
    ['cacheManagerModal', 'closeCacheManager'],
    ['settingsModal', 'closeSettingsModal'],
    ['sourcesModal', 'closeSourcesModal'],
    ['scrapeModal', 'closeScrapeModal'],
    ['rcloneModal', 'closeRcloneModal'],
    ['changelogModal', 'closeChangelogModal'],
  ];

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (gavetaAberta()) { closeSidebar(); return; }
      for (const [id, fechar] of _MODAIS_ESCAPE) {
        if (document.getElementById(id).classList.contains('active')) {
          window[fechar]();
          return;
        }
      }
      const infoOverlay = document.getElementById('movieInfoOverlay');
      if (infoOverlay.classList.contains('active')) {
        closeMovieInfo();
      } else {
        closePlayer();
      }
    }
  });

  // Close on backdrop click
  document.getElementById('movieInfoOverlay').addEventListener('click', function(e) {
    if (e.target === this) closeMovieInfo();
  });

  // Close confirm modal on backdrop click
  document.getElementById('confirmModal').addEventListener('click', function(e) {
    if (e.target === this) closeConfirmModal();
  });

  // Save progress on page unload (close tab, navigate away)
  window.addEventListener('beforeunload', function() {
    if (_currentPlayFolder) {
      _saveProgress();
    }
  });

