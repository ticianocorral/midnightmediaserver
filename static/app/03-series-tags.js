  // ==================== SÉRIES ====================
  function renderSerieView(seriePath) {
    const container = document.getElementById('content');
    const hero = document.getElementById('hero');
    hero.style.display = 'block';
    document.getElementById('breadcrumb').innerHTML =
      '<a onclick="loadPath(\'\')"><svg class="icon-svg"><use href="#i-home"></use></svg> Início</a>'
      + ' <span class="sep">›</span> <span id="serieBcNome">...</span>';

    cachedFetch('/api/serie?path=' + encodeURIComponent(seriePath)).then(serie => {
      if (!serie) {
        container.innerHTML = '<div class="empty-state"><div class="empty-icon">'
          + '<svg class="icon-svg"><use href="#i-error"></use></svg></div>'
          + '<h3>Série não encontrada</h3></div>';
        return;
      }
      _heroCapa(serie.poster, serie.fanart);
      // Guarda a ficha da série: capa, sinopse e episódios em ordem. A
      // transmissão usa isso para mostrar a capa da série (o episódio não
      // tem pôster próprio) e para emendar o próximo episódio no fim.
      (function() {
        var epsSerie = [];
        serie.temporadas.forEach(function(t) {
          (t.episodios || []).forEach(function(e) { epsSerie.push(e); });
        });
        _serieAtual = {
          path: seriePath,
          name: serie.name || '',
          poster: serie.poster || null,
          fanart: serie.fanart || null,
          overview: serie.overview || null,
          year: serie.year || null,
          episodios: epsSerie,
        };
      })();
      document.getElementById('serieBcNome').textContent = serie.name;
      document.getElementById('heroTitle').textContent = serie.name;
      const isAdmin = _me && _me.role === 'admin';
      const totalEps = serie.temporadas.reduce((n, t) => n + t.episodios.length, 0);
      document.getElementById('heroDesc').innerHTML =
        (isAdmin ? '<span class="colecao-acoes">'
          + switchInfantilHtml(seriePath, serie.infantil, 'Perfil infantil',
                               'vale para a série inteira: todas as temporadas e episódios')
          + '</span>' : '')
        + '<svg class="icon-svg"><use href="#i-tv"></use></svg> '
        + serie.temporadas.length + (serie.temporadas.length === 1 ? ' temporada · ' : ' temporadas · ')
        + totalEps + (totalEps === 1 ? ' episódio' : ' episódios')
        + (serie.overview ? '<div class="colecao-sinopse">' + escHtml(serie.overview) + '</div>' : '');

      if (!serie.temporadas.length) {
        container.innerHTML = '<div class="empty-state"><div class="empty-icon">'
          + '<svg class="icon-svg"><use href="#i-tv"></use></svg></div>'
          + '<h3>Nenhum episódio ainda</h3>'
          + '<p>Dentro da pasta da série, crie as pastas das temporadas '
          + '(S01, S02...) e ponha os episódios dentro delas.</p></div>';
        return;
      }
      let html = '';
      serie.temporadas.forEach(temp => {
        html += '<div class="genre-section">'
          + '<div class="genre-header" style="cursor:default;border:none">'
          + '<div class="genre-title">' + escHtml(temp.nome)
          + ' <span class="genre-count">(' + temp.episodios.length + ')</span></div></div>'
          + '<div class="episodio-lista">';
        temp.episodios.forEach(ep => {
          // Episódio pela metade: retoma de onde parou e oferece "Já assisti".
          const temProgresso = (ep.position || 0) > 5 &&
            (!ep.duration || (ep.position / ep.duration) <= 0.95);
          const posStr = Math.floor((ep.position || 0) / 60) + ':' +
            String(Math.floor((ep.position || 0) % 60)).padStart(2, '0');
          const pct = (ep.duration > 0) ? Math.round((ep.position / ep.duration) * 100) : 0;
          html += '<button class="episodio-linha' + (temProgresso ? ' em-progresso' : '') + '" '
            + 'onclick="playMovie(decodeURIComponent(\'' + enc(ep.path) + '\'), '
            + 'decodeURIComponent(\'' + enc(ep.title) + '\')'
            + (ep.subtitle ? ', decodeURIComponent(\'' + enc(ep.subtitle) + '\')' : ', null')
            + (temProgresso ? ', ' + Math.floor(ep.position) : ', null')
            + ', decodeURIComponent(\'' + enc(ep.path) + '\')'
            + ')" title="' + escHtml(ep.title) + '">'
            + '<span class="episodio-play"><svg class="icon-svg"><use href="#i-'
            + (temProgresso ? 'pause' : 'play') + '"></use></svg></span>'
            + '<span class="episodio-titulo">' + escHtml(ep.title)
            + (temProgresso ? ' <span class="episodio-pos">' + posStr + '</span>' : '')
            + (ep.plot ? '<span class="episodio-sinopse" style="display:block;font-size:.8em;opacity:.65;font-weight:400;white-space:normal">'
                + escHtml(ep.plot.length > 180 ? ep.plot.slice(0, 180) + '…' : ep.plot) + '</span>' : '')
            + '</span>'
            + '<span class="episodio-tamanho">' + formatSize(ep.size) + '</span>'
            + (ep.subtitle ? '<span class="episodio-cc" title="Com legenda">CC</span>' : '')
            + (temProgresso
                ? '<span class="episodio-progresso" title="' + pct + '% assistido">'
                  + '<span style="width:' + pct + '%"></span></span>'
                : '')
            + (temProgresso
                ? '<span class="episodio-assistido" onclick="event.stopPropagation();'
                  + 'limparProgressoEpisodio(decodeURIComponent(\'' + enc(ep.path) + '\'), this)" '
                  + 'title="Remove o progresso deste episódio">Já assisti</span>'
                : (ep.watched
                    // Selo do assistido: clicável para RETIRAR a marcação.
                    ? '<span class="episodio-assistido episodio-visto" '
                      + 'onclick="event.stopPropagation();'
                      + '_desmarcarEpisodio(decodeURIComponent(\'' + enc(ep.path) + '\'), this)" '
                      + 'title="Assistido — clique para retirar a marcação">✓ Assistido</span>'
                    : ''))
            + '</button>';
        });
        html += '</div></div>';
      });
      container.innerHTML = html;
    });
  }

  // Retira a marcação "assistido" do episódio: apaga a linha de progresso
  // (o /api/watched com on:false — a mesma tecla que o switch da ficha).
  function _desmarcarEpisodio(epPath, el) {
    fetch('/api/watched', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: epPath, on: false }),
    }).then(r => r.json()).then(data => {
      if (data && data.status === 'error') throw new Error(data.error || 'erro');
      if (el) el.remove();
      if (_serieAtual && _serieAtual.path) {
        _invalidateCache('/api/serie?path=' + encodeURIComponent(_serieAtual.path));
      }
      showToast('✖ Fora de assistidos', 'success');
    }).catch(() => showToast('Erro ao retirar a marcação', 'error'));
  }

  function limparProgressoEpisodio(epPath, el) {
    fetch('/api/progress', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: epPath, position: 0, duration: 0 }),
      keepalive: true,
    }).then(() => {
      const linha = el.closest('.episodio-linha');
      if (!linha) return;
      linha.classList.remove('em-progresso');
      linha.querySelectorAll('.episodio-progresso, .episodio-assistido, .episodio-pos')
        .forEach(x => x.remove());
      const play = linha.querySelector('.episodio-play use');
      if (play) play.setAttribute('href', '#i-play');
      // Vira o selo "✓ Assistido" (com a mesma saída de marcação).
      linha.insertAdjacentHTML('beforeend',
        '<span class="episodio-assistido episodio-visto" '
        + 'onclick="event.stopPropagation();'
        + '_desmarcarEpisodio(decodeURIComponent(\'' + enc(epPath) + '\'), this)" '
        + 'title="Assistido — clique para retirar a marcação">✓ Assistido</span>');
      if (_serieAtual && _serieAtual.path) {
        _invalidateCache('/api/serie?path=' + encodeURIComponent(_serieAtual.path));
      }
      showToast('✔ Episódio marcado como assistido', 'success');
    }).catch(() => showToast('Erro ao limpar progresso', 'error'));
  }

  // ==================== TAGS DO APP ====================
  // Criadas na interface, independentes de pastas. Uma tag reúne filmes de
  // qualquer fonte; filmes soltos entram pelo path do próprio arquivo.

  function renderGeneroView(generoId) {
    const container = document.getElementById('content');
    const hero = document.getElementById('hero');
    hero.style.display = 'block';
    _heroCapa(null, null);
    document.getElementById('heroBg').style.backgroundImage = 'none';
    hero.style.background = 'linear-gradient(135deg, var(--bg2) 0%, var(--surface) 100%)';
    document.getElementById('breadcrumb').innerHTML =
      '<a onclick="loadPath(\'\')"><svg class="icon-svg"><use href="#i-home"></use></svg> Início</a>'
      + ' <span class="sep">›</span> <span id="generoBcNome">...</span>';

    cachedFetch('/api/genero?id=' + generoId).then(gen => {
      if (!gen) {
        container.innerHTML = '<div class="empty-state"><div class="empty-icon">'
          + '<svg class="icon-svg"><use href="#i-error"></use></svg></div>'
          + '<h3>Tag não encontrada</h3></div>';
        return;
      }
      document.getElementById('generoBcNome').textContent = gen.name;
      document.getElementById('heroTitle').innerHTML =
        '<svg class="icon-svg"><use href="#i-layers"></use></svg> ' + escHtml(gen.name);
      const isAdmin = _me && _me.role === 'admin';
      document.getElementById('heroDesc').innerHTML =
        (isAdmin ? '<span class="colecao-acoes">'
          + '<button class="colecao-acao-btn" onclick="openGeneroRenomear(' + gen.id
          + ', decodeURIComponent(\'' + enc(gen.name) + '\'))">'
          + '<svg class="icon-svg"><use href="#i-gear"></use></svg> Renomear</button>'
          + '<button class="colecao-acao-btn perigo" onclick="excluirGenero(' + gen.id
          + ', decodeURIComponent(\'' + enc(gen.name) + '\'))">'
          + '<svg class="icon-svg"><use href="#i-trash"></use></svg> Excluir</button>'
          + '</span>' : '')
        + '<svg class="icon-svg"><use href="#i-film"></use></svg> ' + gen.movies.length
        + (gen.movies.length === 1 ? ' filme' : ' filmes');

      if (!gen.movies.length) {
        container.innerHTML = '<div class="empty-state"><div class="empty-icon">'
          + '<svg class="icon-svg"><use href="#i-film"></use></svg></div>'
          + '<h3>Nenhum filme nesta tag</h3>'
          + '<p>Abra a ficha de um filme (ou um card no A-Z) e toque em '
          + '<b>Tags</b> para colocá-lo aqui.</p></div>';
        return;
      }
      let html = '<div class="genre-section"><div class="movie-grid">';
      gen.movies.forEach(m => {
        const titulo = escHtml((m.title || m.name).replace(/[._]/g, ' '));
        const poster = m.poster ? posterUrl(m.path, m.poster) : null;
        const clique = m.is_file
          ? 'playMovie(decodeURIComponent(\'' + enc(m.path) + '\'), decodeURIComponent(\'' + enc(m.title || m.name) + '\'))'
          : 'showMovieInfo(decodeURIComponent(\'' + enc(m.path) + '\'), event)';
        html += '<div class="movie-card" onclick="' + clique + '" title="' + titulo + '">'
          + (poster
              ? '<img class="movie-card-poster" src="' + poster + '" alt="' + titulo
                + '" loading="lazy" onerror="this.style.display=\'none\';'
                + 'this.nextElementSibling.style.display=\'flex\'">'
                + '<div class="movie-card-poster-placeholder" style="display:none">'
                + '<svg class="icon-svg"><use href="#i-film"></use></svg></div>'
              : '<div class="movie-card-poster-placeholder" style="display:flex">'
                + '<svg class="icon-svg"><use href="#i-film"></use></svg></div>')
          + _badgeAssistido(m)
          + '<div class="movie-card-overlay"><div class="movie-card-title">' + titulo + '</div>'
          + '<div class="movie-card-subtitle">'
          + (m.is_file ? 'arquivo solto' : (m.year ? escHtml(m.year) : 'Filme'))
          + '</div></div></div>';
      });
      container.innerHTML = html + '</div></div>';
    });
  }

  // ── Modal: atribuir tags a um filme ──
  let _generoAlvo = null;

  function openGeneroFilmeModal(alvo, titulo) {
    _generoAlvo = { alvo: alvo, titulo: titulo };
    document.getElementById('generoFilmeTitulo').textContent = titulo;
    const corpo = document.getElementById('generoFilmeCorpo');
    corpo.innerHTML = '<div class="loading" style="min-height:90px"><div class="spinner"></div><span>Carregando...</span></div>';
    document.getElementById('generoFilmeMsg').innerHTML = '';
    document.getElementById('generoFilmeModal').classList.add('active');
    document.body.style.overflow = 'hidden';
    _invalidateCache('/api/generos');
    _invalidateCache('/api/generos/de?alvo=' + encodeURIComponent(alvo));
    Promise.all([
      cachedFetch('/api/generos'),
      cachedFetch('/api/generos/de?alvo=' + encodeURIComponent(alvo)),
    ]).then(([todos, meus]) => {
      _generoRenderChips(todos, (meus && meus.ids) || []);
    }).catch(() => {
      corpo.innerHTML = '<div class="user-msg err">Falha ao carregar tags.</div>';
    });
  }

  function _generoRenderChips(todos, meusIds) {
    const corpo = document.getElementById('generoFilmeCorpo');
    let chips = '';
    todos.forEach(g => {
      const on = meusIds.includes(g.id);
      chips += '<button class="genero-chip' + (on ? ' on' : '') + '" '
        + 'onclick="_generoToggleChip(this, ' + g.id + ')">' + escHtml(g.nome) + '</button>';
    });
    corpo.innerHTML = (todos.length
        ? '<div class="genero-chips">' + chips + '</div>'
        : '<p class="colecao-dica">Nenhuma tag criada ainda — crie a primeira abaixo.</p>')
      + '<div class="genero-nova-linha">'
      + '<input id="generoNovoNome" type="text" maxlength="40" placeholder="Nova tag...">'
      + '<button class="rclone-action-btn" onclick="_generoCriarEDar()">Criar</button>'
      + '</div>'
      + '<div class="colecao-passos"><span></span>'
      + '<button class="rclone-action-btn primary" onclick="closeGeneroFilmeModal()">Pronto</button>'
      + '</div>';
    corpo.dataset.meus = JSON.stringify(meusIds);
  }

  function _generoToggleChip(chip, id) {
    const corpo = document.getElementById('generoFilmeCorpo');
    const meus = JSON.parse(corpo.dataset.meus || '[]');
    const i = meus.indexOf(id);
    if (i >= 0) { meus.splice(i, 1); chip.classList.remove('on'); }
    else { meus.push(id); chip.classList.add('on'); }
    corpo.dataset.meus = JSON.stringify(meus);
  }

  function _generoCriarEDar() {
    const input = document.getElementById('generoNovoNome');
    const nome = (input.value || '').trim();
    if (!nome) return;
    fetch('/api/generos/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: nome }),
    }).then(r => r.json()).then(data => {
      if (data.status !== 'ok') {
        document.getElementById('generoFilmeMsg').innerHTML =
          '<div class="user-msg err">' + escHtml(data.error || 'Erro.') + '</div>';
        return;
      }
      const corpo = document.getElementById('generoFilmeCorpo');
      const meus = JSON.parse(corpo.dataset.meus || '[]');
      if (!meus.includes(data.id)) meus.push(data.id);
      input.value = '';
      // Recarrega a lista para incluir a tag nova já marcada.
      _invalidateCache('/api/generos');
      cachedFetch('/api/generos').then(todos => _generoRenderChips(todos, meus));
      _sidebarGenerosRefresh();
    }).catch(() => {
      document.getElementById('generoFilmeMsg').innerHTML =
        '<div class="user-msg err">Falha de conexão.</div>';
    });
  }

  function closeGeneroFilmeModal() {
    const corpo = document.getElementById('generoFilmeCorpo');
    const meus = JSON.parse(corpo.dataset.meus || '[]');
    if (_generoAlvo) {
      fetch('/api/generos/atribuir', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alvo: _generoAlvo.alvo, generos: meus }),
      }).then(r => r.json()).then(data => {
        if (data.status === 'ok') {
          showToast('✅ ' + data.message, 'success');
          (JSON.parse(document.getElementById('generoFilmeCorpo').dataset.meus || '[]'))
            .forEach(gid => _invalidateCache('/api/genero?id=' + gid));
          _invalidateCache('/api/genres');
          _invalidateCache('/api/all-movies');
        } else showToast('Erro: ' + (data.error || 'falha'), 'error');
      }).catch(() => showToast('Erro ao salvar tags', 'error'));
    }
    document.getElementById('generoFilmeModal').classList.remove('active');
    document.body.style.overflow = '';
    _generoAlvo = null;
    loadSidebarGenres(true);
    // Se estamos numa tag ou no A-Z, recarrega para refletir mudanças.
    if (currentPath && currentPath.indexOf(GENERO_PREFIXO) === 0) loadPath(currentPath, true);
  }
  document.getElementById('generoFilmeModal').addEventListener('click', function(e) {
    if (e.target === this) closeGeneroFilmeModal();
  });

  // ── Modal: criar tag (barra lateral) ──
  function openGeneroNovoModal() {
    document.getElementById('generoNovoInput').value = '';
    document.getElementById('generoNovoMsg').innerHTML = '';
    document.getElementById('generoNovoModal').classList.add('active');
    document.body.style.overflow = 'hidden';
    setTimeout(() => document.getElementById('generoNovoInput').focus(), 80);
  }
  function closeGeneroNovoModal() {
    document.getElementById('generoNovoModal').classList.remove('active');
    document.body.style.overflow = '';
  }
  document.getElementById('generoNovoModal').addEventListener('click', function(e) {
    if (e.target === this) closeGeneroNovoModal();
  });
  function criarGeneroDoModal() {
    const input = document.getElementById('generoNovoInput');
    const nome = (input.value || '').trim();
    if (!nome) return;
    fetch('/api/generos/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: nome }),
    }).then(r => r.json()).then(data => {
      if (data.status !== 'ok') {
        document.getElementById('generoNovoMsg').innerHTML =
          '<div class="user-msg err">' + escHtml(data.error || 'Erro.') + '</div>';
        return;
      }
      closeGeneroNovoModal();
      showToast('✅ ' + data.message, 'success');
      _invalidateCache('/api/generos');
      loadSidebarGenres(true);
    }).catch(() => {
      document.getElementById('generoNovoMsg').innerHTML =
        '<div class="user-msg err">Falha de conexão.</div>';
    });
  }

  function _sidebarGenerosRefresh() { loadSidebarGenres(true); }

  function openGeneroRenomear(id, nomeAtual) {
    _confirmarGenericoComInput('Renomear tag', nomeAtual, function(novoNome) {
      if (!novoNome || novoNome === nomeAtual) return;
      fetch('/api/generos/renomear', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, nome: novoNome }),
      }).then(r => r.json()).then(data => {
        if (data.status === 'ok') {
          showToast('✅ ' + data.message, 'success');
          _invalidateCache('/api/genero?id=' + id);
          _invalidateCache('/api/generos');
          _invalidateCache('/api/genres');
          loadPath(GENERO_PREFIXO + id, true); loadSidebarGenres(true);
        }
        else showToast('Erro: ' + (data.error || 'falha'), 'error');
      }).catch(() => showToast('Erro ao renomear', 'error'));
    });
  }

  function excluirGenero(id, nome) {
    _confirmarGenerico('Excluir tag?',
      'A tag "' + nome + '" vai embora. Os filmes não são tocados.',
      function() {
        fetch('/api/generos/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id }),
        }).then(r => r.json()).then(data => {
          if (data.status === 'ok') {
          showToast('✅ ' + data.message, 'success');
          _invalidateCache('/api/genero?id=' + id);
          _invalidateCache('/api/generos');
          _invalidateCache('/api/genres');
          loadPath(''); loadSidebarGenres(true);
        }
          else showToast('Erro: ' + (data.error || 'falha'), 'error');
        }).catch(() => showToast('Erro ao excluir tag', 'error'));
      });
  }

  // ==================== PERFIL INFANTIL ====================
  // Interruptor com rótulo claro: "Perfil infantil" + ON/OFF. O mesmo
  // componente serve para a ficha do filme e para a página da série
  // (na série, marcar vale para a série inteira — todas as temporadas).
  function switchInfantilHtml(alvo, ativo, rotulo, nota) {
    return '<span class="switch-infantil" onclick="toggleInfantil(this)">'
      + '<span class="switch-texto">'
      + '<span class="switch-rotulo">' + escHtml(rotulo || 'Perfil infantil') + '</span>'
      + (nota ? '<span class="switch-nota">' + escHtml(nota) + '</span>' : '')
      + '</span>'
      + '<span class="switch-track' + (ativo ? ' on' : '') + '" data-alvo="' + escHtml(alvo) + '" '
      + 'role="switch" aria-checked="' + (ativo ? 'true' : 'false') + '">'
      + '<span class="switch-knob"></span></span>'
      + '<span class="switch-estado">' + (ativo ? 'Sim' : 'Não') + '</span>'
      + '</span>';
  }

  function toggleInfantil(switchEl) {
    const raiz = switchEl.closest('.switch-infantil') || switchEl;
    const track = raiz.querySelector('.switch-track');
    const alvo = track.dataset.alvo;
    if (!alvo) return;
    const on = !track.classList.contains('on');
    raiz.style.pointerEvents = 'none';
    fetch('/api/infantil/marcar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alvo: alvo, on: on }),
    }).then(r => r.json()).then(data => {
      if (data.status === 'ok') {
        track.classList.toggle('on', data.on);
        track.setAttribute('aria-checked', data.on ? 'true' : 'false');
        const estado = raiz.querySelector('.switch-estado');
        if (estado) estado.textContent = data.on ? 'Sim' : 'Não';
        showToast((data.on ? '👶 No perfil infantil' : 'Fora do perfil infantil'), 'success');
        _invalidateCache('/api/all-movies');
        _invalidateCache('/api/recent-movies');
        _invalidateCache('/api/genres');
        _invalidateCache('/api/series');
      } else {
        showToast('Erro: ' + (data.error || 'falha'), 'error');
      }
    }).catch(() => showToast('Erro ao marcar', 'error'))
      .finally(() => { raiz.style.pointerEvents = ''; });
  }

  // ── Controles em pílula da ficha do filme ──────────────────
  // Mesma casca do interruptor do perfil infantil. "Já assisti" é interruptor
  // de verdade (marca/desmarca); "Tags" é um botão com a contagem que abre o
  // modal. Assim os dois deixam de parecer botõezinhos soltos na linha.

  function switchAssistidoHtml(folderPath, assistido) {
    return '<span class="pill-acao" onclick="toggleAssistido(this)">'
      + '<span class="switch-texto">'
      + '<span class="switch-rotulo">Já assisti</span>'
      + '<span class="switch-nota">' + (assistido ? 'Fora do continuar' : 'Marcar como visto') + '</span>'
      + '</span>'
      + '<span class="switch-track' + (assistido ? ' on' : '') + '" data-alvo="' + escHtml(folderPath) + '" '
      + 'role="switch" aria-checked="' + (assistido ? 'true' : 'false') + '">'
      + '<span class="switch-knob"></span></span>'
      + '<span class="switch-estado">' + (assistido ? 'Sim' : 'Não') + '</span>'
      + '</span>';
  }

  // Repinta o interruptor a partir de um estado conhecido — o /api/progress
  // que a ficha já buscava corrige um cache velho do movie-detail.
  function _pintarAssistido(raiz, on) {
    if (!raiz) return;
    const track = raiz.querySelector('.switch-track');
    if (track) {
      track.classList.toggle('on', on);
      track.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    const estado = raiz.querySelector('.switch-estado');
    if (estado) estado.textContent = on ? 'Sim' : 'Não';
    const nota = raiz.querySelector('.switch-nota');
    if (nota) nota.textContent = on ? 'Fora do continuar' : 'Marcar como visto';
  }

  // Selo "assistido" dos cards: verde no canto do poster. O estado vem do
  // servidor (watch_progress encerrado) em todas as listagens — A-Z, home,
  // coleções, TAGs e arquivos da ficha.
  function _badgeAssistido(m) {
    return (m && m.watched)
      ? '<div class="movie-card-assistido" title="Já assistido">'
        + '<svg class="icon-svg"><use href="#i-check"></use></svg></div>'
      : '';
  }

  // Tira o filme da fileira "Continuar Assistindo" sem esperar a home recarregar.
  function _removerDoContinueAssistindo(folderPath) {
    const cwSection = document.getElementById('continueWatchingSection');
    if (!cwSection || cwSection.style.display === 'none') return;
    const cards = cwSection.querySelectorAll('.movie-card');
    for (let i = 0; i < cards.length; i++) {
      const onclick = cards[i].getAttribute('onclick') || '';
      if (onclick.indexOf(folderPath) !== -1
          || onclick.indexOf(encodeURIComponent(folderPath)) !== -1) {
        cards[i].remove();
        break;
      }
    }
    if (cwSection.querySelectorAll('.movie-card').length === 0) {
      cwSection.style.display = 'none';
    }
  }

  function toggleAssistido(pillEl) {
    const raiz = pillEl.closest('.pill-acao') || pillEl;
    const track = raiz.querySelector('.switch-track');
    const alvo = track && track.dataset.alvo;
    if (!alvo) return;
    const on = !track.classList.contains('on');
    raiz.style.pointerEvents = 'none';
    fetch('/api/watched', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: alvo, on: on }),
    }).then(r => r.json()).then(data => {
      if (data.status === 'ok') {
        _pintarAssistido(raiz, data.watched);
        if (data.watched) {
          const actionsEl = document.querySelector('.movie-info-actions');
          const resumeBtn = actionsEl && actionsEl.querySelector('.btn-resume');
          if (resumeBtn) resumeBtn.remove();
        }
        showToast(data.watched ? '✔ Marcado como assistido' : 'Fora de assistidos', 'success');
        // O selo de assistido aparece em TODAS as listagens (A-Z, home,
        // coleções, TAGs, series) — invalida o cache inteiro na vez seguinte.
        try {
          for (var k in _frontCache) { delete _frontCache[k]; }
        } catch (e) { /* _frontCache indisponivel */ }
        if (data.watched) _removerDoContinueAssistindo(alvo);
      } else {
        showToast('Erro: ' + (data.error || 'falha'), 'error');
      }
    }).catch(() => showToast('Erro ao marcar', 'error'))
      .finally(() => { raiz.style.pointerEvents = ''; });
  }

  function pillCapaHtml(alvo, titulo) {
    return '<button class="pill-acao pill-acao-btn" '
      + 'onclick="openCapaModal(decodeURIComponent(\'' + enc(alvo) + '\'), decodeURIComponent(\'' + enc(titulo) + '\'))" title="Escolher outra capa do TMDB">'
      + '<span class="pill-acao-icone"><svg class="icon-svg"><use href="#i-film"></use></svg></span>'
      + '<span class="switch-texto"><span class="switch-rotulo">Capa</span>'
      + '<span class="switch-nota">Trocar</span></span>'
      + '</button>';
  }

  function pillTagsHtml(alvo, titulo, tags) {
    const n = (tags || []).length;
    const nota = n === 0 ? 'Sem tags' : (n + (n === 1 ? ' tag' : ' tags'));
    return '<button class="pill-acao pill-acao-btn" '
      + 'onclick="openGeneroFilmeModal(decodeURIComponent(\'' + enc(alvo) + '\'), '
      + 'decodeURIComponent(\'' + enc(titulo) + '\'))" title="Tags do filme">'
      + '<span class="pill-acao-icone"><svg class="icon-svg"><use href="#i-layers"></use></svg></span>'
      + '<span class="switch-texto"><span class="switch-rotulo">Tags</span>'
      + '<span class="switch-nota">' + escHtml(nota) + '</span></span>'
      + '</button>';
  }

  function genreIcon(name) {
    const icons = {
      'terror': '<svg class="icon-svg"><use href="#i-ghost"></use></svg>', 'horror': '<svg class="icon-svg"><use href="#i-ghost"></use></svg>',
      'comedia': '<svg class="icon-svg"><use href="#i-smile"></use></svg>', 'comédia': '<svg class="icon-svg"><use href="#i-smile"></use></svg>',
      'acao': '<svg class="icon-svg"><use href="#i-zap"></use></svg>', 'acção': '<svg class="icon-svg"><use href="#i-zap"></use></svg>', 'ação': '<svg class="icon-svg"><use href="#i-zap"></use></svg>',
      'drama': '<svg class="icon-svg"><use href="#i-frown"></use></svg>',
      'ficcao': '<svg class="icon-svg"><use href="#i-rocket"></use></svg>', 'ficção': '<svg class="icon-svg"><use href="#i-rocket"></use></svg>', 'sci-fi': '<svg class="icon-svg"><use href="#i-rocket"></use></svg>',
      'shows': '<svg class="icon-svg"><use href="#i-music"></use></svg>', 'series': '<svg class="icon-svg"><use href="#i-music"></use></svg>', 'séries': '<svg class="icon-svg"><use href="#i-music"></use></svg>',
      'documentario': '<svg class="icon-svg"><use href="#i-video"></use></svg>', 'documentário': '<svg class="icon-svg"><use href="#i-video"></use></svg>',
      'romance': '<svg class="icon-svg"><use href="#i-heart"></use></svg>',
      'aventura': '<svg class="icon-svg"><use href="#i-map"></use></svg>',
      'animacao': '<svg class="icon-svg"><use href="#i-palette"></use></svg>', 'animação': '<svg class="icon-svg"><use href="#i-palette"></use></svg>',
      'suspense': '<svg class="icon-svg"><use href="#i-eye"></use></svg>',
      'trash': '<svg class="icon-svg"><use href="#i-skull"></use></svg>',
      'acervo': '<svg class="icon-svg"><use href="#i-book"></use></svg>',
    };
    const key = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return icons[key] || '<svg class="icon-svg"><use href="#i-film"></use></svg>';
  }

