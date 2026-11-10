  // ==================== PLAYER ====================
  let currentVideoPath = null;
  let currentSubtitlePath = null;
  let _currentPlayFolder = null;  // folder path for progress tracking
  let _progressSaveTimer = null;

  // Save watch progress to server
  // posExt/durExt vem da TV quando esta transmitindo — o <video> local esta
  // pausado la atras e gravaria a posicao errada em "continuar assistindo".
  function _saveProgress(posExt, durExt) {
    const video = document.getElementById('videoPlayer');
    const temExt = (typeof posExt === 'number' && typeof durExt === 'number' && durExt > 0);
    if (!_currentPlayFolder) return;
    if (!temExt && (!video || !video.duration || video.duration === 0)) return;
    const pos = temExt ? posExt : (video.currentTime || 0);
    if (pos < 5) return;
    const dur = temExt ? durExt : video.duration;
    const pct = (pos / dur) * 100;
    if (pct > 95) {
      _clearProgress(_currentPlayFolder);
      return;
    }
    fetch('/api/progress', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({path: _currentPlayFolder, position: pos, duration: dur}),
      keepalive: true
    }).catch(() => {});
  }

  function _clearProgress(folderPath) {
    fetch('/api/progress', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({path: folderPath, position: 0, duration: 0}),
      keepalive: true
    }).catch(() => {});
  }

  // ═══════════════════════════════════════════════
  //  Google Cast (Chromecast)
  // ═══════════════════════════════════════════════
  let _castSession = null;
  let _castContext = null;
  /** true once the Cast SDK script has been injected into the page */
  let _castSdkInjected = false;
  /** true once __onGCastApiAvailable(true) has fired */
  let _castReady = false;

  /** Detect if we're inside VS Code / Electron shell (no native Cast support) */
  function _isVSCodeWebview() {
    return navigator.userAgent.indexOf('Electron') >= 0
      || navigator.userAgent.indexOf('VS Code') >= 0
      || navigator.userAgent.indexOf('Code/') >= 0;
  }

  function _getBaseUrl() {
    return window.location.origin;
  }

  // Base para a midia que a PROPRIA PAGINA toca — hoje, o AirPlay, que troca o
  // src do <video> daqui.
  //
  // O __HTTP_BASE__ e sempre http de proposito: o Chromecast busca a midia
  // sozinho e nao aceita certificado auto-assinado. Mas numa pagina https um
  // src http e conteudo misto, e o navegador bloqueia — o AirPlay morreria
  // calado. Ali a unica saida e a propria origem. Servindo em http, que e o
  // caso normal na rede de casa, nada muda.
  function _baseMidiaDaPagina() {
    if (window.location.protocol === 'https:') return _getBaseUrl();
    return window.__HTTP_BASE__ || _getBaseUrl();
  }

  function _loadCastSdk() {
    if (_castSdkInjected) return;
    _castSdkInjected = true;
    if (document.getElementById('castSdkScript')) return;
    var script = document.createElement('script');
    script.id = 'castSdkScript';
    script.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
    script.async = true;
    script.onerror = function() {
      console.warn('[Cast] Failed to load Cast SDK');
      _castReady = false;
      var btn = document.getElementById('castBtn');
      if (btn) btn.style.display = 'none';
    };
    document.head.appendChild(script);
  }

  // Called by Cast SDK when API is ready
  window.__onGCastApiAvailable = function(isAvailable) {
    var btn = document.getElementById('castBtn');
    if (!isAvailable) {
      console.log('[Cast] SDK not available on this browser');
      _castReady = false;
      if (btn) btn.style.display = 'none';
      return;
    }
    console.log('[Cast] SDK available');
    _castReady = true;
    try {
      _castContext = cast.framework.CastContext.getInstance();
      _castContext.setOptions({
        receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
      });

      // Listen for session changes
      _castContext.addEventListener(
        cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
        function(event) {
          _onCastSessionStateChanged(event);
        }
      );

      // Initial session check (user might already be casting from another tab)
      var session = _castContext.getCurrentSession();
      if (session) {
        _castSession = session;
        if (btn) { btn.style.display = ''; btn.innerHTML = '<svg class="icon-svg"><use href="#i-cast"></use></svg>'; btn.classList.add('active'); }
      } else {
        if (btn) btn.style.display = '';
      }
    } catch (e) {
      console.warn('[Cast] Init error:', e);
      _castReady = false;
      if (btn) btn.style.display = 'none';
    }
  };

  function _onCastSessionStateChanged(event) {
    var btn = document.getElementById('castBtn');
    switch (event.sessionState) {
      case cast.framework.SessionState.SESSION_STARTED:
      case cast.framework.SessionState.SESSION_RESUMED:
        _castSession = _castContext.getCurrentSession();
        if (btn) { btn.innerHTML = '<svg class="icon-svg"><use href="#i-cast"></use></svg>'; btn.classList.add('active'); }
        console.log('[Cast] Session started');
        break;
      case cast.framework.SessionState.SESSION_ENDED:
        _castSession = null;
        if (btn) { btn.innerHTML = '<svg class="icon-svg"><use href="#i-tv"></use></svg>'; btn.classList.remove('active'); }
        _showCastingPanel(false);
        console.log('[Cast] Session ended');
        break;
      case cast.framework.SessionState.SESSION_START_FAILED:
        console.warn('[Cast] Session start failed');
        break;
      default:
        console.log('[Cast] Session state:', event.sessionState);
    }
  }

  function _isCasting() {
    return _castSession !== null;
  }

  // ===== CONTROLE REMOTO =====
  // Enquanto transmite, o <video> local fica pausado: os controles precisam
  // falar com a sessao do Chromecast, senao mexem num player que ninguem ve.
  function _castMedia() {
    if (!_isCasting()) return null;
    try {
      var s = cast.framework.CastContext.getInstance().getCurrentSession();
      var m = s ? s.getMediaSession() : null;
      // Sem midia carregada ainda (ou ja terminou) nao ha o que comandar.
      return (m && m.playerState !== chrome.cast.media.PlayerState.IDLE) ? m : null;
    } catch (e) {
      return null;
    }
  }

  function _castDuration() {
    var m = _castMedia();
    return (m && m.media && m.media.duration) ? m.media.duration : 0;
  }

  function _castSeekTo(segundos) {
    var m = _castMedia();
    if (!m) return false;
    var dur = _castDuration();
    var req = new chrome.cast.media.SeekRequest();
    req.currentTime = Math.max(0, dur ? Math.min(dur, segundos) : segundos);
    m.seek(req, function() {}, function(e) { console.warn('[Cast] seek falhou:', e); });
    return true;
  }

  // Enquanto transmite, o tempo vem do receiver — o <video> local esta parado.
  let _castTicker = null;
  let _castUltimoSave = 0;
  // Fila de episódios da transmissão: montada no playMovie (página da série
  // ou da temporada) e consumida quando a TV avisa que o episódio terminou.
  let _castPlaylist = null;          // { itens: [{path,title,sub,arte}], idx }
  let _castProximoArmado = false;    // vira "armado" quando algo esta tocando
  let _castUltimoIdle = null;        // mediaSessionId do ultimo IDLE/finished —
                                     // o ticker reavisa o estado a cada 1s e
                                     // sem isso re-marcava "assistido" em laço.
  let _castAvancando = false;        // trava do carregamento do proximo

  function _startCastTicker() {
    if (_castTicker) clearInterval(_castTicker);
    _castTicker = setInterval(function() {
      var m = _castMedia();
      if (!m) return;
      var pos = m.getEstimatedTime();
      var dur = _castDuration();
      var seek = document.getElementById('seekBar');
      var time = document.getElementById('timeDisplay');
      if (seek && dur) seek.value = (pos / dur) * 100;
      if (time) time.textContent = formatTime(pos) + ' / ' + formatTime(dur);
      var btn = document.getElementById('playBtn');
      var tocando = (m.playerState === chrome.cast.media.PlayerState.PLAYING
                     || m.playerState === chrome.cast.media.PlayerState.BUFFERING);
      var icone = tocando
        ? '<svg class="icon-svg"><use href="#i-pause"></use></svg>'
        : '<svg class="icon-svg"><use href="#i-play"></use></svg>';
      if (btn) btn.innerHTML = icone;
      // O botão do painel de transmissão espelha o mesmo estado.
      var cbtn = document.getElementById('castingPlayBtn');
      if (cbtn) cbtn.innerHTML = icone;
      // Fim do episódio: o receiver avisa IDLE/"finished" — com a fila
      // montada, o próximo entra sozinho (sem isso a TV ficava parada).
      // Marca o fim de propósito: a última passada de 30s acima podia ter
      // ficado em 9x% e o episódio/filme ia embora sem virar "assistido".
      if (tocando) {
        _castProximoArmado = true;
      } else if (m.playerState === chrome.cast.media.PlayerState.IDLE
                 && String(m.idleReason || '').toLowerCase() === 'finished'
                 && _castUltimoIdle !== m.mediaSessionId) {
        _castUltimoIdle = m.mediaSessionId;
        _saveProgress(100, 100);
        if (_castProximoArmado) {
          _castProximoArmado = false;
          _castAvancarFila();
        }
      }
      // "Continuar assistindo" precisa do tempo da TV, nao do player parado.
      if (tocando && dur && (Date.now() - _castUltimoSave) > 30000) {
        _castUltimoSave = Date.now();
        _saveProgress(pos, dur);
      }
    }, 1000);
  }

  function _stopCastTicker() {
    if (_castTicker) { clearInterval(_castTicker); _castTicker = null; }
  }

  // Nome do aparelho para o painel. No Android o SDK às vezes devolve o nome
  // do RECEBEDOR ("media receiver") no lugar do Chromecast — melhor ficar
  // sem nome do que mostrar um aparelho que não existe. Tenta a sessão
  // legada antes de desistir.
  function _nomeDaTV() {
    var generico = /media\s*receiver|cast media player/i;
    var nome = '';
    try { nome = _castSession.getCastDevice().friendlyName || ''; } catch (e) {}
    if (nome && !generico.test(nome)) return nome;
    try {
      var legado = _castSession.getSessionObj ? _castSession.getSessionObj() : null;
      var rec = legado && legado.receiver;
      var alternativo = (rec && (rec.friendlyName || rec.displayName)) || '';
      if (alternativo && !generico.test(alternativo)) return alternativo;
    } catch (e) {}
    return '';
  }

  function _showCastingPanel(mostrar) {
    var painel = document.getElementById('castingPanel');
    if (!painel) return;
    painel.classList.toggle('active', !!mostrar);
    if (!mostrar) { _stopCastTicker(); return; }
    var nome = _nomeDaTV();
    var dev = document.getElementById('castingDevice');
    if (dev) dev.textContent = nome ? ('para ' + nome) : '';
    var tit = document.getElementById('castingTitle');
    var nomeFilme = document.getElementById('playerMovieName');
    if (tit) tit.textContent = nomeFilme ? nomeFilme.textContent : 'Transmitindo';
    var img = document.getElementById('castingPoster');
    if (img) {
      // Poster quebrado deixaria um buraco com o icone de imagem falha.
      img.onerror = function() { this.style.display = 'none'; };
      if (_castArt.poster) {
        img.style.display = '';
        img.src = streamUrl(_castArt.poster);
      } else {
        img.removeAttribute('src');
        img.style.display = 'none';
      }
    }
    // Controle remoto da tela: botões de legenda só aparecem quando o filme
    // tem faixa, e o estado (tamanho e CC) nasce igual ao da barra.
    var temLegenda = !!currentSubtitlePath;
    ['castingSubSep', 'castingSizeBtn', 'castingCcBtn'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.style.display = temLegenda ? '' : 'none';
    });
    var ccBtn = document.getElementById('castingCcBtn');
    if (ccBtn) {
      var midia = _castMedia();
      var ligada = midia ? (midia.activeTrackIds || []).indexOf(1) !== -1
                         : (temLegenda && subtitlesEnabled);
      ccBtn.classList.toggle('active', ligada);
    }
    _syncSubtitleControls();
    _startCastTicker();
  }

  function toggleCast() {
    var btn = document.getElementById('castBtn');

    // VS Code / Electron webview doesn't support Chrome Cast SDK
    if (_isVSCodeWebview()) {
      showToast('⚠️ Chromecast não funciona no VS Code. Abra no Chrome/Edge.', 'error');
      return;
    }

    // First click: inject the Cast SDK script
    if (!_castSdkInjected) {
      _loadCastSdk();
      if (btn) btn.innerHTML = '<svg class="icon-svg"><use href="#i-clock"></use></svg>';
      console.log('[Cast] SDK loading, waiting...');
      // Wait up to 8s for the SDK to become ready
      var waited = 0;
      var MAX_WAIT = 40; // 40 * 200ms = 8s
      var interval = setInterval(function() {
        waited++;
        if (_castReady) {
          clearInterval(interval);
          console.log('[Cast] SDK ready after ~' + (waited * 200) + 'ms');
          _doToggleCast();
        } else if (waited >= MAX_WAIT) {
          clearInterval(interval);
          if (btn) btn.innerHTML = '<svg class="icon-svg"><use href="#i-tv"></use></svg>';
          // Check if the script tag actually exists but callback never fired
          var scriptTag = document.getElementById('castSdkScript');
          var hint = scriptTag ? 'SDK loaded but not available' : 'SDK failed to load';
          console.warn('[Cast] Timeout: ' + hint);
          showToast('❌ Chromecast não disponível neste navegador (' + hint + ')', 'error');
        }
      }, 200);
      return;
    }

    // SDK was already injected — if ready, toggle; else show error
    if (!_castReady) {
      console.warn('[Cast] SDK was loaded but never became ready');
      showToast('❌ Chromecast não suportado neste navegador', 'error');
      return;
    }
    _doToggleCast();
  }

  function _doToggleCast() {
    if (_isCasting()) {
      // Stop casting
      _castSession.endSession(true);
      return;
    }
    // Start casting - Cast SDK shows the device picker
    if (typeof cast === 'undefined' || !cast.framework) {
      console.warn('[Cast] Cast SDK not loaded');
      showToast('❌ SDK do Chromecast não carregado', 'error');
      return;
    }
    console.log('[Cast] requestSession()... contextReady=' + !!_castContext + ' ready=' + _castReady + ' casting=' + _isCasting());
    cast.framework.CastContext.getInstance().requestSession()
      .then(function() {
        // Session started - now load media
        _castSession = cast.framework.CastContext.getInstance().getCurrentSession();
        _sendMediaToCast();
      })
      .catch(function(err) {
        if (err.code === 'cancel' || err.code === chrome.cast.ErrorCode.CANCEL) {
          // User cancelled - do nothing
          return;
        }
        console.warn('[Cast] Session request error:', err);
        var errMsg = err.code || err.message || String(err);
        var hint = '';
        if (errMsg === 'session_error') {
          hint = ' — verifique se o Chromecast está na mesma rede Wi-Fi, se o servidor está em HTTPS (localhost:8443) ou HTTP (localhost:8080), e tente abrir chrome://cast no Chrome para testar a conectividade.';
        } else if (errMsg === 'timeout') {
          hint = ' — Chromecast não respondeu a tempo';
        }
        showToast('❌ ' + errMsg + hint, 'error');
      });
  }

  // Chromecast e AirPlay compartilham o mesmo problema: o aparelho que vai
  // tocar o filme busca a midia sozinho, direto do servidor, sem o cookie de
  // sessao do navegador. As duas rotas pedem aqui uma URL assinada, valida so
  // para o arquivo em questao (e a legenda/imagens, se informadas).
  // Assina uma mídia sem depender do <video> local: o próximo episódio da
  // fila chega aqui só com o caminho na mão.
  async function _fetchMediaTokenDe(mediaPath, subPath, extraImages) {
    if (!mediaPath) return null;
    var baseUrl = window.__HTTP_BASE__ || _getBaseUrl();
    var body = { path: mediaPath, subtitle: subPath || '' };
    if (extraImages && extraImages.length) body.images = extraImages;
    var tokens = null;
    try {
      var res = await fetch('/api/cast-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) tokens = await res.json();
    } catch (e) { console.warn('[Cast] falha ao assinar a URL:', e); }
    if (!tokens || !tokens.t) return null;
    return {
      baseUrl: baseUrl,                    // Chromecast: sempre http
      midiaBase: _baseMidiaDaPagina(),     // AirPlay: acompanha a pagina
      // Reconstruído do zero: o src do <video> pode carregar um token velho
      // de uma tentativa anterior, e "...&t=antigo&t=novo" confundia o
      // servidor (403 na TV, tela presa no carregando).
      streamPath: '/api/stream?path=' + encodeURIComponent(mediaPath),
      tokens: tokens,
    };
  }

  // Assina a mídia que está no <video> (envio manual e AirPlay).
  async function _fetchMediaToken(video, extraImages) {
    if (!video || !video.src) return null;
    var urlObj = new URL(video.src, _getBaseUrl());
    var mediaPath = urlObj.searchParams.get('path') || '';
    return _fetchMediaTokenDe(mediaPath, currentSubtitlePath, extraImages);
  }

  // Poster/fanart que acompanham o pedido de token.
  function _castImagensDe(arte) {
    return [arte && arte.poster, arte && arte.fanart].filter(Boolean);
  }

  // ===== PREPARO PARA TV =====
  // O receptor do Chromecast e o AirPlay nao leem MKV — e o audio AC3/EAC3
  // fica mudo ate no Chrome do computador (sem decodificador Dolby). Em vez
  // de recusar o filme, o servidor gera um MP4 com o video copiado (sem
  // re-encodar) e faixa AAC, e guarda em cache: so a primeira transmissao
  // de cada arquivo espera. Ver mediaserver/prepare.py.
  var _prepareWatch = {};

  async function _postPrepare(mediaPath) {
    try {
      var res = await fetch('/api/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: mediaPath })
      });
      return res.ok ? await res.json() : null;
    } catch (e) {
      console.warn('[TV] falha ao pedir o preparo:', e);
      return null;
    }
  }

  async function _getPrepareStatus(mediaPath) {
    try {
      var res = await fetch('/api/prepare-status?path=' + encodeURIComponent(mediaPath));
      return res.ok ? await res.json() : null;
    } catch (e) {
      return null;
    }
  }

  // Avisa quando a conversao terminar, sem segurar o usuario: o AirPlay
  // exige o gesto do toque para abrir o seletor, e esperar minutos aqui o
  // invalidaria — melhor pedir um novo toque quando tudo estiver pronto.
  function _watchPrepare(mediaPath) {
    if (_prepareWatch[mediaPath]) return;
    _prepareWatch[mediaPath] = true;
    (async function() {
      for (var i = 0; i < 600; i++) {          // teto de ~20 min
        await new Promise(function(r) { setTimeout(r, 2000); });
        var s = await _getPrepareStatus(mediaPath);
        if (!s) continue;
        if (s.state === 'ready') {
          delete _prepareWatch[mediaPath];
          showToast('📺 Vídeo pronto — toque no AirPlay de novo', 'info');
          return;
        }
        if (s.state === 'error') {
          delete _prepareWatch[mediaPath];
          showToast('❌ Falha ao preparar o vídeo: ' + (s.error || 'erro'), 'error');
          return;
        }
      }
      delete _prepareWatch[mediaPath];
    })();
  }

  // Devolve a rota certa para o receptor: '/api/prepared' quando o servidor
  // converteu, '/api/stream' quando o original já toca, 'preparing' quando a
  // conversão ainda roda, ou null quando deu erro (já avisado ao usuário).
  // wait=false (AirPlay): não espera aqui — avisa depois, via _watchPrepare;
  // wait=true (Cast): acompanha com progresso até ficar pronto.
  async function _routeForCast(mediaPath, wait) {
    if (!mediaPath) return '/api/stream';
    var st = await _postPrepare(mediaPath);
    if (!st || !st.needed) return '/api/stream';
    if (st.state === 'ready') return '/api/prepared';
    if (st.state === 'error') {
      showToast('❌ Não foi possível preparar o vídeo: ' + (st.error || 'erro'), 'error');
      return null;
    }
    if (!wait) {
      _watchPrepare(mediaPath);
      return 'preparing';
    }
    for (var i = 0; i < 2400; i++) {           // re-encodes longos cabem aqui
      await new Promise(function(r) { setTimeout(r, 1500); });
      var s = await _getPrepareStatus(mediaPath);
      if (!s) continue;
      if (s.state === 'ready') {
        showToast('📺 Vídeo pronto — transmitindo…', 'info');
        return '/api/prepared';
      }
      if (s.state === 'error') {
        showToast('❌ Falha ao preparar o vídeo: ' + (s.error || 'erro'), 'error');
        return null;
      }
      if (s.state === 'idle') {                // servidor reiniciou no meio
        await _postPrepare(mediaPath);
        continue;
      }
      showToast('⏳ Preparando o vídeo para a TV…'
                + (s.percent > 0 ? ' ' + s.percent + '%' : ''), 'info');
    }
    showToast('❌ A preparação demorou demais', 'error');
    return null;
  }

