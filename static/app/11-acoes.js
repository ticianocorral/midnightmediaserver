  // ==================== ACOES (eventos no lugar de onclick="..." inline) ====================
  // Os botoes e cards levam data-act="nome" (e data-args em JSON) em vez de JS dentro do
  // atributo. Um unico listener em fase de CAPTURA no document executa a acao, na mesma
  // ordem que o onclick inline tinha (do elemento clicado para cima, e event.stopPropagation()
  // interrompe a cadeia). Captura, e nao bolha, para que um listener global de clique (o que
  // fecha menus ao clicar fora) nao rode antes de uma acao que existe justamente para impedir
  // isso, como abrir um menu.
  //
  // Seguranca: so roda o que esta na lista ACOES. Nada de window[nome] nem eval: um atributo
  // injetado (data-act="eval") nao executa codigo. test_app_partes.py garante que toda
  // acao usada no HTML esta aqui.

  // Pequenas acoes que antes eram trechos de JS dentro do atributo.
  function rolarPara(id) {
    document.getElementById(id).scrollIntoView({behavior: 'smooth'});
    return false;                       // cancela o href="#" da ancora
  }
  function imgRemover() { this.remove(); }
  function imgTrocarPorIrmao() {
    this.style.display = 'none';
    this.nextElementSibling.style.display = 'flex';
  }
  function imgSemPoster() {
    this.parentElement.classList.add('sem-poster');
    this.remove();
  }
  function imgSemCartaz() {
    this.outerHTML = "<div class='placeholder'><svg class='icon-svg'><use href='#i-film'></use></svg></div>";
  }
  function imgComoPosterDoCache() {
    this.outerHTML = "<div class=cache-item-poster><svg class='icon-svg'><use href='#i-film'></use></svg></div>";
  }
  function fichaAbrirColecao(id) { closeMovieInfo(); abrirColecao(id); }
  function clicarEm(id) { document.getElementById(id).click(); }
  function buscaTecla(ev) {
    if (ev.key === 'Enter') search();
    else if (ev.key === 'Escape') clearSearch();
  }
  function generoNovoTecla(ev) { if (ev.key === 'Enter') criarGeneroDoModal(); }
  function _orgBuscarTecla(id, el, ev) { if (ev.key === 'Enter') _orgBuscar(id, el.value); }
  function _orgBuscarDoCampo(id) { _orgBuscar(id, document.getElementById('orgQ-' + id).value); }
  function _orgFecharBusca(id) {
    _org.busca[id] = null;
    document.getElementById('orgBusca-' + id).innerHTML = '';
  }
  function _capaBuscarTecla(ev) { if (ev.key === 'Enter') _capaBuscar(); }

  const ACOES = Object.freeze({
    _capaBuscar, _capaBuscarTecla, _capaClicada, _capaEscolherFilme, _cmDeleteCache,
    _cmDownload, _colecaoEscolherCapa, _colecaoFiltrar, _colecaoIrParaCapa,
    _colecaoRenderPasso1, _colecaoSalvar, _colecaoToggle, _desmarcarEpisodio, _generoCriarEDar,
    _generoToggleChip, _loadRcloneStatus, _orgAbrirCapas, _orgAplicar, _orgBuscar,
    _orgBuscarDoCampo, _orgBuscarTecla, _orgDesfazer, _orgEscolher, _orgFecharBusca,
    _orgLimpar, _orgProcurar, _orgSemCapa, _orgSugerir, _scrapeAba, _scrapeAbrirBusca,
    _scrapeAplicar, _scrapeConfirmar, _scrapeBuscar, _scrapePendentes, _scrapeSalvarChave, _wizardConectar,
    _wizardCriarRemote, _wizardEscolherRemote, _wizardEscolherTipo, _wizardFiltrarTipos,
    _wizardPassoExistente, _wizardPassoNovoTipo, _wizardPassoOrigem, abrirBusca, abrirColecao,
    addSource, addSourceFromForm, backupToCloud, buscaTecla, cancelarProximo, clearCache,
    clearSearch, clicarEm, closeBackupModal, closeCacheManager, closeChangelogModal,
    closeColecaoModal, closeConfirmModal, closeGeneroFilmeModal, closeGeneroNovoModal,
    closeNuvemWizard, closePhoneModal, closePlayer, closeRcloneModal, closeScrapeModal,
    closeSettingsModal, closeSidebar, closeSourcesModal, copyPhone, criarGeneroDoModal,
    cycleSpeed, cycleSubtitleSize, doLogout, downloadBackup, excluirColecao, excluirGenero,
    fichaAbrirColecao, filterCacheList, fromSettings, generoNovoTecla, imgComoPosterDoCache,
    imgRemover, imgSemCartaz, imgSemPoster, imgTrocarPorIrmao, limparProgressoEpisodio, loadAZ,
    loadCollections, loadPath, loadSeries, nuvemDesconectar, onSearchInput, openBackupModal,
    openCacheManager, openCapaModal, openChangelogModal, openColecaoModal,
    openGeneroFilmeModal, openGeneroNovoModal, toggleGeneros, openGeneroRenomear, openNuvemWizard,
    openPhoneModal, openProfilesManager, openRcloneModal, openScrapeModal, openSettingsModal,
    openSourcesModal, openSourcesOrSettings, playFromInfo, playMovie, proximoEpisodio,
    rcloneRestartServe, rcloneStartWebgui, rcloneStopWebgui, refreshCache, removeSource,
    restoreFromCloud, restoreFromFile, retryPlay, rolarPara, scanSource, selectSubtitleColor,
    selectSubtitleSize, showMovieInfo, skip, switchProfile, toggleAirplay, toggleAssistido,
    toggleCast, toggleFullscreen, toggleInfantil, toggleMute, togglePlay, togglePlayerMore,
    toggleSidebar, toggleSubtitleColorMenu, toggleSubtitleSizeMenu, toggleSubtitles,
    voltarDoFilme, addSourceAceitar, dispensarChecklist, dispensarDica, checklistCelular, srcBrowse, srcBrowseUse, onboardingEscolherPasta
  });

  (function () {
    function valor(a, el, ev) {
      if (a && typeof a === 'object' && a.$) {          // marcadores; texto de usuario nunca e objeto
        if (a.$ === 'this') return el;
        if (a.$ === 'event') return ev;
        if (a.$ === 'value') return el.value;
        if (a.$ === 'fn') return ACOES[a.n];
      }
      return a;
    }

    function rodar(ev, attr, soAlvo) {
      let el = ev.target instanceof Element ? ev.target.closest('[' + attr + ']') : null;
      if (soAlvo && el !== ev.target) return;           // error nao borbulha: so o proprio elemento
      while (el) {
        const fn = Object.prototype.hasOwnProperty.call(ACOES, el.getAttribute(attr))
          ? ACOES[el.getAttribute(attr)] : null;
        if (typeof fn === 'function') {
          let args = [];
          const bruto = el.getAttribute('data-args');
          if (bruto) {
            try { args = JSON.parse(bruto).map(a => valor(a, el, ev)); } catch (e) { args = null; }
          }
          if (args) {
            if (el.hasAttribute('data-stop')) ev.stopPropagation();
            if (fn.apply(el, args) === false) ev.preventDefault();
            if (ev.cancelBubble) break;                  // stopPropagation: nao sobe para quem esta acima
          }
        }
        if (soAlvo) break;
        el = el.parentElement ? el.parentElement.closest('[' + attr + ']') : null;
      }
    }

    document.addEventListener('click', e => rodar(e, 'data-act'), true);
    document.addEventListener('input', e => rodar(e, 'data-act-input'), true);
    document.addEventListener('change', e => rodar(e, 'data-act-change'), true);
    document.addEventListener('keydown', e => rodar(e, 'data-act-keydown'), true);
    document.addEventListener('error', e => rodar(e, 'data-act-error', true), true);
  })();
