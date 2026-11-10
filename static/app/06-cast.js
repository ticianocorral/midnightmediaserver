  // ===== AIRPLAY (iOS/Safari) =====
  // O Chromecast nao tem como funcionar em navegador de iPhone: a Apple nao
  // expoe a API que o SDK do Google usa, nem no Safari nem no Chrome-iOS, que
  // roda sobre o mesmo motor da Apple. AirPlay e o caminho nativo da Apple —
  // so aparece quando ha um receptor real na rede (Apple TV, TV com AirPlay 2
  // embutido, ou um Roku, que suporta AirPlay 2 mesmo sem ser da Apple).
  function _airplaySupported(video) {
    return !!(video && typeof video.webkitShowPlaybackTargetPicker === 'function');
  }

  function _setupAirplay(video) {
    var btn = document.getElementById('airplayBtn');
    if (!btn) return;
    if (!_airplaySupported(video)) { btn.style.display = 'none'; return; }
    btn.style.display = '';

    // playMovie chama isto a cada filme; sem a trava os listeners iam
    // empilhando a cada reprodução (e o aviso de conexão repetia junto).
    if (video._msAirplaySetup) return;
    video._msAirplaySetup = true;

    // O evento existe pra afinar a visibilidade quando o Safari sabe que nao
    // ha receptor por perto — mas nem toda versao dispara ele de forma
    // confiavel, entao o botao comeca visivel (o pior caso e abrir o seletor
    // nativo vazio, que o proprio iOS ja trata) e so esconde se o evento
    // afirmar que nao ha nada.
    video.addEventListener('webkitplaybacktargetavailabilitychanged', function(e) {
      btn.style.display = (e.availability === 'not-available') ? 'none' : '';
    });

    // Enquanto transmite via AirPlay, o proprio <video> continua sendo o
    // controle — o WebKit repassa play/pause/seek pro receptor por baixo dos
    // panos, sem precisar de um ticker separado como o Cast usa. Aqui só
    // refletimos o estado no botão e confirmamos a conexão: o seletor nativo
    // fecha calado, e sem o aviso parecia que o toque não tinha feito nada.
    video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', function() {
      var wireless = video.webkitCurrentPlaybackTargetIsWireless;
      btn.classList.toggle('active', wireless);
      if (wireless) {
        showToast('📡 Transmitindo via AirPlay', 'info');
        _airplayRepararSePreciso(video);
      }
    });
  }

  // Monta a URL assinada que o receptor vai buscar, troca no <video> e
  // devolve a posicao/estado de reproducao quando o novo buffer carregar.
  // Trocar o src reinicia o buffer, entao guardamos e restauramos a posicao.
  function _airplayTrocarSrc(video, info, rota, mediaPath) {
    var pos = video.currentTime;
    var tocando = !video.paused;
    video.addEventListener('loadedmetadata', function retomar() {
      video.removeEventListener('loadedmetadata', retomar);
      video.currentTime = pos;
      if (tocando) video.play().catch(function() {});
    });
    video.src = info.midiaBase + (rota === '/api/prepared'
      ? '/api/prepared?path=' + encodeURIComponent(mediaPath)
      : info.streamPath) + '&t=' + encodeURIComponent(info.tokens.t);
    if (currentSubtitlePath && info.tokens.sub) {
      var track = document.getElementById('subtitleTrack');
      if (track) {
        track.src = info.midiaBase + '/api/subtitle?path=' + encodeURIComponent(currentSubtitlePath)
                  + '&t=' + encodeURIComponent(info.tokens.sub);
      }
    }
  }

  // Se a transmissao foi iniciada pelo seletor NATIVO do iOS (ícone do player
  // da Apple, fora do botão do app), o src ainda é a URL sem token: o receptor
  // busca ela sem o cookie da sessao, leva 401 e fica preso no "carregando"
  // pra sempre. Ao detectar a conexão wireless, reassina e troca o src sem
  // fechar a sessao — o Roku/Apple TV refaz a busca já autorizado.
  async function _airplayRepararSePreciso(video) {
    if (!video || !video.src) return;
    if (/[?&]t=/.test(video.src)) return;                  // nosso botão já assinou
    if (video.src.indexOf('/api/stream') < 0) return;      // só URL do próprio app
    if (video._msAirplayReparando) return;
    video._msAirplayReparando = true;
    try {
      var mediaPath = new URL(video.src, _getBaseUrl()).searchParams.get('path') || '';
      var info = await _fetchMediaToken(video, []);
      if (!info) { showToast('❌ Não foi possível autorizar o AirPlay', 'error'); return; }
      var rota = await _routeForCast(mediaPath, false);
      if (rota === null) return;
      if (rota === 'preparing') { _watchPrepare(mediaPath); return; }
      _airplayTrocarSrc(video, info, rota, mediaPath);
    } catch (e) {
      console.warn('[AirPlay] falha ao reassinar a URL:', e);
    } finally {
      video._msAirplayReparando = false;
    }
  }

  async function toggleAirplay() {
    var video = document.getElementById('videoPlayer');
    if (!_airplaySupported(video)) return;

    // Troca o src pra versao assinada antes de abrir o seletor: se o usuario
    // escolher o Roku, ele vai buscar essa URL sozinho, sem cookie. Trocar o
    // src reinicia o buffer, entao guardamos e restauramos a posicao.
    var info = await _fetchMediaToken(video, []);
    if (!info) {
      // Sem o token assinado o receptor nao consegue buscar a midia (ele nao
      // tem o cookie da sessao) e a TV fica presa no "conectando" pra sempre.
      // Melhor avisar aqui do que mandar o aparelho pra um beco sem saida.
      showToast('❌ Não foi possível autorizar o AirPlay', 'error');
      return;
    }
    // O seletor nativo precisa do gesto do toque ainda "quente": se o
    // arquivo precisa de conversao (MKV/E-AC3) e ela ainda não terminou,
    // não dá pra segurar o usuário aqui — avisa e pede um novo toque quando
    // ficar pronto (o _watchPrepare mostra o aviso).
    var mediaPath = new URL(video.src, _getBaseUrl()).searchParams.get('path') || '';
    var rota = await _routeForCast(mediaPath, false);
    if (rota === null) return;
    if (rota === 'preparing') {
      showToast('⏳ Preparando o vídeo para a TV… aviso quando ficar pronto', 'info');
      return;
    }
    _airplayTrocarSrc(video, info, rota, mediaPath);
    // O seletor nativo do iOS precisa ser chamado enquanto o toque do usuario
    // ainda "conta" como gesto ativo — por isso roda logo em seguida, sem mais
    // nenhuma espera depois do fetch acima.
    video.webkitShowPlaybackTargetPicker();
  }

  // O visual da legenda na TV sai da MESMA escolha da barra (tamanho e cor):
  // o receiver desenha do jeito que o TextTrackStyle pedir, então o usuário
  // regula uma vez no computador e vale também no sofá. Chamado no load da
  // mídia e de novo a cada troca de tamanho/cor com o filme já rolando.
  function _estiloLegendaCast() {
    var estilo = new chrome.cast.media.TextTrackStyle();
    estilo.foregroundColor = subtitleColors[subtitleColorIndex].castColor;
    estilo.fontGenericFamily = chrome.cast.media.TextTrackFontGenericFamily.SANS_SERIF;
    estilo.fontStyle = chrome.cast.media.TextTrackFontStyle.NORMAL;
    estilo.fontScale = subtitleSizes[subtitleSizeIndex].castScale;
    // A caixa vem do backgroundColor, nao da "window": o receiver padrao do
    // Google ignora windowType/windowColor, e apostar neles deixava a legenda
    // sem fundo nenhum na TV — branco puro, ilegivel em cena clara.
    // O preco e perder o canto arredondado: o backgroundColor pinta um
    // retangulo colado no texto. Fundo visivel vale mais que canto bonito.
    estilo.backgroundColor = '#000000D9';   // preto a ~85%
    estilo.windowType = chrome.cast.media.TextTrackWindowType.NONE;
    // Sombra como seguro: se ate o backgroundColor for ignorado, o texto
    // ainda se separa do fundo. Onde a caixa aparece, ela some contra o preto.
    estilo.edgeType = chrome.cast.media.TextTrackEdgeType.DROP_SHADOW;
    estilo.edgeColor = '#000000FF';
    return estilo;
  }

  // Reaplica o estilo na sessão em andamento, sem mexer nas faixas ativas.
  // "Não mexer" é OMITIR o activeTrackIds (a API rejeita null; não fornecido =
  // tracks como estão). O receiver aceita trocar o estilo a qualquer momento —
  // a legenda na TV muda sem recarregar o vídeo.
  function _aplicarEstiloLegendaCast() {
    var m = _castMedia();
    if (!m) return;
    try {
      var faixas = (m.activeTrackIds && m.activeTrackIds.length)
        ? m.activeTrackIds : undefined;
      m.editTracksInfo(
        new chrome.cast.media.EditTracksInfoRequest(faixas, _estiloLegendaCast()),
        function() { console.log('[Cast] estilo da legenda atualizado'); },
        function(e) { console.warn('[Cast] estilo da legenda falhou:', e); });
    } catch (e) {
      console.warn('[Cast] estilo da legenda indisponível:', e);
    }
  }

  async function _sendMediaToCast() {
    if (!_castSession) return;
    var video = document.getElementById('videoPlayer');
    if (!video || !video.src) return;

    var info = await _fetchMediaToken(video, _castImagensDe(_castArt));
    if (!info) {
      showToast('❌ Não foi possível autorizar o envio para a TV', 'error');
      return;
    }
    var mediaPath = new URL(video.src, _getBaseUrl()).searchParams.get('path') || '';
    var titleEl = document.getElementById('playerMovieName');
    var titulo = titleEl ? titleEl.textContent : 'Midnight Media Server';
    try {
      var ok = await _castEnviarMidia(info, mediaPath, currentSubtitlePath,
                                      titulo, _castArt, video.currentTime);
      if (!ok) return;
    } catch (err) {
      console.warn('[Cast] Load media error:', err);
      showToast('❌ Erro ao transmitir', 'error');
      return;
    }
    console.log('[Cast] Media loaded on Chromecast');
    showToast('📡 Transmitindo para Chromecast', 'info');
    // Pause local video while casting
    video.pause();
    _showCastingPanel(true);
    _prepararProximoDaFila();
    // Force enable subtitle track after load (some receivers ignore activeTrackIds).
    // Retry a cada 2s até ~30s: o receiver só associa o track depois que o vídeo
    // carregou/bufferizou (stream via rclone→nuvem demora a começar).
    if (currentSubtitlePath) {
      _forceCastSubtitles(1, 0);
    }
  }

  // Envia uma mídia já assinada para a TV. Separado do _sendMediaToCast
  // porque o próximo episódio da fila não passa pelo <video> local: título,
  // arte, legenda e posição vêm do item da fila.
  // Devolve false quando a rota não ficou pronta (conversão falhou etc.).
  async function _castEnviarMidia(info, mediaPath, subPath, titulo, arte, tempo) {
    // MKV/E-AC3/HEVC não toca direto nos receptores: antes de a TV buscar
    // os bytes, o servidor gera o MP4 (H.264 + AAC) e a sessão espera.
    var rota = await _routeForCast(mediaPath, true);
    if (rota !== '/api/stream' && rota !== '/api/prepared') return false;
    var baseUrl = info.baseUrl, castTokens = info.tokens;

    // Construct absolute URL for Chromecast (over HTTP)
    var contentUrl = baseUrl + (rota === '/api/prepared'
      ? '/api/prepared?path=' + encodeURIComponent(mediaPath)
      : info.streamPath) + '&t=' + encodeURIComponent(castTokens.t);

    // Build media info
    var mediaInfo = new chrome.cast.media.MediaInfo(contentUrl, 'video/mp4');
    mediaInfo.streamType = chrome.cast.media.StreamType.BUFFERED;

    // MovieMediaMetadata no lugar do generico: e o que faz a TV desenhar a
    // ficha (arte, ano, estudio) em vez de uma tela vazia com o titulo.
    // Episódio entra com a ficha da série: o arquivo não tem pôster próprio.
    var meta = new chrome.cast.media.MovieMediaMetadata();
    meta.title = titulo || 'Midnight Media Server';
    arte = arte || {};
    if (arte.year) meta.releaseDate = String(arte.year) + '-01-01';
    if (arte.studio) meta.studio = arte.studio;
    if (arte.plot) meta.subtitle = arte.plot;
    else if (arte.year) meta.subtitle = String(arte.year);

    // As imagens tambem saem por /api/stream: sem o token assinado a TV recebe
    // 401 e fica sem arte.
    var imgs = castTokens.imgs || {};
    var arteImgs = [];
    [arte.fanart, arte.poster].forEach(function(caminho) {
      if (!caminho || !imgs[caminho]) return;
      arteImgs.push(new chrome.cast.Image(
        baseUrl + '/api/stream?path=' + encodeURIComponent(caminho)
        + '&t=' + encodeURIComponent(imgs[caminho])));
    });
    if (arteImgs.length) meta.images = arteImgs;
    mediaInfo.metadata = meta;

    // A duração do <video> local só vale quando é o MESMO arquivo — no
    // episódio da fila o player de baixo ainda é o anterior.
    var video = document.getElementById('videoPlayer');
    var localPath = '';
    try {
      localPath = new URL(video.src, _getBaseUrl()).searchParams.get('path') || '';
    } catch (e) { /* sem src local, sem duração */ }
    if (video && video.duration && localPath === mediaPath) {
      mediaInfo.duration = video.duration;
    }

    // Add subtitle track if available
    if (subPath) {
      console.log('[Cast] Adding subtitle track:', subPath);
      var subUrl = baseUrl + '/api/subtitle?path=' + encodeURIComponent(subPath)
                 + '&t=' + encodeURIComponent(castTokens.sub || '');
      var track = new chrome.cast.media.Track(1, chrome.cast.media.TrackType.TEXT);
      track.trackContentId = subUrl;
      track.trackContentType = 'text/vtt';
      track.name = 'Português';
      track.language = 'pt';
      track.subtype = chrome.cast.media.TextTrackType.SUBTITLES;
      mediaInfo.tracks = [track];
      // Legenda no espirito da Apple TV: texto sobre caixa escura, sem
      // contorno nas letras (contorno e o visual "Classic"). Tamanho e cor
      // vêm da escolha do usuário na barra — ver _estiloLegendaCast.
      mediaInfo.textTrackStyle = _estiloLegendaCast();
      console.log('[Cast] Subtitle URL:', subUrl);
    }

    var request = new chrome.cast.media.LoadRequest(mediaInfo);
    // activeTrackIds vive no LoadRequest, nao no MediaInfo — estava no lugar
    // errado, e por isso a legenda dependia inteiramente do editTracksInfo
    // depois do load.
    if (subPath) {
      request.activeTrackIds = [1];
    }
    // Start from current position if the video has played
    if (tempo > 0) {
      request.currentTime = tempo;
    }

    await _castSession.loadMedia(request);
    // Arma o "próximo episódio": quando a TV avisar que acabou (IDLE/
    // finished), a fila decide se emenda o seguinte.
    _castProximoArmado = true;
    return true;
  }

  // ── Próximo episódio (player do navegador/AirPlay) ─────────
  // Nos últimos segundos de um episódio que tem sucessor aparece o cartão
  // "Próximo episódio" com a contagem; ao acabar o episódio ele começa sozinho,
  // a menos que a pessoa cancele. "Assistir agora" pula direto.
  const PROXIMO_AVISO_SEG = 20;
  let _proximoCancelado = false;

  function _proximoDaFila() {
    return (_castPlaylist && _castPlaylist.itens[_castPlaylist.idx + 1]) || null;
  }

  function _esconderCartaoProximo() {
    const card = document.getElementById('proximoCard');
    if (card) card.style.display = 'none';
  }

  function _atualizarCartaoProximo(video) {
    const prox = _proximoDaFila();
    const btn = document.getElementById('nextBtn');
    if (btn) btn.style.display = prox ? '' : 'none';
    const card = document.getElementById('proximoCard');
    if (!card) return;
    const resta = video && video.duration ? video.duration - video.currentTime : Infinity;
    if (!prox || _proximoCancelado || _isCasting() || !(resta > 0 && resta <= PROXIMO_AVISO_SEG)) {
      if (card.style.display !== 'none') _esconderCartaoProximo();
      return;
    }
    document.getElementById('proximoTitulo').textContent = prox.title || '';
    document.getElementById('proximoConta').textContent = 'Começa em ' + Math.ceil(resta) + ' s';
    if (card.style.display === 'none') {
      card.style.display = '';
      const agora = document.getElementById('proximoAgora');
      if (agora) { try { agora.focus({ preventScroll: true }); } catch (e) {} }
    }
  }

  function cancelarProximo() {
    _proximoCancelado = true;
    _esconderCartaoProximo();
  }

  // Botão "Assistir agora" e o ▶| da barra de controles.
  function proximoEpisodio() {
    const video = document.getElementById('videoPlayer');
    if (!_proximoDaFila()) return;
    if (video && video.duration) _saveProgress(video.currentTime, video.duration);
    _esconderCartaoProximo();
    _avancarFilaNoPlayer();
  }

  // Emenda o próximo episódio da fila quando o atual termina na TV. A fila
  // nasce do playMovie (página da série ou da temporada) — ver
  // _arteEPlaylistDoEpisodio.
  function _castAvancarFila() {
    if (!_castPlaylist || _castAvancando) return;
    var proximo = _castPlaylist.itens[_castPlaylist.idx + 1];
    if (!proximo) {
      showToast('🏁 Fim dos episódios — não há próximo', 'info');
      return;
    }
    _castAvancando = true;
    _castPlaylist.idx += 1;
    showToast('▶ Próximo episódio: ' + proximo.title, 'info');
    _castCarregarEpisodio(proximo).then(function(ok) {
      if (!ok) showToast('❌ Não foi possível tocar o próximo episódio', 'error');
    }).catch(function(e) {
      console.warn('[Cast] próximo episódio falhou:', e);
      showToast('❌ Não foi possível tocar o próximo episódio', 'error');
    }).then(function() {
      _castAvancando = false;
    });
  }

  // Emenda o próximo episódio quando quem terminou foi o player do aparelho
  // (assistindo no navegador ou pelo AirPlay). No Chromecast este caminho não
  // roda: lá o ticker vê IDLE/"finished" e chama _castAvancarFila.
  // playMovie remonta a ficha e a fila pelo novo arquivo, re-assina o token e
  // troca a chave de progresso para o episódio que começa.
  function _avancarFilaNoPlayer() {
    if (!_castPlaylist || _castAvancando) return;
    var proximo = _castPlaylist.itens[_castPlaylist.idx + 1];
    if (!proximo) return;
    _castAvancando = true;
    _proximoCancelado = false;
    _esconderCartaoProximo();
    showToast('▶ Próximo episódio: ' + proximo.title, 'info');
    playMovie(proximo.path, proximo.title, proximo.sub || '', 0, proximo.path);
    // AirPlay: o src nasce sem token (o <video> local usa o cookie da sessão)
    // e o receptor busca a URL sozinho — sem assinar, ele leva 401 e fica
    // preso no "carregando". É o mesmo remédio do seletor nativo do iOS.
    var video = document.getElementById('videoPlayer');
    if (video && video.webkitCurrentPlaybackTargetIsWireless) {
      _airplayRepararSePreciso(video);
    }
    _castAvancando = false;
  }

  // Vai preparando o próximo episódio da fila em segundo plano: quando ele
  // entrar (fim do atual), a conversão já estará pronta (ou quase) e o
  // usuário não fica olhando a tela final esperando o preparo terminar.
  function _prepararProximoDaFila() {
    if (!_castPlaylist) return;
    var proximo = _castPlaylist.itens[_castPlaylist.idx + 1];
    if (!proximo) return;
    _postPrepare(proximo.path);
  }

  async function _castCarregarEpisodio(item) {
    if (!_castSession) return false;
    var info = await _fetchMediaTokenDe(item.path, item.sub || '', _castImagensDe(item.arte));
    if (!info) return false;
    var ok = await _castEnviarMidia(info, item.path, item.sub || '',
                                    item.title, item.arte, 0);
    if (!ok) return false;
    // O painel (título, capa, legenda) passa a valer para o episódio novo,
    // e o progresso salvo é o dele (chave por arquivo).
    currentVideoPath = item.path;
    currentSubtitlePath = item.sub || null;
    _currentPlayFolder = item.path;
    if (item.arte) _castArt = item.arte;
    var tit = document.getElementById('playerMovieName');
    if (tit) tit.textContent = item.title;
    _showCastingPanel(true);
    if (item.sub) _forceCastSubtitles(1, 0);
    _prepararProximoDaFila();
    return true;
  }

  // Arte da série + fila de episódios quando o vídeo é um episódio da série
  // aberta (o arquivo não tem pôster próprio — a capa é a da série). Sem
  // série reconhecida, tenta a listagem de pasta aberta por último.
  function _arteEPlaylistDoEpisodio(filePath) {
    _castPlaylist = null;
    var eps = _serieAtual && _serieAtual.episodios;
    if (eps && eps.length) {
      var idx = -1;
      for (var i = 0; i < eps.length; i++) {
        if (eps[i].path === filePath) { idx = i; break; }
      }
      if (idx >= 0) {
        var arte = {
          folder: filePath.substring(0, filePath.lastIndexOf('/')),
          poster: _serieAtual.poster,
          fanart: _serieAtual.fanart,
          year: _serieAtual.year,
          studio: null,
          plot: _serieAtual.overview,
        };
        if (!_castArt.poster && !_castArt.fanart) _castArt = arte;
        _castPlaylist = {
          itens: eps.map(function(e) {
            return { path: e.path, title: e.title, sub: e.subtitle || null, arte: arte };
          }),
          idx: idx,
        };
        return;
      }
    }
    _castPlaylist = _playlistDaPastaAberta(filePath);
  }

  // Fila a partir da listagem da pasta (temporada) aberta: ordem da pasta,
  // só quando o nome parece episódio (S01E02...) — filme solto não emenda.
  function _playlistDaPastaAberta(filePath) {
    var pasta = _pastaAtual && _pastaAtual.path;
    if (!pasta || filePath.indexOf(pasta + '/') !== 0) return null;
    var nome = filePath.slice(pasta.length + 1);
    if (nome.indexOf('/') !== -1 || !/S\d{1,2}E\d{1,2}/i.test(nome)) return null;
    var idx = -1;
    var itens = [];
    (_pastaAtual.videos || []).forEach(function(v) {
      var n = v.Name || v.name || '';
      if (!n || !/\.(mp4|mkv|avi|mov|m4v|webm)$/i.test(n)) return;
      if (n === nome) idx = itens.length;
      itens.push({
        path: pasta + '/' + n,
        title: n.replace(/\.[^.]+$/, '').replace(/[._]/g, ' '),
        sub: null,
        arte: _castArt,
      });
    });
    if (idx < 0 || itens.length < 2) return null;
    return { itens: itens, idx: idx };
  }

  function clearBufferTimer() {
    // No-op: _waitForBuffer was removed, but keep for cleanup compatibility
  }

  // Tenta habilitar a legenda no receiver até ~30s (a cada 2s).
  // O receiver do Chromecast só associa o track de texto depois que o vídeo
  // está carregado — com stream via rclone→nuvem isso pode levar vários segundos.
  function _forceCastSubtitles(trackId, attempt) {
    if (attempt > 15) {
      console.warn('[Cast] Subtitles: desistindo após ' + attempt + ' tentativas');
      return;
    }
    try {
      var s = cast.framework.CastContext.getInstance().getCurrentSession();
      if (!s) { console.warn('[Cast] Sem sessão (tentativa ' + attempt + '), tentando de novo...'); setTimeout(function() { _forceCastSubtitles(trackId, attempt + 1); }, 2000); return; }
      var m = s.getMediaSession();
      if (!m) { console.warn('[Cast] Sem media session (tentativa ' + attempt + '), tentando de novo...'); setTimeout(function() { _forceCastSubtitles(trackId, attempt + 1); }, 2000); return; }
      console.log('[Cast] Media session OK (tentativa ' + attempt + '), activeTrackIds:', m.activeTrackIds);
      var trackReq = new chrome.cast.media.EditTracksInfoRequest([trackId]);
      m.editTracksInfo(trackReq, function() {
        console.log('[Cast] Legendas habilitadas via editTracksInfo (tentativa ' + attempt + ')');
      }, function(err) {
        console.warn('[Cast] editTracksInfo falhou (tentativa ' + attempt + '):', err);
        setTimeout(function() { _forceCastSubtitles(trackId, attempt + 1); }, 2000);
      });
    } catch(e) {
      console.warn('[Cast] editTracksInfo erro (tentativa ' + attempt + '):', e);
      setTimeout(function() { _forceCastSubtitles(trackId, attempt + 1); }, 2000);
    }
  }

  // Aplica a legenda no <track> do player local (liga automático se houver)
  function _applySubtitleTrack(subtitlePath) {
    const track = document.getElementById('subtitleTrack');
    const parent = track.parentNode;
    const newTrack = document.createElement('track');
    newTrack.id = 'subtitleTrack';
    newTrack.kind = 'subtitles';
    newTrack.srclang = 'pt-BR';
    newTrack.label = 'Português';
    newTrack.default = true;
    if (subtitlePath) {
      newTrack.src = '/api/subtitle?path=' + encodeURIComponent(subtitlePath);
    }
    parent.replaceChild(newTrack, track);

    // Se houver legenda, já liga automático
    if (subtitlePath) {
      subtitlesEnabled = true;
      const t = document.getElementById('subtitleTrack');
      if (t) t.track.mode = 'showing';
      document.getElementById('subtitleToggleBtn').classList.add('active');
    } else {
      subtitlesEnabled = false;
      document.getElementById('subtitleToggleBtn').classList.remove('active');
    }
    updateSubtitleButton(subtitlePath);
  }

  // ── Ponte para o player nativo da TV ─────────────────────────
  // O app de Android TV injeta window.MediaServerTV. Quando ele existe, quem
  // toca o filme e o ExoPlayer nativo e nao o <video> desta pagina: a WebView
  // do Android nao e confiavel com MKV e faixas AC3/DTS, que e o grosso do
  // acervo, e o ExoPlayer decodifica por hardware.
  //
  // A URL vai assinada pelo mesmo /api/cast-token do Chromecast, entao o player
  // nativo busca os bytes sozinho, sem depender do cookie de sessao da pagina.
  function _tvNativoDisponivel() {
    return !!(window.MediaServerTV && typeof window.MediaServerTV.play === 'function');
  }

  // Capa e contexto do que vai tocar, para o player nativo mostrar além do
  // título. Filme: a ficha aberta (_castArt, só vale se for a pasta dele).
  // Episódio: a capa e o nome da série aberta.
  function _tvArte(filePath) {
    const pasta = filePath.substring(0, filePath.lastIndexOf('/'));
    if (_castArt.poster && _castArt.folder === pasta) {
      return { poster: _castArt.poster, contexto: _castArt.year ? String(_castArt.year) : '' };
    }
    const eps = _serieAtual && _serieAtual.episodios;
    if (eps && eps.some(function (e) { return e.path === filePath; })) {
      return { poster: _serieAtual.poster || null, contexto: _serieAtual.name || '' };
    }
    return { poster: null, contexto: '' };
  }

  async function _tvTocarNativo(filePath, movieName, subtitlePath, resumePosition) {
    let tokens = null;
    const arte = _tvArte(filePath);
    try {
      const res = await fetch('/api/cast-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, subtitle: subtitlePath || '',
                               images: arte.poster ? [arte.poster] : [] })
      });
      if (res.ok) tokens = await res.json();
    } catch (e) { /* tratado logo abaixo */ }
    if (!tokens || !tokens.t) {
      showToast('Nao foi possivel preparar o video para a TV', 'error');
      return;
    }
    const base = window.location.origin;
    const assinada = (rota, caminho, token) => base + rota
      + '?path=' + encodeURIComponent(caminho) + '&t=' + encodeURIComponent(token);
    // Próximos episódios (até 6), já assinados: o player nativo emenda um no
    // outro sem voltar para a página.
    const fila = await _tvMontarFila(filePath, assinada);
    window.MediaServerTV.play(JSON.stringify({
      path: filePath,
      fila: fila,
      url: assinada('/api/stream', filePath, tokens.t),
      legenda: (subtitlePath && tokens.sub)
        ? assinada('/api/subtitle', subtitlePath, tokens.sub) : '',
      titulo: (movieName || '').replace(/\.[^.]+$/, '').replace(/[._]/g, ' '),
      contexto: arte.contexto,
      capa: (arte.poster && tokens.imgs && tokens.imgs[arte.poster])
        ? assinada('/api/stream', arte.poster, tokens.imgs[arte.poster]) : '',
      legTam: subtitleSizeIndex,
      legCor: subtitleColorIndex,
      posicao: Math.round(resumePosition || 0)
    }));
  }

  // Episódios que vêm depois de `filePath` na série aberta (ou na pasta da
  // temporada), com URL, legenda e capa assinadas. Filme não tem fila.
  async function _tvMontarFila(filePath, assinada) {
    _arteEPlaylistDoEpisodio(filePath);
    const pl = _castPlaylist;
    if (!pl || !pl.itens) return [];
    const seguintes = pl.itens.slice(pl.idx + 1, pl.idx + 7);
    const saida = [];
    for (const it of seguintes) {
      try {
        const arte = it.arte || {};
        const res = await fetch('/api/cast-token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: it.path, subtitle: it.sub || '',
                                 images: arte.poster ? [arte.poster] : [] })
        });
        if (!res.ok) break;
        const t = await res.json();
        saida.push({
          path: it.path,
          url: assinada('/api/stream', it.path, t.t),
          legenda: (it.sub && t.sub) ? assinada('/api/subtitle', it.sub, t.sub) : '',
          titulo: (it.title || '').replace(/\.[^.]+$/, '').replace(/[._]/g, ' '),
          contexto: (_serieAtual && _serieAtual.name) || '',
          capa: (arte.poster && t.imgs && t.imgs[arte.poster]) ? assinada('/api/stream', arte.poster, t.imgs[arte.poster]) : ''
        });
      } catch (e) { break; }
    }
    return saida;
  }

  // Chamado pelo app nativo ao sair do filme. Reusa o mesmo _saveProgress do
  // player da web, que ja sabe ignorar os primeiros segundos e limpar o
  // progresso quando o filme acabou.
  window.tvPlaybackEnded = function (posicao, duracao, legTam, legCor, saidas, atual) {
    // Episódios que o player nativo emendou antes de sair: cada um fecha com o
    // próprio progresso (acabou = assistido), usando a chave dele.
    (Array.isArray(saidas) ? saidas : []).forEach(function (s) {
      if (!s || !s.path) return;
      const chave = _currentPlayFolder;
      _currentPlayFolder = s.path;
      _saveProgress(Number(s.pos) || 0, Number(s.dur) || 0);
      _currentPlayFolder = chave;
    });
    // O que estava tocando ao sair pode ser outro episódio que não o aberto.
    if (typeof atual === 'string' && atual) _currentPlayFolder = atual;
    _saveProgress(Number(posicao) || 0, Number(duracao) || 0);
    // Tamanho e cor da legenda escolhidos no player nativo valem também na página.
    if (Number.isInteger(legTam) && legTam >= 0 && legTam < subtitleSizes.length) {
      subtitleSizeIndex = legTam;
      try { localStorage.setItem('media_server_sub_size', String(legTam)); } catch (e) {}
    }
    if (Number.isInteger(legCor) && legCor >= 0 && legCor < subtitleColors.length) {
      subtitleColorIndex = legCor;
      try { localStorage.setItem('media_server_sub_color', String(legCor)); } catch (e) {}
    }
  };

  // O que o sistema mostra como "tocando agora" (AirPlay, tela de bloqueio,
  // central de mídia): o título da página é a fonte clássica no WebKit — era
  // ele que fazia a TV anunciar "Midnight Media Server" — e o title do <video> cobre o
  // widget do macOS. A Media Session, quando existe, fala a mesma língua.
  function _publicarNomeNaTela(nome) {
    const video = document.getElementById('videoPlayer');
    document.title = nome || 'Midnight Media Server';
    if (video) video.title = nome || '';
    try {
      if (nome && window.MediaMetadata && 'mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: nome });
      }
    } catch (e) { /* sem Media Session: o título da página já resolve */ }
  }

  function _limparNomeNaTela() {
    const video = document.getElementById('videoPlayer');
    document.title = 'Midnight Media Server';
    if (video) video.title = '';
    try {
      if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    } catch (e) {}
  }

  function playMovie(filePath, movieName, subtitlePath, resumePosition, progressKey) {
    const overlay = document.getElementById('playerOverlay');
    const video = document.getElementById('videoPlayer');
    const loading = document.getElementById('playerLoading');
    const movieTitle = document.getElementById('playerMovieName');

    currentVideoPath = filePath;
    currentSubtitlePath = subtitlePath || null;
    // Chave do progresso: por padrão a pasta do arquivo (filme em pasta, como
    // sempre). Episódios passam o path do próprio arquivo — cada episódio tem
    // seu progresso, em vez de todos dividirem a linha da temporada.
    _currentPlayFolder = progressKey || filePath.substring(0, filePath.lastIndexOf('/'));
    _proximoCancelado = false;
    _esconderCartaoProximo();

    // Na TV quem toca e o player nativo. Fica depois de _currentPlayFolder de
    // proposito: e dele que _saveProgress depende quando o app devolve a
    // posicao no fim do filme.
    if (_tvNativoDisponivel()) {
      _tvTocarNativo(filePath, movieName, subtitlePath, resumePosition);
      return;
    }

    // Nome do vídeo na tela. No AirPlay quem anuncia é o sistema — pelo título
    // da PÁGINA (e pelo title do <video>) — e o título da página era
    // "Midnight Media Server": a TV mostrava o nome do app no lugar do filme.
    const nomeNaTela = movieName.replace(/\.[^.]+$/, '').replace(/[._]/g, ' ');
    movieTitle.textContent = nomeNaTela;
    _publicarNomeNaTela(nomeNaTela);
    document.getElementById('playerFileSize').textContent = '';

    // Proactively load Cast SDK (non-blocking)
    _loadCastSdk();
    // AirPlay nao precisa de SDK — e nativo do <video> em navegadores WebKit.
    _setupAirplay(video);

    // Limpa qualquer timer de buffer pendente
    clearBufferTimer();

    // Download de fundo só faz sentido pra nuvem: ele existe para forçar o
    // cache VFS do rclone. Num arquivo local isso leria o filme inteiro do
    // disco à toa, disputando com a própria reprodução.
    const _local = isLocalPath(filePath);
    if (!_local) _startBgDownload(filePath);

    // A arte guardada e da ficha aberta. Se o video vier de outro caminho
    // (lista de pasta, busca), ela nao corresponde — melhor nao mandar nada.
    if (_castArt.folder !== filePath.substring(0, filePath.lastIndexOf('/'))) {
      _castArt = { folder: null, poster: null, fanart: null, year: null, studio: null, plot: null };
    }
    // Episódio: capa da série (o arquivo não tem pôster) e fila com os
    // episódios vizinhos para a transmissão emendar sozinha.
    _arteEPlaylistDoEpisodio(filePath);

    // Show loading state
    video.style.display = 'none';
    loading.style.display = 'flex';
    document.getElementById('playerError').style.display = 'none';
    loading.querySelector('span').textContent = _local
      ? 'Abrindo o vídeo...'
      : 'Preparando vídeo da nuvem...';

    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    applySubtitleSize();

    // Set up video events
    video.onerror = function() {
      clearBufferTimer();
      const err = video.error;
      // MEDIA_ERR_ABORTED é normal durante seeks — ignora
      if (err && err.code === MediaError.MEDIA_ERR_ABORTED) return;

      // Tenta recarregar até 2x em erro de rede/suporte (rclone pode estar lento)
      if (!video._retryCount) video._retryCount = 0;
      if (video._retryCount < 2 && err && (err.code === MediaError.MEDIA_ERR_NETWORK || err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED)) {
        video._retryCount++;
        video.src = streamUrl(filePath);
        video.load();
        video.play().catch(function() {});
        return;
      }

      let msg = 'Erro ao carregar vídeo';
      if (err) {
        if (err.code === MediaError.MEDIA_ERR_NETWORK) msg = 'Falha de rede ao carregar vídeo';
        else if (err.code === MediaError.MEDIA_ERR_DECODE) msg = 'Erro de decodificação — formato não suportado';
        else if (err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) msg = 'Formato de vídeo não suportado pelo navegador';
      }
      showPlayerError(msg);
    };

    video.oncanplay = function() {
      // Browser pode decodificar — inicia play (só na primeira vez)
      if (!video._started) {
        video._started = true;
        clearBufferTimer();
        loading.style.display = 'none';
        video.style.display = 'block';
        video.play().catch(function() {});
        // Seek to saved position if resuming
        if (resumePosition && resumePosition > 0 && video.duration) {
          const target = Math.min(resumePosition, video.duration - 1);
          video.currentTime = target;
        }
      }
    };

    // Se já tem dados suficientes (cache local), pula o loading
    if (video.readyState >= 3) {
      video._started = true;
      clearBufferTimer();
      loading.style.display = 'none';
      video.style.display = 'block';
      video.play().catch(function() {});
      // Seek to saved position if resuming
      if (resumePosition && resumePosition > 0 && video.duration) {
        video.currentTime = Math.min(resumePosition, video.duration - 1);
      }
    }

    video.onloadeddata = function() {
      // Fallback: se oncanplay não disparou rápido, esconde loading
      if (!video._started) return;
      loading.style.display = 'none';
      video.style.display = 'block';
    };

    video.onwaiting = function() {
      if (video.style.display === 'block') {
        loading.style.display = 'flex';
        loading.querySelector('span').textContent = 'Bufferizando...';
      }
    };

    video.onplaying = function() {
      loading.style.display = 'none';
      showControls();
    };

    video.onseeking = function() {
      video._seeking = true;
    };

    video.onseeked = function() {
      video._seeking = false;
      loading.style.display = 'none';
      video.style.display = 'block';
    };

    // Background download tracker
    video.onpause = function() {
      if (video._started) _startBgDownload(filePath);
    };
    video.onplay = function() {
      // Don't stop bg download on play — let it continue in background
    };

    video.onprogress = function() {
      updateBufferStatus(video);
    };

    // Set up subtitle track (and enable automatically if present)
    _applySubtitleTrack(subtitlePath);

    // Filme aberto direto (card da busca ou vídeo solto) sem legenda:
    // resolve pelo detalhe do filme e aplica quando chegar — também garante
    // que o Cast envie o track de legenda
    if (!subtitlePath) {
      cachedFetch('/api/movie-detail?path=' + encodeURIComponent(_currentPlayFolder)).then(detail => {
        if (detail && detail.subtitle && !currentSubtitlePath) {
          currentSubtitlePath = _currentPlayFolder + '/' + detail.subtitle.Name;
          _applySubtitleTrack(currentSubtitlePath);
        }
      });
    }

    // Start loading video — play() antecipado acelera pipeline de mídia
    video.src = streamUrl(filePath);
    video.load();
    video.play().catch(function() {});

    // Fetch file size in background
    cachedFetch('/api/info?path=' + encodeURIComponent(filePath)).then(info => {
      if (info && info.Size) {
        document.getElementById('playerFileSize').textContent = formatSize(info.Size);
      }
    });

    // Inicia loading — stream começa assim que oncanplay disparar
    loading.querySelector('span').textContent = 'Carregando...';
    // Arquivo local não passa por cache nenhum — mostrar "Cache: 0%" seria mentira.
    setStreamStatus('cached', _local ? 'Local' : 'Cache: 0%');

    // Timeout: se readyState=0 após 25s, é erro de conexão
    setTimeout(function() {
      if (video.readyState === 0) {
        clearBufferTimer();
        showPlayerError(_local
          ? 'O servidor demorou a responder. A fonte deste filme ainda está conectada?'
          : 'O servidor demorou a responder. Verifique sua conexão com a nuvem.');
      }
    }, 25000);

    // Clique simples = play/pause
    video.onclick = function(e) {
      // Não dispara se for double-click
      if (e.detail === 1) {
        if (video.paused) {
          video.play().catch(function() {});
        } else {
          video.pause();
        }
      }
    };

    // Double-click no video = fullscreen no container
    video.ondblclick = function(e) {
      const container = document.querySelector('.player-container');
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(function() {});
      } else if (container.requestFullscreen) {
        container.requestFullscreen();
      } else if (container.webkitRequestFullscreen) {
        container.webkitRequestFullscreen();
      }
    };

    // Seek bar + time + play button + volume sync + periodic progress save
    video.ontimeupdate = function() {
      const seek = document.getElementById('seekBar');
      const time = document.getElementById('timeDisplay');
      if (seek && video.duration) seek.value = (video.currentTime / video.duration) * 100;
      if (time) time.textContent = formatTime(video.currentTime) + ' / ' + formatTime(video.duration);
      // Auto-save progress every ~30 seconds
      if (_progressSaveTimer) clearTimeout(_progressSaveTimer);
      _progressSaveTimer = setTimeout(_saveProgress, 30000);
      _atualizarCartaoProximo(video);
    };
    video.onplay = function() {
      document.getElementById('playBtn').innerHTML = '<svg class="icon-svg"><use href="#i-pause"></use></svg>';
      showControls();
    };
    video.onpause = function() {
      document.getElementById('playBtn').innerHTML = '<svg class="icon-svg"><use href="#i-play"></use></svg>';
    };
    video.onvolumechange = updateMuteBtn;
    // Fim do episódio tocando no próprio aparelho — é por aqui que o AirPlay
    // passa (a TV é comandada pelo <video>). No Chromecast quem emenda é o
    // ticker (IDLE/"finished"), e lá o <video> local fica pausado: o handler
    // nem chega a disparar.
    video.onended = function() {
      if (_isCasting()) return;
      // Fecha o episódio que acabou (pct > 95 vira "assistido"), antes de a
      // chave de progresso passar para o próximo.
      _saveProgress(video.duration, video.duration);
      // "Cancelar" no cartão do próximo episódio vale até o fim deste episódio.
      if (_proximoCancelado) { _esconderCartaoProximo(); return; }
      _avancarFilaNoPlayer();
    };

    document.getElementById('seekBar').oninput = function() {
      const dur = _castDuration();
      if (dur) { _castSeekTo((this.value / 100) * dur); return; }
      const v = document.getElementById('videoPlayer');
      if (v && v.duration) v.currentTime = (this.value / 100) * v.duration;
    };
    document.getElementById('volumeSlider').oninput = function() {
      if (_isCasting() && _castSession) {
        try {
          _castSession.setVolume(parseFloat(this.value)).catch(function(e) {
            console.warn('[Cast] setVolume falhou:', e);
          });
          return;
        } catch (e) {
          console.warn('[Cast] volume indisponivel:', e);
        }
      }
      const v = document.getElementById('videoPlayer');
      if (v) { v.volume = parseFloat(this.value); v.muted = false; }
      updateMuteBtn();
    };
    const vs = document.getElementById('volumeSlider');
    if (vs) vs.value = video.volume;
    updateMuteBtn();
  }

  function showPlayerError(msg) {
    const loading = document.getElementById('playerLoading');
    const video = document.getElementById('videoPlayer');
    const errorEl = document.getElementById('playerError');
    loading.style.display = 'none';
    video.style.display = 'none';
    video.src = '';
    errorEl.querySelector('.error-msg').textContent = msg;
    errorEl.style.display = 'flex';
  }

  function retryPlay() {
    if (currentVideoPath) {
      const movieTitle = document.getElementById('playerMovieName');
      const name = movieTitle.textContent;
      playMovie(currentVideoPath, name, currentSubtitlePath);
    }
  }

  function toggleSubtitles() {
    const track = document.getElementById('subtitleTrack');
    const btn = document.getElementById('subtitleToggleBtn');
    const m = _castMedia();
    if (m) {
      // Na TV a faixa e ligada/desligada pelo receiver, nao pelo <track> local.
      const ativa = (m.activeTrackIds || []).indexOf(1) !== -1;
      const novoTrack = ativa ? [] : [1];
      // Ao ligar, o estilo vai junto: sem isto o receiver as vezes volta ao
      // visual padrao do Google, ignorando o que foi mandado no load.
      m.editTracksInfo(
        new chrome.cast.media.EditTracksInfoRequest(novoTrack, _estiloLegendaCast()),
        function() {
          btn.classList.toggle('active', !ativa);
          const cc = document.getElementById('castingCcBtn');
          if (cc) cc.classList.toggle('active', !ativa);
        },
        function(e) { console.warn('[Cast] editTracksInfo falhou:', e); });
      return;
    }
    if (track && track.track) {
      if (track.track.mode === 'showing') {
        track.track.mode = 'disabled';
        btn.classList.remove('active');
      } else {
        track.track.mode = 'showing';
        btn.classList.add('active');
      }
    }
  }

  function updateSubtitleButton(subtitlePath) {
    const btn = document.getElementById('subtitleToggleBtn');
    if (!subtitlePath) {
      subtitlesEnabled = false;
      if (btn) btn.classList.remove('active');
    } else {
      subtitlesEnabled = true;
      if (btn) btn.classList.add('active');
    }
  }

  function closePlayer() {
    // Se estiver em fullscreen, sai primeiro para o modal ficar visível
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(function() {});
      // Mostra modal depois de sair (curto delay pro browser processar)
      setTimeout(function() {
        document.getElementById('confirmModal').classList.add('active');
      }, 200);
    } else {
      document.getElementById('confirmModal').classList.add('active');
    }
    document.getElementById('confirmYesBtn').onclick = function() {
      document.getElementById('confirmModal').classList.remove('active');
      _doClosePlayer();
    };
  }

  function closeConfirmModal() {
    document.getElementById('confirmModal').classList.remove('active');
  }

  function _doClosePlayer() {
    fecharPlayerMore();
    _showCastingPanel(false);
    const video = document.getElementById('videoPlayer');
    // Não fecha durante seek
    if (video && video._seeking) {
      console.log('[closePlayer] ignorado — seeking em andamento');
      return;
    }
    // Save progress before closing
    if (_progressSaveTimer) clearTimeout(_progressSaveTimer);
    _saveProgress();
    clearBufferTimer();
    clearTimeout(_controlsTimer);
    const controls = document.getElementById('playerControls');
    if (controls) controls.classList.remove('force-show');
    const hdr = document.querySelector('.player-container .player-header');
    if (hdr) hdr.classList.remove('force-show');
    const pcontainer = document.querySelector('.player-container');
    if (pcontainer) pcontainer.classList.remove('controls-visible');
    const overlay = document.getElementById('playerOverlay');
    const loading = document.getElementById('playerLoading');
    const errorEl = document.getElementById('playerError');
    video.pause();
    video.src = '';
    video.onerror = null;
    video.oncanplay = null;
    video.onwaiting = null;
    video.onplaying = null;
    video.onseeking = null;
    video.onseeked = null;
    video.onprogress = null;
    video.ontimeupdate = null;
    video.onclick = null;
    video.ondblclick = null;
    video.onplay = null;
    video.onpause = null;
    video.onvolumechange = null;
    video.onloadeddata = null;
    video.onended = null;
    _esconderCartaoProximo();
    // Stop background download
    _stopBgDownload();
    loading.style.display = 'none';
    errorEl.style.display = 'none';
    overlay.classList.remove('active');
    document.body.style.overflow = '';
    _currentPlayFolder = null;
    _progressSaveTimer = null;
    // O filme saiu do ar: devolve o título da página ao nome do app.
    _limparNomeNaTela();
  }

  let subtitlesEnabled = true;
  let subtitleSizeIndex = 2;
  // Tamanho proporcional à altura do player (fração da altura visível).
  // Ex.: 0.05 = 5% da altura → fullscreen grande, janela pequena.
  // `castScale` leva a MESMA escolha para a TV: vira o fontScale do
  // TextTrackStyle do receiver (1.0 = padrão do Google). O 0.8 de antes —
  // que já saía grande numa TV vista do sofá — virou o "Grande".
  const subtitleSizes = [
    { ratio: 0.035, label: 'Peq', nome: 'Pequena',      castScale: 0.5 },
    { ratio: 0.045, label: 'Méd', nome: 'Média',        castScale: 0.65 },
    { ratio: 0.06,  label: 'Gde', nome: 'Grande',       castScale: 0.8 },
    { ratio: 0.08,  label: 'Ext', nome: 'Extra grande', castScale: 1.05 },
  ];

  // Calcula o px da legenda com base na altura real do player
  function applySubtitleSize() {
    const container = document.querySelector('.player-container');
    const overlay = document.querySelector('.player-overlay');
    if (!container || !overlay) return;
    const h = container.clientHeight;
    if (h <= 0) return;
    const size = subtitleSizes[subtitleSizeIndex];
    const px = Math.max(14, Math.round(h * size.ratio));
    overlay.style.setProperty('--sub-size', px + 'px');
  }

  let subtitleColorIndex = 0;
  const subtitleColors = [
    { color: '#ffd700', label: 'Amar', nome: 'Amarelo', castColor: '#FFD700FF' },
    { color: '#ffffff', label: 'Bran', nome: 'Branco',  castColor: '#FFFFFFFF' },
  ];

  // Escolha lembrada entre sessões: quem regula a legenda uma vez não quer
  // regular de novo a cada filme. O valor entra antes da primeira pintura dos
  // menus (os _renderSubtitleMenu logo abaixo), então a UI já nasce certa.
  try {
    const ss = parseInt(localStorage.getItem('media_server_sub_size'), 10);
    if (ss >= 0 && ss < subtitleSizes.length) subtitleSizeIndex = ss;
    const sc = parseInt(localStorage.getItem('media_server_sub_color'), 10);
    if (sc >= 0 && sc < subtitleColors.length) subtitleColorIndex = sc;
  } catch (e) { /* storage indisponível: segue no padrão */ }

  // Espelha a escolha atual nos botões da barra e no rótulo do painel de
  // transmissão — tudo num lugar só, para nenhum ficar dessincronizado.
  function _syncSubtitleControls() {
    const size = subtitleSizes[subtitleSizeIndex];
    const cor = subtitleColors[subtitleColorIndex];
    const sizeLabel = document.getElementById('subtitleSizeLabel');
    if (sizeLabel) sizeLabel.textContent = size.label;
    const colorLabel = document.getElementById('subtitleColorLabel');
    if (colorLabel) colorLabel.textContent = cor.label;
    const colorIcon = document.getElementById('subtitleColorIcon');
    if (colorIcon) colorIcon.style.background = cor.color;
    const overlay = document.querySelector('.player-overlay');
    if (overlay) overlay.style.setProperty('--sub-color', cor.color);
    const castLabel = document.getElementById('castingSizeLabel');
    if (castLabel) castLabel.textContent = size.label;
  }

  // Menuzinho ancorado no proprio botao (ver .ctrl-sub-menu no CSS), em vez
  // de ciclar o valor a cada clique — com so 2-4 opcoes, escolher direto da
  // lista e mais rapido que adivinhar quantos cliques faltam.
  function _renderSubtitleMenu(menuId, opcoes, indiceAtual, aoEscolher) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    menu.innerHTML = opcoes.map(function (op, i) {
      const swatch = op.color
        ? '<span class="subtitle-swatch" style="background:' + op.color + '"></span> '
        : '';
      return '<button type="button" class="ctrl-sub-menu-item'
        + (i === indiceAtual ? ' active' : '') + '" onclick="' + aoEscolher + '(' + i + ')">'
        + swatch + op.nome + '</button>';
    }).join('');
  }

  function fecharSubtitleMenus(exceto) {
    ['subtitleSizeMenu', 'subtitleColorMenu'].forEach(function (id) {
      if (id === exceto) return;
      const m = document.getElementById(id);
      if (m) m.classList.remove('aberto');
    });
  }

  function toggleSubtitleSizeMenu(ev) {
    if (ev) ev.stopPropagation();
    fecharSubtitleMenus('subtitleSizeMenu');
    document.getElementById('subtitleSizeMenu').classList.toggle('aberto');
    showControls();
  }

  function selectSubtitleSize(i) {
    subtitleSizeIndex = i;
    try { localStorage.setItem('media_server_sub_size', String(i)); } catch (e) {}
    _syncSubtitleControls();
    applySubtitleSize();
    _renderSubtitleMenu('subtitleSizeMenu', subtitleSizes, subtitleSizeIndex, 'selectSubtitleSize');
    fecharSubtitleMenus();
    // Na transmissão quem desenha a legenda é a TV: a escolha vai junto, ao
    // vivo, via TextTrackStyle (ver _aplicarEstiloLegendaCast).
    if (_isCasting()) {
      _aplicarEstiloLegendaCast();
      showToast('🔠 Legenda na TV: ' + subtitleSizes[i].nome, 'info');
    }
  }

  // Botão "Aa" do painel de transmissão: cicla Peq > Méd > Gde > Ext. O toast
  // é a única confirmação — a TV está do outro lado da sala.
  function cycleSubtitleSize() {
    selectSubtitleSize((subtitleSizeIndex + 1) % subtitleSizes.length);
  }

  function toggleSubtitleColorMenu(ev) {
    if (ev) ev.stopPropagation();
    fecharSubtitleMenus('subtitleColorMenu');
    document.getElementById('subtitleColorMenu').classList.toggle('aberto');
    showControls();
  }

  function selectSubtitleColor(i) {
    subtitleColorIndex = i;
    try { localStorage.setItem('media_server_sub_color', String(i)); } catch (e) {}
    _syncSubtitleControls();
    _renderSubtitleMenu('subtitleColorMenu', subtitleColors, subtitleColorIndex, 'selectSubtitleColor');
    fecharSubtitleMenus();
    // Mesma viagem do tamanho: a cor escolhida troca na TV na hora.
    if (_isCasting()) {
      _aplicarEstiloLegendaCast();
      showToast('🎨 Legenda na TV: ' + subtitleColors[i].nome, 'info');
    }
  }

  _renderSubtitleMenu('subtitleSizeMenu', subtitleSizes, subtitleSizeIndex, 'selectSubtitleSize');
  _renderSubtitleMenu('subtitleColorMenu', subtitleColors, subtitleColorIndex, 'selectSubtitleColor');
  // Nasce com o que ficou salvo (rótulos, amostra de cor e a legenda local).
  _syncSubtitleControls();

  function setStreamStatus(type, text) {
    const el = document.getElementById('streamStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'stream-status';
    if (type) el.classList.add(type);
  }

  function updateBufferStatus(video) {
    const el = document.getElementById('streamStatus');
    if (!el) return;
    try {
      if (video.buffered && video.buffered.length > 0 && video.duration > 0) {
        const end = video.buffered.end(video.buffered.length - 1);
        const pct = Math.round((end / video.duration) * 100);
        // Update seek buffer bar
        const buf = document.getElementById('seekBuffer');
        if (buf) buf.style.width = Math.min(pct, 100) + '%';
        // Mark as offline-cached once >= 80% buffer
        if (currentMovieFolder && pct >= 85 && !_cachedSet.has(currentMovieFolder)) {
          _verifyServerCache(currentMovieFolder, currentVideoPath);
        }
        // Update cache info in controls
        if (pct >= 100) {
          el.innerHTML = '<svg class="icon-svg"><use href="#i-save"></use></svg> Cache total';
          el.className = 'stream-status cached';
        } else {
          el.textContent = 'Cache: ' + pct + '%';
          el.className = 'stream-status';
        }
      }
    } catch(e) {}
  }

