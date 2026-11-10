  // ==================== CONTROLES CUSTOMIZADOS ====================

  function formatTime(t) {
    if (!t || !isFinite(t)) return '00:00';
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const pad = n => String(n).padStart(2, '0');
    return (h > 0 ? pad(h) + ':' : '') + pad(m) + ':' + pad(s);
  }

  function togglePlay() {
    const m = _castMedia();
    if (m) {
      const tocando = (m.playerState === chrome.cast.media.PlayerState.PLAYING
                       || m.playerState === chrome.cast.media.PlayerState.BUFFERING);
      const falhou = function(e) { console.warn('[Cast] play/pause falhou:', e); };
      if (tocando) m.pause(null, function() {}, falhou);
      else m.play(null, function() {}, falhou);
      return;   // o ticker atualiza o botao com o estado real do receiver
    }
    const v = document.getElementById('videoPlayer');
    if (!v) return;
    if (v.paused) v.play().catch(function() {});
    else v.pause();
    document.getElementById('playBtn').innerHTML = v.paused ? '<svg class="icon-svg"><use href="#i-play"></use></svg>' : '<svg class="icon-svg"><use href="#i-pause"></use></svg>';
  }

  function skip(sec) {
    const m = _castMedia();
    if (m) { _castSeekTo(m.getEstimatedTime() + sec); return; }
    const v = document.getElementById('videoPlayer');
    if (!v || !v.duration) return;
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + sec));
  }

  let _volumeBeforeMute = 1;
  function toggleMute() {
    if (_isCasting() && _castSession) {
      // Volume da TV, nao do computador. Em try: se a sessao cair entre o
      // clique e a chamada, o erro nao pode travar o controle.
      try {
        const mudo = !_castSession.isMute();
        _castSession.setMute(mudo).catch(function(e) {
          console.warn('[Cast] setMute falhou:', e);
        });
        const btn = document.getElementById('muteBtn');
        if (btn) {
          btn.innerHTML = mudo
            ? '<svg class="icon-svg"><use href="#i-volume-mute"></use></svg>'
            : '<svg class="icon-svg"><use href="#i-volume"></use></svg>';
        }
        return;
      } catch (e) {
        console.warn('[Cast] mudo indisponivel:', e);
      }
    }
    const v = document.getElementById('videoPlayer');
    if (!v) return;
    if (v.volume === 0) {
      v.volume = _volumeBeforeMute;
      v.muted = false;
    } else {
      _volumeBeforeMute = v.volume;
      v.volume = 0;
      v.muted = true;
    }
    updateMuteBtn();
  }

  function updateMuteBtn() {
    const v = document.getElementById('videoPlayer');
    const btn = document.getElementById('muteBtn');
    if (!v || !btn) return;
    if (v.volume === 0 || v.muted) {
      btn.innerHTML = '<svg class="icon-svg"><use href="#i-volume-mute"></use></svg>';
    } else if (v.volume < 0.5) {
      btn.innerHTML = '<svg class="icon-svg"><use href="#i-volume-low"></use></svg>';
    } else {
      btn.innerHTML = '<svg class="icon-svg"><use href="#i-volume"></use></svg>';
    }
  }

  const SPEEDS = [1, 1.5, 2, 0.5];
  let _speedIndex = 0;
  function cycleSpeed() {
    // Na transmissão a linha do tempo é do receptor, e a API de envio do
    // Cast não muda a taxa de reprodução: avisar é melhor que mexer só no
    // player local (que está parado) e nada acontecer na TV.
    if (_castMedia()) {
      showToast('⏩ A velocidade vale só no player local, não na transmissão', 'info');
      return;
    }
    _speedIndex = (_speedIndex + 1) % SPEEDS.length;
    const v = document.getElementById('videoPlayer');
    if (v) v.playbackRate = SPEEDS[_speedIndex];
    const btn = document.getElementById('speedBtn');
    if (btn) btn.textContent = SPEEDS[_speedIndex] + '×';
  }

  function toggleFullscreen() {
    const container = document.querySelector('.player-container');
    if (!container) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(function() {});
    } else if (container.requestFullscreen) {
      container.requestFullscreen();
    } else if (container.webkitRequestFullscreen) {
      container.webkitRequestFullscreen();
    }
  }

  // Auto-hide controls
  let _controlsTimer = null;
  // Menu dos controles secundarios (so aparece no celular).
  function togglePlayerMore(ev) {
    if (ev) ev.stopPropagation();
    const m = document.getElementById('playerMore');
    if (m) m.classList.toggle('ativo');
    showControls();
  }

  function fecharPlayerMore() {
    const m = document.getElementById('playerMore');
    if (m) m.classList.remove('ativo');
  }

  // Toque fora fecha o menu — sem isto ele ficaria aberto sobre o filme.
  document.addEventListener('click', function(e) {
    const m = document.getElementById('playerMore');
    if (m && m.classList.contains('ativo')
        && !m.contains(e.target) && !e.target.closest('.ctrl-more')) {
      fecharPlayerMore();
    }
    if (!e.target.closest('.ctrl-sub-wrap')) fecharSubtitleMenus();
  });

  function showControls() {
    const bar = document.getElementById('playerControls');
    const hdr = document.querySelector('.player-container .player-header');
    const container = document.querySelector('.player-container');
    if (!bar) return;
    bar.classList.add('force-show');
    if (hdr) hdr.classList.add('force-show');
    if (container) container.classList.add('controls-visible');
    clearTimeout(_controlsTimer);
    const v = document.getElementById('videoPlayer');
    if (v && !v.paused) {
      _controlsTimer = setTimeout(function() {
        bar.classList.remove('force-show');
        if (hdr) hdr.classList.remove('force-show');
        if (container) container.classList.remove('controls-visible');
        // 5s em vez de 3: no celular o dedo leva mais tempo para achar o botao
        // do que o cursor, e nao ha mousemove para trazer a barra de volta.
      }, 5000);
    }
  }
  // Show on any mouse move over player
  document.addEventListener('mousemove', function() {
    const bar = document.getElementById('playerControls');
    if (bar && bar.closest('.player-overlay.active')) showControls();
  });

  // Em tela de toque nao ha hover nem mousemove: sem isto os controles so
  // apareciam no onplay e sumiam sozinhos, sem jeito de trazer de volta.
  document.addEventListener('touchstart', function(e) {
    const overlay = document.getElementById('playerOverlay');
    if (!overlay || !overlay.classList.contains('active')) return;
    // Toque num controle nao deve reiniciar o ciclo antes da acao acontecer.
    if (e.target.closest('.player-controls, .player-header')) return;
    showControls();
  }, { passive: true });

  document.getElementById('playerOverlay').onclick = function(e) {
    // Apenas o botão fechar e Escape fecham — clique fora não fecha
  };

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closePlayer();
    const v = document.getElementById('videoPlayer');
    if (!v || !v.closest('.player-overlay.active')) return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); skip(-10); }
    if (e.key === 'ArrowRight') { e.preventDefault(); skip(10); }
    if (e.key === 'ArrowUp') { e.preventDefault(); const s = document.getElementById('volumeSlider'); if (s) { s.value = Math.min(1, parseFloat(s.value) + 0.1); s.oninput(); } }
    if (e.key === 'ArrowDown') { e.preventDefault(); const s = document.getElementById('volumeSlider'); if (s) { s.value = Math.max(0, parseFloat(s.value) - 0.1); s.oninput(); } }
    if (e.key === 'f') { e.preventDefault(); toggleFullscreen(); }
  });

  // Fullscreen: mantém classe .is-fullscreen no container para CSS
  document.addEventListener('fullscreenchange', function() {
    const container = document.querySelector('.player-container');
    if (!container) return;
    container.classList.toggle('is-fullscreen', !!document.fullscreenElement);
    applySubtitleSize();
  });
  document.addEventListener('webkitfullscreenchange', function() {
    const container = document.querySelector('.player-container');
    if (!container) return;
    container.classList.toggle('is-fullscreen', !!document.webkitFullscreenElement);
    applySubtitleSize();
  });
  // Recalcula a legenda se a janela mudar de tamanho (player redimensionado)
  window.addEventListener('resize', function() {
    applySubtitleSize();
  });

  // ==================== AJUSTES (hub) ====================
  // Os painéis de manutenção eram sete botões no rodapé da sidebar, cada um
  // usado uma vez a cada muito tempo. Agora moram atrás de um item só; o que
  // fica visível é o que se usa toda hora (Atualizar e Sair).
  function openSettingsModal() {
    document.getElementById('settingsModal').classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeSettingsModal() {
    document.getElementById('settingsModal').classList.remove('active');
    document.body.style.overflow = '';
  }

  // Sai do hub e abre o painel escolhido — dois modais abertos ao mesmo tempo
  // deixariam o fundo escurecido duas vezes.
  function fromSettings(abrir) {
    closeSettingsModal();
    abrir();
  }

  document.getElementById('settingsModal').addEventListener('click', function (e) {
    if (e.target === this) closeSettingsModal();
  });

  // ==================== INSTALAR NO CELULAR ====================
  // As instrucoes vivem no desktop, para configurar o celular. O endereco
  // .local e as portas vem do servidor (window.__NET__) — e o mesmo nome que
  // o certificado HTTPS cobre, entao nao ha como divergir do que esta no ar.
  let _phoneUrls = {};

  function openPhoneModal() {
    document.getElementById('phoneModal').classList.add('active');
    document.body.style.overflow = 'hidden';
    _renderPhone();
  }

  function closePhoneModal() {
    document.getElementById('phoneModal').classList.remove('active');
    document.body.style.overflow = '';
  }

  document.getElementById('phoneModal').addEventListener('click', function (e) {
    if (e.target === this) closePhoneModal();
  });

  // Copia sem depender da Clipboard API: ela nao existe em http:// pela rede
  // (so localhost e HTTPS contam como contexto seguro). O textarea e o plano B.
  function _copyText(texto, btn) {
    const aviso = () => {
      if (!btn) return;
      const antes = btn.textContent;
      btn.textContent = 'Copiado!';
      setTimeout(() => { btn.textContent = antes; }, 1400);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(texto).then(aviso).catch(() => _copyTextFallback(texto, aviso));
    } else {
      _copyTextFallback(texto, aviso);
    }
  }

  function _copyTextFallback(texto, aviso) {
    const ta = document.createElement('textarea');
    ta.value = texto;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); aviso(); } catch (e) {}
    document.body.removeChild(ta);
  }

  function copyPhone(btn, qual) {
    _copyText(_phoneUrls[qual] || '', btn);
  }

  function _renderPhone() {
    const box = document.getElementById('phoneBox');
    const net = window.__NET__ || {};
    const host = net.host || '';
    const httpsPort = net.httpsPort || 0;
    const httpPort = net.httpPort || 9187;
    const ip = net.ip || '';
    if (!host || !httpsPort) {
      box.innerHTML = '<div class="user-msg err">O HTTPS não subiu nesta sessão — instalar o app no celular depende dele. Confira o log do servidor.</div>';
      return;
    }
    const porta = httpsPort === 443 ? '' : ':' + httpsPort;
    const appUrl = 'https://' + host + porta;
    const ipUrl = ip ? 'https://' + ip + porta : appUrl;
    const caUrl = 'http://' + host + ':' + httpPort + '/ca.crt';
    _phoneUrls = { app: appUrl, ip: ipUrl, ca: caUrl };

    box.innerHTML =
      '<div class="phone-url">'
      + '<code>' + escHtml(appUrl) + '</code>'
      + '<button class="user-btn" data-act="copyPhone" data-args="[{&quot;$&quot;:&quot;this&quot;},&quot;app&quot;]">Copiar</button>'
      + '</div>'
      + '<div class="src-hint">O celular precisa estar no mesmo Wi-Fi do computador. '
      + 'Use este endereço em vez do IP: o nome .local continua valendo mesmo se o roteador trocar o IP do Mac.</div>'

      + '<div class="user-section-title">iPhone / iPad</div>'
      + '<ol class="phone-steps">'
      + '<li>Instale o certificado do app: abra <a href="' + escHtml(caUrl) + '"><code>' + escHtml(caUrl) + '</code></a> '
      + 'no Safari e permita o download. Depois vá em Ajustes › Geral › VPN e Gerenciamento de Dispositivo, instale o perfil '
      + 'e ative a confiança em Ajustes › Geral › Sobre › Ajustes de Confiança do Certificado.</li>'
      + '<li>Abra <code>' + escHtml(appUrl) + '</code> no Safari — deve abrir sem aviso de certificado.</li>'
      + '<li>Toque em Compartilhar › Adicionar à Tela de Início. O app entra na tela inicial com ícone e nome próprios.</li>'
      + '</ol>'

      + '<div class="user-section-title">Android</div>'
      + '<ol class="phone-steps">'
      + '<li>Instale o certificado do app: abra <a href="' + escHtml(caUrl) + '"><code>' + escHtml(caUrl) + '</code></a> '
      + 'no Chrome. Depois, nas Configurações do Android, busque "certificado" › Instalar certificado › Certificado de CA e escolha o arquivo baixado.</li>'
      + '<li>Abra <code>' + escHtml(appUrl) + '</code> no Chrome.</li>'
      + '<li>Menu ⋮ › Instalar app (ou Adicionar à tela inicial). O Android cria um app de verdade, com ícone próprio.</li>'
      + '</ol>'
      + '<div class="src-hint">Nomes <code>.local</code> só resolvem no Android 12 ou mais novo — em aparelhos mais antigos, use o endereço por IP abaixo.</div>'

      + '<div class="phone-alt">'
      + 'Não conseguiu pelo nome? Use o IP: <code>' + escHtml(ipUrl) + '</code> '
      + '<button class="user-btn" data-act="copyPhone" data-args="[{&quot;$&quot;:&quot;this&quot;},&quot;ip&quot;]">Copiar</button>'
      + '<div>O arquivo é só a parte pública do certificado HTTPS deste computador (gerado pelo mkcert) — '
      + 'o celular passa a confiar no site, e a chave privada nunca sai daqui.</div>'
      + '</div>';
  }

  // ==================== FONTES ====================
  // Prefixo logico das fontes locais (espelha LOCAL_ROOT no servidor).
  const LOCAL_ROOT = '/Local';

  function isLocalPath(path) {
    const p = '/' + String(path || '').replace(/^\/+/, '');
    return p === LOCAL_ROOT || p.indexOf(LOCAL_ROOT + '/') === 0;
  }

  function openSourcesModal() {
    document.getElementById('sourcesModal').classList.add('active');
    document.body.style.overflow = 'hidden';
    _loadSources();
  }

  function closeSourcesModal() {
    document.getElementById('sourcesModal').classList.remove('active');
    document.body.style.overflow = '';
  }

  document.getElementById('sourcesModal').addEventListener('click', function (e) {
    if (e.target === this) closeSourcesModal();
  });

  function _srcMsg(text, kind) {
    const el = document.getElementById('sourcesMsg');
    if (el) { el.textContent = text; el.className = 'user-msg ' + kind; }
  }

  async function _loadSources() {
    const box = document.getElementById('sourcesBox');
    if (!box) return;
    box.innerHTML = '<div class="loading" style="min-height:100px"><div class="spinner"></div><span>Carregando fontes...</span></div>';
    try {
      const [srcData, detData] = await Promise.all([
        fetch('/api/sources').then(r => r.json()),
        fetch('/api/sources/detect').then(r => r.json()).catch(() => ({ candidates: [] }))
      ]);
      _renderSources(srcData.sources || [], (detData && detData.candidates) || []);
    } catch (e) {
      box.innerHTML = '<div class="user-msg err">Não foi possível carregar as fontes.</div>';
    }
  }

  function _renderSources(sources, candidates) {
    let html = '<div class="user-section-title">No acervo</div>';

    sources.forEach(src => {
      const isCloud = src.kind === 'cloud';
      const offline = src.online === false;
      html += '<div class="user-row src-row">'
        + '<div class="src-main">'
        + '<div class="user-name">' + sourceIcon(src.kind) + ' ' + escHtml(src.name)
        + '<span class="user-tag ' + (isCloud ? 'cloud' : 'local') + '">' + (isCloud ? 'nuvem' : 'local') + '</span>'
        + (offline ? '<span class="user-tag offline">desconectada</span>' : '')
        + '</div>'
        + (src.root ? '<div class="src-path">' + escHtml(src.root) + '</div>' : '')
        + '<div class="src-counts">'
        + src.movies + (src.movies === 1 ? ' filme' : ' filmes') + '</div>'
        + '</div>'
        + '<button class="user-btn" title="Escanear só esta fonte"' + attrAcao('scanSource', [src.id]) + '>'
        + '<svg class="icon-svg"><use href="#i-refresh"></use></svg></button>'
        + (isCloud ? '' :
            '<button class="user-btn danger" id="srcDel-' + enc(src.id) + '" '
            + 'title="Tirar do acervo (os arquivos no disco não são apagados)" '
            + attrAcao('removeSource', [src.id, src.name]) + '>'
            + '<svg class="icon-svg"><use href="#i-trash"></use></svg></button>')
        + '</div>';
    });

    if (candidates.length > 0) {
      html += '<div class="user-section-title">Detectadas neste computador</div>'
        + '<div class="src-hint">As marcadas com <svg class="icon-svg"><use href="#i-check"></use></svg> '
        + 'já têm uma pasta <b>Media Server</b> dentro e entram na hora.</div>'
        + '<div class="src-detected">';
      candidates.forEach(c => {
        const icon = c.kind === 'volume' ? '#i-hard-drive' : '#i-folder';
        // Sem a pasta Media Server dentro, o cadastro seria recusado — melhor
        // deixar isso visivel antes do clique.
        const dica = c.pronto ? c.path : c.path + ' — sem uma pasta Media Server dentro';
        html += '<button class="src-detected-btn' + (c.pronto ? ' pronto' : '') + '" '
          + 'title="' + escHtml(dica) + '" '
          + attrAcao('addSource', [c.name, c.path]) + '>'
          + '<svg class="icon-svg"><use href="' + icon + '"></use></svg> ' + escHtml(c.name)
          + (c.pronto
              ? ' <svg class="icon-svg"><use href="#i-check"></use></svg>'
              : ' <svg class="icon-svg"><use href="#i-plus"></use></svg>')
          + '</button>';
      });
      html += '</div>';
    }

    const nomeBiblioteca = (window.__LOGICAL_ROOT__ || '/Media Server').slice(1);
    html += '<div class="user-section-title">Adicionar uma pasta</div>'
      + '<div class="src-hint">A pasta precisa ter uma pasta <b>' + escHtml(nomeBiblioteca) + '</b> dentro '
      + '(ou até dois níveis abaixo), com os filmes nela:<br>'
      + '<code>' + escHtml(nomeBiblioteca) + ' / Filme (ano) / filme.mkv</code> — com o '
      + '<code>.nfo</code> e o <code>poster.jpg</code> junto do vídeo. '
      + 'Arquivo solto também vale, e as tags você cria no app.</div>'
      + '<div class="user-form">'
      + '<input type="text" id="srcName" placeholder="Nome (ex.: HD Externo)" autocomplete="off">'
      + '<input type="text" id="srcPath" placeholder="Caminho (ex.: /Volumes/MeuHD/Filmes)" autocomplete="off">'
      + '<button class="user-btn" data-act="addSourceFromForm">'
      + '<svg class="icon-svg"><use href="#i-plus"></use></svg> Adicionar</button>'
      + '</div>'
      + '<div id="sourcesMsg"></div>';

    document.getElementById('sourcesBox').innerHTML = html;
    const input = document.getElementById('srcPath');
    if (input) {
      input.addEventListener('keydown', e => { if (e.key === 'Enter') addSourceFromForm(); });
    }
  }

  async function _srcPost(url, body) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.status !== 'ok') {
        _srcMsg(data.error || 'Falhou.', 'err');
        return null;
      }
      return data;
    } catch (e) {
      _srcMsg('Erro de rede.', 'err');
      return null;
    }
  }

  async function addSource(name, path) {
    const data = await _srcPost('/api/sources/add', { name: name, path: path });
    if (!data) return;
    _invalidateCatalog();
    await _loadSources();
    _srcMsg(data.message || 'Fonte adicionada.', 'ok');
    showToast('💽 ' + name + ' adicionada ao acervo', '');
  }

  function addSourceFromForm() {
    const pathEl = document.getElementById('srcPath');
    const nameEl = document.getElementById('srcName');
    const path = pathEl ? pathEl.value.trim() : '';
    if (!path) { _srcMsg('Informe o caminho da pasta.', 'err'); return; }
    addSource(nameEl && nameEl.value.trim() ? nameEl.value.trim() : path.split('/').pop(), path);
  }

  // Remocao em duas etapas: o primeiro clique so arma o botao. Tirar uma fonte
  // apaga o catalogo dela (os arquivos no disco ficam), entao vale confirmar.
  let _srcPendingRemove = null;
  async function removeSource(id, name) {
    if (_srcPendingRemove !== id) {
      _srcPendingRemove = id;
      const btn = document.getElementById('srcDel-' + id);
      if (btn) btn.innerHTML = 'Confirmar?';
      _srcMsg('Clique de novo para tirar "' + name + '" do acervo. Os arquivos no disco não são apagados.', 'err');
      setTimeout(() => {
        if (_srcPendingRemove === id) { _srcPendingRemove = null; _loadSources(); }
      }, 6000);
      return;
    }
    _srcPendingRemove = null;
    const data = await _srcPost('/api/sources/remove', { id: id });
    if (!data) return;
    _invalidateCatalog();
    await _loadSources();
    _srcMsg('"' + name + '" saiu do acervo. Os arquivos continuam no disco.', 'ok');
  }

  async function scanSource(id) {
    // /api/refresh responde "scanning" | "already_scanning", nao "ok".
    try {
      const res = await fetch('/api/refresh?source=' + encodeURIComponent(id),
                              { method: 'POST' });
      const data = await res.json();
      if (data.status === 'already_scanning') {
        _srcMsg('Já existe um scan em andamento.', 'err');
        return;
      }
      _srcMsg('Escaneando... o catálogo se atualiza sozinho ao terminar.', 'ok');
      _watchScanProgress();
    } catch (e) {
      _srcMsg('Erro de rede.', 'err');
    }
  }

  // O catalogo mudou: derruba o cache do frontend e redesenha home e sidebar.
  function _invalidateCatalog() {
    _frontCache = {};
    _sidebarGenresLoaded = false;
    loadSidebarGenres(true);
    if (isHomePage(currentPath)) loadPath(currentPath || '', true);
  }

  // ==================== CONTAS ====================
  let _me = null;

  async function _loadMe() {
    try {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      _me = data.user || null;
      if (_me) {
        const chip = document.getElementById('profileSwitchBtn');
        if (chip) {
          chip.style.display = '';
          const img = document.getElementById('profileSwitchAvatar');
          if (img && _me.avatar) img.src = '/static/avatars/' + _me.avatar + '.svg';
          const nome = document.getElementById('profileSwitchName');
          if (nome) nome.textContent = _me.username;
        }
        if (_me.role === 'admin') {
          ['settingsUsers', 'settingsScrape', 'settingsSources', 'settingsBackup'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = '';
          });
        }
      }
    } catch (e) {}
  }

  // Perfis: o seletor "Quem está assistindo?" (/perfis) cuida de criar,
  // editar (avatar, perfil infantil, PIN) e remover.
  function openProfilesManager() {
    window.location.href = '/perfis?gerenciar=1';
  }

  async function switchProfile() {
    try {
      await fetch('/api/profiles/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
    } catch (e) {}
    window.location.replace('/');
  }

  // ==================== UTILS ====================
  async function doLogout() {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ everywhere: false })
      });
    } catch (e) {}
    window.location.replace('/');
  }

  // Escapa tambem aspas: escHtml e usado dentro de atributos (alt="...",
  // title="...", data-*), e textContent->innerHTML so escapava & < >, deixando
  // um titulo/pasta com `x" onload="...` fechar o atributo e rodar script.
  function escHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Encoda para URL E escapa aspas — seguro para embutir em atributos onclick
  // (encodeURIComponent sozinho NÃO escapa ' e " — quebra com nomes como "Toulon's")
  function enc(str) {
    return encodeURIComponent(str).replace(/'/g, '%27').replace(/"/g, '%22');
  }

  // ==================== TOAST ====================
  let toastTimeout = null;
  function showToast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { el.classList.remove('show'); }, 4000);
  }

