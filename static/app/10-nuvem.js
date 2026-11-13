  // ==================== NUVEM: WIZARD DE CONEXÃO ====================
  // Qualquer remote rclone vale: usar um que já exista no rclone.conf ou
  // criar um novo — o formulário é gerado a partir de "rclone config
  // providers", que o próprio rclone descreve (tipo, campos, segredos).

  function _renderAcessoNuvem(a) {
    if (!a) return '';
    var html = '<div class="rclone-row"><span class="rclone-label">Acesso à nuvem</span>'
      + '<span class="rclone-badge ' + (a.nivel === 'ok' ? 'ok' : 'bad') + '">'
      + '<svg class="icon-svg"><use href="#i-' + (a.nivel === 'ok' ? 'check' : 'alert') + '"></use></svg> '
      + escHtml(a.nivel === 'ok' ? 'ok' : '?') + '</span></div>';
    if (a.resumo) {
      html += '<div class="rclone-help">' + escHtml(a.resumo) + '</div>';
    }
    return html;
  }

  function _renderNuvemPanel(st, s) {
    var html = '<div class="rclone-subhead"><svg class="icon-svg"><use href="#i-cloud"></use></svg> Nuvem</div>';
    if (st && st.configurado) {
      html += '<div class="rclone-row"><span class="rclone-label">Conexão</span>'
        + _rcloneBadge(true, escHtml(st.remote) + (st.tipo ? ' <span class="rclone-mini">' + escHtml(st.tipo) + '</span>' : ''), '') + '</div>';
      html += '<div class="rclone-row"><span class="rclone-label">Pasta do acervo</span>'
        + _rcloneBadge(true, st.pasta ? escHtml(st.pasta) : 'raiz do remote', '') + '</div>';
      html += '<div class="rclone-row"><span class="rclone-label">Backup</span>'
        + _rcloneBadge(true, 'mesma nuvem, pasta "' + 'Media Server Backups"', '') + '</div>';
      if (s && s.acesso) html += _renderAcessoNuvem(s.acesso);
      html += '<div class="rclone-actions">'
        + '<button class="rclone-action-btn primary" data-act="openNuvemWizard"><svg class="icon-svg"><use href="#i-refresh"></use></svg> Trocar conexão</button>'
        + '<button class="rclone-action-btn" data-act="nuvemDesconectar"><svg class="icon-svg"><use href="#i-unplug"></use></svg> Desconectar</button>'
        + '</div>';
      html += '<div class="rclone-help">Os arquivos da nuvem não são tocados por nenhuma das duas ações.</div>';
      return html;
    }
    html += '<div class="rclone-help"><svg class="icon-svg"><use href="#i-bulb"></use></svg> '
      + 'Conecte Backblaze B2, Google Drive, S3, '
      + 'Dropbox, SFTP e outras. Use uma nuvem já configurada ou conecte uma '
      + 'nova pelo passo a passo.</div>';
    html += '<div class="rclone-actions">'
      + '<button class="rclone-action-btn primary" data-act="openNuvemWizard"><svg class="icon-svg"><use href="#i-cloud"></use></svg> Conectar nuvem</button>'
      + '</div>';
    return html;
  }

  // ── Wizard ──
  let _wizard = null;   // {passo, remotes[], providers[], filtro, tipo, nome, campos, pasta}

  function openNuvemWizard() {
    _wizard = { passo: 'origem', pasta: '' };
    document.getElementById('nuvemWizardTitulo').innerHTML =
      '<svg class="icon-svg"><use href="#i-cloud"></use></svg> Conectar nuvem';
    document.getElementById('nuvemWizardCorpo').innerHTML =
      '<div class="loading" style="min-height:100px"><div class="spinner"></div><span>Carregando...</span></div>';
    document.getElementById('nuvemWizardModal').classList.add('active');
    document.body.style.overflow = 'hidden';
    _wizardPassoOrigem();
  }

  function closeNuvemWizard() {
    document.getElementById('nuvemWizardModal').classList.remove('active');
    document.body.style.overflow = '';
    _wizard = null;
    _loadRcloneStatus();
  }
  document.getElementById('nuvemWizardModal').addEventListener('click', function(e) {
    if (e.target === this) closeNuvemWizard();
  });

  function _wizardCorpo(html) {
    document.getElementById('nuvemWizardCorpo').innerHTML = html
      + '<div id="nuvemWizardMsg"></div>';
  }

  function _wizardErro(texto) {
    document.getElementById('nuvemWizardMsg').innerHTML =
      '<div class="user-msg err">' + escHtml(texto) + '</div>';
  }

  function _wizardPassoOrigem() {
    _wizard.passo = 'origem';
    _wizardCorpo(
      '<div class="wizard-origem">'
      + '<button class="wizard-opcao" data-act="_wizardPassoExistente">'
      + '<span class="wizard-opcao-icone"><svg class="icon-svg"><use href="#i-layers"></use></svg></span>'
      + '<span><b>Usar uma conexão que já existe</b><br>'
      + '<small>Escolha entre as nuvens já configuradas neste computador</small></span></button>'
      + '<button class="wizard-opcao" data-act="_wizardPassoNovoTipo">'
      + '<span class="wizard-opcao-icone"><svg class="icon-svg"><use href="#i-plus"></use></svg></span>'
      + '<span><b>Conectar uma nuvem nova</b><br>'
      + '<small>Passo a passo para Drive, Backblaze, S3 e outras</small></span></button>'
      + '</div>'
      + '<div class="colecao-passos"><span></span>'
      + '<button class="rclone-action-btn" data-act="closeNuvemWizard">Cancelar</button></div>');
  }

  function _wizardPassoExistente() {
    _wizard.passo = 'existente';
    _wizardCorpo('<div class="loading" style="min-height:90px"><div class="spinner"></div><span>Procurando conexões...</span></div>');
    fetch('/api/rclone/remotes').then(r => r.json()).then(remotes => {
      if (!Array.isArray(remotes)) {
        _wizardErro((remotes && remotes.error) || 'Não consegui listar as conexões.');
        return;
      }
      _wizard.remotes = remotes;
      if (!remotes.length) {
        _wizardCorpo('<p class="colecao-dica">Você ainda não tem nenhuma nuvem conectada. '
          + 'Crie um pelo assistente:</p>'
          + '<div class="colecao-passos">'
          + '<button class="rclone-action-btn" data-act="_wizardPassoOrigem">← Voltar</button>'
          + '<button class="rclone-action-btn primary" data-act="_wizardPassoNovoTipo">Conectar uma nuvem</button>'
          + '</div>');
        return;
      }
      let opcoes = remotes.map(r =>
        '<button class="wizard-remoto" data-nome="' + escHtml(r.nome) + '" '
        + attrAcao('_wizardEscolherRemote', [{$: 'this'}, r.nome]) + '>'
        + '<b>' + escHtml(r.nome) + '</b>'
        + '<span class="wizard-remoto-tipo">' + escHtml(r.tipo || '?') + '</span></button>').join('');
      _wizardCorpo('<div class="colecao-secao-titulo">Escolha a nuvem</div>'
        + '<div class="wizard-lista">' + opcoes + '</div>'
        + '<label class="colecao-campo"><span>Pasta dos filmes dentro da nuvem <em>(opcional)</em></span>'
        + '<input id="wizardPasta" type="text" placeholder="deixe vazio para usar a pasta principal"></label>'
        + '<div class="colecao-passos">'
        + '<button class="rclone-action-btn" data-act="_wizardPassoOrigem">← Voltar</button>'
        + '<button class="rclone-action-btn primary" data-act="_wizardConectar">Conectar</button>'
        + '</div>');
    }).catch(() => _wizardErro('Falha de conexão com o servidor.'));
  }

  function _wizardEscolherRemote(el, nome) {
    document.querySelectorAll('.wizard-remoto').forEach(b => b.classList.remove('escolhido'));
    el.classList.add('escolhido');
    _wizard.remote = nome;
  }

  function _wizardPastaLida() {
    const el = document.getElementById('wizardPasta');
    return el ? el.value.trim().replace(/^\/+|\/+$/g, '') : '';
  }

  function _wizardConectar() {
    if (!_wizard) return;
    if (_wizard.passo === 'existente' && !_wizard.remote) {
      _wizardErro('Escolha uma nuvem da lista.');
      return;
    }
    const pasta = _wizardPastaLida();
    const btns = document.querySelectorAll('#nuvemWizardCorpo .rclone-action-btn.primary');
    if (btns.length) btns[btns.length - 1].disabled = true;
    fetch('/api/nuvem/conectar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remote: _wizard.remote, pasta: pasta }),
    }).then(r => r.json()).then(data => {
      if (data.status === 'ok') {
        showToast('☁️ Nuvem conectada: ' + data.remote, 'success');
        closeNuvemWizard();
      } else {
        _wizardErro(data.error || 'Não foi possível conectar.');
        if (btns.length) btns[btns.length - 1].disabled = false;
      }
    }).catch(() => {
      _wizardErro('Falha de conexão com o servidor.');
      if (btns.length) btns[btns.length - 1].disabled = false;
    });
  }

  function nuvemDesconectar() {
    _confirmarGenerico('Desconectar a nuvem?',
      'O app deixa de mostrar o acervo da nuvem. Seus arquivos na nuvem não são tocados.',
      function() {
        fetch('/api/nuvem/desconectar', { method: 'POST' })
          .then(r => r.json())
          .then(data => {
            showToast('Nuvem desconectada', 'info');
            _loadRcloneStatus();
          }).catch(() => showToast('Erro ao desconectar', 'error'));
      });
  }

  // ── Wizard: criar remote novo ──
  function _wizardPassoNovoTipo() {
    _wizard.passo = 'novo';
    _wizardCorpo('<div class="loading" style="min-height:90px"><div class="spinner"></div><span>Carregando nuvens suportadas...</span></div>');
    fetch('/api/rclone/providers').then(r => r.json()).then(providers => {
      if (!Array.isArray(providers)) {
        _wizardErro((providers && providers.error) || 'Falha ao carregar os tipos.');
        return;
      }
      _wizard.providers = providers;
      _wizardRenderTipos();
    }).catch(() => _wizardErro('Falha de conexão com o servidor.'));
  }

  function _wizardRenderTipos() {
    const busca = (_wizard.filtro || '').toLowerCase();
    const lista = _wizard.providers.filter(p =>
      !busca || p.nome.toLowerCase().includes(busca) || p.tipo.toLowerCase().includes(busca));
    const corpos = lista.slice(0, 60).map(p =>
      '<button class="wizard-remoto"' + attrAcao('_wizardEscolherTipo', [p.tipo]) + '>'
      + '<b>' + escHtml(p.nome) + '</b>'
      + '<span class="wizard-remoto-tipo">' + escHtml(p.tipo) + '</span></button>').join('');
    _wizardCorpo('<div class="colecao-secao-titulo">Qual é a nuvem?</div>'
      + '<input id="wizardFiltro" class="colecao-busca" type="text" placeholder="Filtrar (ex.: b2, drive, s3, sftp)..." '
      + 'value="' + escHtml(_wizard.filtro || '') + '" data-act-input="_wizardFiltrarTipos" data-args="[{&quot;$&quot;:&quot;value&quot;}]">'
      + '<div class="wizard-lista" id="wizardListaTipos">' + corpos + '</div>'
      + (lista.length > 60 ? '<div class="colecao-dica">Mostrando 60 de ' + lista.length + ' — filtre para achar.</div>' : '')
      + '<div class="colecao-passos">'
      + '<button class="rclone-action-btn" data-act="_wizardPassoOrigem">← Voltar</button><span></span>'
      + '</div>');
  }

  function _wizardFiltrarTipos(valor) {
    _wizard.filtro = valor;
    _wizardRenderTipos();
    const campo = document.getElementById('wizardFiltro');
    if (campo) { campo.focus(); campo.setSelectionRange(valor.length, valor.length); }
  }

  function _wizardEscolherTipo(tipo) {
    const p = _wizard.providers.find(x => x.tipo === tipo);
    if (!p) return;
    _wizard.tipo = tipo;
    _wizard.nomeTipo = p.nome;
    // Campos do backend, na ordem do rclone — senha vira password, exemplos
    // viram sugestões de preenchimento.
    const campos = p.opcoes.map(o => {
      const id = 'wz_' + o.nome;
      const lista = o.exemplos && o.exemplos.length
        ? '<datalist id="dl_' + id + '">' + o.exemplos.map(e => '<option value="' + escHtml(e) + '">').join('') + '</datalist>' : '';
      const obrig = o.obrigatorio ? ' <em>*</em>' : '';
      return lista + '<label class="colecao-campo"><span>' + escHtml(o.nome) + obrig + '</span>'
        + '<input id="' + id + '" type="' + (o.senha ? 'password' : 'text') + '"'
        + (o.exemplos && o.exemplos.length ? ' list="dl_' + id + '"' : '')
        + (o.padrao ? ' placeholder="' + escHtml(o.padrao) + '"' : '')
        + ' autocomplete="off"></label>'
        + (o.ajuda ? '<div class="wizard-ajuda">' + escHtml(o.ajuda) + '</div>' : '');
    }).join('');
    _wizardCorpo('<div class="colecao-secao-titulo">Nova nuvem: ' + escHtml(p.nome) + '</div>'
      + '<label class="colecao-campo"><span>Nome para esta nuvem</span>'
      + '<input id="wizardNome" type="text" value="' + escHtml(tipo) + '" maxlength="30"></label>'
      + campos
      + '<div class="colecao-passos">'
      + '<button class="rclone-action-btn" data-act="_wizardPassoNovoTipo">← Voltar</button>'
      + '<button class="rclone-action-btn primary" id="wizardCriarBtn" data-act="_wizardCriarRemote">Criar e testar</button>'
      + '</div>');
  }

  function _wizardCriarRemote() {
    const nome = (document.getElementById('wizardNome').value || '').trim();
    if (!nome) { _wizardErro('Dê um nome a esta nuvem.'); return; }
    const p = _wizard.providers.find(x => x.tipo === _wizard.tipo);
    const parametros = {};
    (p ? p.opcoes : []).forEach(o => {
      const el = document.getElementById('wz_' + o.nome);
      if (el && el.value.trim()) parametros[o.nome] = el.value.trim();
    });
    const btn = document.getElementById('wizardCriarBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Criando...'; }
    fetch('/api/rclone/wizard', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: nome, tipo: _wizard.tipo, parametros: parametros }),
    }).then(r => r.json()).then(data => {
      if (data.status === 'ok') {
        showToast('✅ Nuvem "' + data.nome + '" conectada e testada.', 'success');
        _wizard.remote = data.nome;
        _wizard.passo = 'existente';
        _wizardCorpo('<p class="colecao-dica">Nuvem <b>' + escHtml(data.nome) + '</b> criado e respondendo. '
          + 'Agora diga onde o acervo mora dentro dele (ou use a raiz):</p>'
          + '<label class="colecao-campo"><span>Pasta do acervo <em>(opcional)</em></span>'
          + '<input id="wizardPasta" type="text" placeholder="pasta principal"></label>'
          + '<div class="colecao-passos">'
          + '<button class="rclone-action-btn" data-act="_wizardPassoOrigem">← Voltar</button>'
          + '<button class="rclone-action-btn primary" data-act="_wizardConectar">Conectar</button>'
          + '</div>');
      } else {
        _wizardErro(data.error || 'Falha ao conectar a nuvem.');
        if (btn) { btn.disabled = false; btn.textContent = 'Criar e testar'; }
      }
    }).catch(() => {
      _wizardErro('Falha de conexão com o servidor.');
      if (btn) { btn.disabled = false; btn.textContent = 'Criar e testar'; }
    });
  }

  function _renderRcloneStatus(box, s, b2) {
    let html = '';
    html += '<div class="rclone-row"><span class="rclone-label">rclone instalado</span>'
      + (s.installed ? _rcloneBadge(true, s.version || 'ok', '') : _rcloneBadge(false, '', 'não encontrado')) + '</div>';

    if (s.installed) {
      // Conexão da nuvem primeiro: sem ela, o resto do painel é secundário.
      html += _renderNuvemPanel(b2, s);
      html += '<div class="rclone-subhead"><svg class="icon-svg"><use href="#i-gear"></use></svg> rclone</div>';
      html += '<div class="rclone-row"><span class="rclone-label">Remote no rclone.conf</span>'
        + _rcloneBadge(s.remote_configured, escHtml(s.remote || 'configurado'), 'não configurado') + '</div>';
      if (s.remote_configured) {
        html += '<div class="rclone-row"><span class="rclone-label">Conexão com a nuvem</span>'
          + (s.remote_ok ? _rcloneBadge(true, 'ok', '') : _rcloneBadge(false, '', s.remote_error || 'falhou')) + '</div>';
      }
      html += '<div class="rclone-row"><span class="rclone-label">Streaming (serve)</span>'
        + _rcloneBadge(s.serve_running, 'ativo :18082', 'parado') + '</div>';
      html += '<div class="rclone-row"><span class="rclone-label">Web UI de configuração</span>'
        + _rcloneBadge(s.webgui.running, 'ativa :' + s.webgui.port, 'fechada') + '</div>';

      html += '<div class="rclone-actions">';
      if (s.remote_configured) {
        html += '<button class="rclone-action-btn" data-act="rcloneStartWebgui"><svg class="icon-svg"><use href="#i-gear"></use></svg> Abrir configurador</button>';
      }
      if (!s.serve_running && s.remote_configured) {
        html += '<button class="rclone-action-btn primary" data-act="rcloneRestartServe"><svg class="icon-svg"><use href="#i-refresh"></use></svg> Reiniciar streaming</button>';
      }
      if (s.webgui.running) {
        html += '<button class="rclone-action-btn" data-act="rcloneStopWebgui"><svg class="icon-svg"><use href="#i-stop"></use></svg> Fechar web UI</button>';
      }
      html += '<button class="rclone-action-btn" data-act="_loadRcloneStatus"><svg class="icon-svg"><use href="#i-refresh"></use></svg> Atualizar status</button>';
      html += '</div>';
    } else {
      html += '<div class="rclone-help">O rclone não foi encontrado. Rode o instalador do Midnight Media Server '
        + '(ele baixa o rclone sozinho) ou instale manualmente:<br>'
        + '<b>Linux:</b> <code>sudo pacman -S rclone</code> ou <code>sudo apt install rclone</code><br>'
        + '<b>macOS:</b> <code>brew install rclone</code><br>'
        + '<b>Windows:</b> <code>winget install Rclone.Rclone</code><br>'
        + 'Ou baixe em <a href="https://rclone.org/downloads/" target="_blank" rel="noopener">rclone.org/downloads</a></div>';
      html += '<div class="rclone-actions">'
        + '<button class="rclone-action-btn" data-act="_loadRcloneStatus"><svg class="icon-svg"><use href="#i-refresh"></use></svg> Atualizar status</button>'
        + '</div>';
    }

    if (s.webgui.running) {
      html += '<div class="rclone-creds">Web UI aberta — acessível apenas neste computador:<br>'
        + 'URL: <a href="' + escHtml(s.webgui.url) + '" target="_blank" rel="noopener">' + escHtml(s.webgui.url) + '</a><br>'
        + 'Sem login: a interface escuta só em 127.0.0.1.</div>';
    }
    box.innerHTML = html;
  }

  async function rcloneStartWebgui() {
    const box = document.getElementById('rcloneStatus');
    box.innerHTML = '<div class="loading" style="min-height:100px"><div class="spinner"></div><span>Abrindo configurador do rclone...</span></div>';
    try {
      const res = await fetch('/api/rclone/webgui/start', { method: 'POST' });
      const data = await res.json();
      if (data.status === 'ok' && data.url) {
        box.innerHTML = '<div class="rclone-creds"><b><svg class="icon-svg"><use href="#i-check-circle"></use></svg> Configurador aberto!</b><br><br>'
          + 'URL: <a href="' + escHtml(data.url) + '" target="_blank" rel="noopener">' + escHtml(data.url) + '</a><br>'
          + 'Acessível apenas neste computador, sem login.</div>'
          + '<div class="rclone-help">Se a aba não abrir sozinha, clique no link acima e faça login.<br>'
          + '<svg class="icon-svg"><use href="#i-bulb"></use></svg> Cadastre a nuvem em <b>Ajustes &gt; Nuvem</b> — o rclone.conf é escrito pelo próprio app. Esta web UI fica como ferramenta avançada.</div>'
          + '<div class="rclone-actions"><button class="rclone-action-btn" data-act="_loadRcloneStatus"><svg class="icon-svg"><use href="#i-refresh"></use></svg> Verificar status</button></div>';
        window.open(data.url, '_blank');
      } else {
        box.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg class="icon-svg"><use href="#i-error"></use></svg></div><h3>Erro ao abrir configurador</h3><p>' + escHtml(data.error || 'Erro desconhecido') + '</p></div>'
          + '<div class="rclone-actions"><button class="rclone-action-btn" data-act="_loadRcloneStatus"><svg class="icon-svg"><use href="#i-arrow-left"></use></svg> Voltar</button></div>';
      }
    } catch(e) {
      box.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg class="icon-svg"><use href="#i-error"></use></svg></div><h3>Erro ao abrir configurador</h3></div>';
    }
  }

  async function rcloneRestartServe() {
    const box = document.getElementById('rcloneStatus');
    box.innerHTML = '<div class="loading" style="min-height:100px"><div class="spinner"></div><span>Reiniciando streaming...</span></div>';
    try {
      const res = await fetch('/api/rclone/serve/restart', { method: 'POST' });
      const data = await res.json();
      if (data.status === 'ok') {
        showToast('✅ Streaming reiniciado', 'success');
      } else {
        showToast('Erro: ' + (data.error || 'falhou'), 'error');
      }
    } catch(e) {
      showToast('Erro ao reiniciar streaming', 'error');
    }
    _loadRcloneStatus();
  }

  async function rcloneStopWebgui() {
    try {
      await fetch('/api/rclone/webgui/stop', { method: 'POST' });
      showToast('⏹ Web UI fechada', 'info');
    } catch(e) {}
    _loadRcloneStatus();
  }

  async function restoreFromFile(input) {
    const file = input.files[0];
    if (!file) return;
    closeBackupModal();
    showToast('📂 Restaurando backup...', '');
    try {
      // Corpo = o proprio arquivo: o servidor le os bytes crus do zip e aplica
      // o teto de tamanho; em FormData o multipart nunca passou no zipfile
      // (a restauracao falhava sempre com "Falha ao restaurar o backup").
      const res = await fetch('/api/restore', { method: 'POST', body: file });
      const data = await res.json();
      if (data.error) {
        showToast('Erro: ' + data.error, 'error');
      } else {
        showToast('✅ ' + (data.message || 'Backup restaurado!'), 'success');
        setTimeout(() => loadPath(''), 3000);
      }
    } catch(e) {
      showToast('Erro ao restaurar: ' + e.message, 'error');
    }
    input.value = '';
  }

  async function restoreFromCloud() {
    closeBackupModal();
    showToast('☁️ Baixando backup da nuvem...', '');
    try {
      const res = await fetch('/api/restore/b2', { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        showToast('Erro: ' + data.error, 'error');
      } else {
        showToast('✅ ' + (data.message || 'Backup restaurado!'), 'success');
        setTimeout(() => loadPath(''), 3000);
      }
    } catch(e) {
      showToast('Erro ao restaurar: ' + e.message, 'error');
    }
  }

  // ==================== BACKUP / DOWNLOAD ====================
  async function downloadBackup() {
    try {
      showToast('📦 Gerando backup...', '');
      const res = await fetch('/api/backup');
      if (!res.ok) { showToast('Erro ao gerar backup', 'error'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'media-server-backup-' + new Date().toISOString().slice(0,10) + '.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('📦 Backup baixado!', 'success');
    } catch(e) {
      showToast('Erro no backup: ' + e.message, 'error');
    }
  }

  async function backupToCloud() {
    try {
      showToast('☁️ Enviando backup para a nuvem...', '');
      const res = await fetch('/api/backup/b2', { method: 'POST' });
      const data = await res.json();
      if (data.status === 'ok') {
        showToast('☁️ Backup salvo em: ' + data.path, 'success');
      } else {
        showToast('Erro: ' + (data.error || 'falha ao enviar'), 'error');
      }
    } catch(e) {
      showToast('Erro ao enviar: ' + e.message, 'error');
    }
  }

  // ==================== REFRESH CACHE ====================
  let _refreshPollTimer = null;
  let _refreshFallbackTimer = null;
  let _scanProgressTimer = null;

  // Acompanha o scan em andamento: barra de progresso, limpeza dos timers e
  // recarga do catalogo no fim. Usado pelo botao Atualizar e pelo scan de uma
  // fonte so, no modal de Fontes.
  // Ao fim de um scan, diz quantos filmes há (ou que a pasta não rendeu nenhum).
  async function _avisarTotalDeFilmes() {
    try {
      const st = await (await fetch('/api/cache-status')).json();
      const n = st.movies || 0;
      showToast(n ? ('Encontrei ' + n + (n === 1 ? ' filme' : ' filmes') + ' no acervo')
                  : 'Não encontrei filmes nessa fonte. Confira se a pasta tem vídeos.',
                n ? 'success' : 'info');
      const modal = document.getElementById('sourcesModal');
      if (modal && modal.classList.contains('active')) _loadSources();
    } catch (e) {}
  }

  function _watchScanProgress() {
    const btn = document.getElementById('refreshBtn');
    const icon = btn ? btn.querySelector('.icon') : null;
    // Show progress bar
    const pbar = document.getElementById('scanProgressBar');
    const pfill = document.getElementById('scanProgressFill');
    const ptext = document.getElementById('scanProgressText');
    pbar.style.display = 'block';
    pfill.style.width = '0%';
    ptext.textContent = 'Preparando...';

    // Visual feedback: spin icon, highlight text
    if (btn) btn.classList.add('loading');
    if (icon) icon.innerHTML = '<svg class="icon-svg"><use href="#i-refresh"></use></svg>';

    // Start polling scan-progress
    if (_scanProgressTimer) clearInterval(_scanProgressTimer);
    _scanProgressTimer = setInterval(async () => {
      try {
        const r = await fetch('/api/scan-progress');
        const s = await r.json();
        pfill.style.width = s.percent + '%';
        // Com mais de uma fonte, dizer qual esta sendo escaneada agora.
        const srcPrefix = (s.source_total > 1 && s.source_current)
          ? s.source_current + ' — ' : '';
        if (s.phase === 'genres') {
          if (s.movie_index > 0) {
            ptext.textContent = `${srcPrefix}${s.genre_current}: ${s.movie_index} filmes (${s.genre_index}/${s.genre_total})`;
          } else {
            ptext.textContent = `${srcPrefix}${s.genre_index}/${s.genre_total}`;
          }
        } else if (s.phase === 'listing_root') {
          ptext.textContent = s.source_current ? ('Listando ' + s.source_current + '...') : 'Listando raiz...';
        } else if (s.phase === 'done') {
          clearInterval(_scanProgressTimer);
          _scanProgressTimer = null;
          clearInterval(_refreshPollTimer);
          _refreshPollTimer = null;
          clearTimeout(_refreshFallbackTimer);
          _refreshFallbackTimer = null;
          if (btn) btn.classList.remove('loading');
          if (icon) icon.innerHTML = '<svg class="icon-svg"><use href="#i-refresh"></use></svg>';
          pbar.style.display = 'none';
          _frontCache = {};
          _sidebarGenresLoaded = false;
          loadSidebarGenres(true);
          showToast('Escaneamento concluído!', 'success');
          loadPath(currentPath || '');
          _avisarTotalDeFilmes();
        } else if (s.phase === 'error') {
          clearInterval(_scanProgressTimer);
          _scanProgressTimer = null;
          if (btn) btn.classList.remove('loading');
          if (icon) icon.innerHTML = '<svg class="icon-svg"><use href="#i-refresh"></use></svg>';
          pbar.style.display = 'none';
          showToast('Erro ao escanear. Confira a nuvem e as fontes locais.', 'error');
          loadPath(currentPath || '');
        }
      } catch (_) {}
    }, 800);

    // Also poll cache-status as fallback (backward compat)
    let attempts = 0;
    _refreshPollTimer = setInterval(async () => {
      attempts++;
      try {
        const r = await fetch('/api/cache-status');
        const s = await r.json();
        if (s.cached) {
          clearInterval(_refreshPollTimer);
          _refreshPollTimer = null;
          clearInterval(_scanProgressTimer);
          _scanProgressTimer = null;
          clearTimeout(_refreshFallbackTimer);
          _refreshFallbackTimer = null;
          if (btn) btn.classList.remove('loading');
          if (icon) icon.innerHTML = '<svg class="icon-svg"><use href="#i-refresh"></use></svg>';
          pbar.style.display = 'none';
          _frontCache = {};
          _sidebarGenresLoaded = false;
          loadSidebarGenres(true);
          showToast('Escaneamento concluído!', 'success');
          loadPath(currentPath || '');
        }
      } catch (_) {}
      if (attempts > 120) {
        clearInterval(_refreshPollTimer);
        _refreshPollTimer = null;
        clearInterval(_scanProgressTimer);
        _scanProgressTimer = null;
        if (btn) btn.classList.remove('loading');
        if (icon) icon.innerHTML = '<svg class="icon-svg"><use href="#i-refresh"></use></svg>';
        pbar.style.display = 'none';
        loadPath(currentPath || '');
      }
    }, 1500);

    _refreshFallbackTimer = setTimeout(() => {
      clearInterval(_refreshPollTimer);
      _refreshPollTimer = null;
      clearInterval(_scanProgressTimer);
      _scanProgressTimer = null;
      btn.classList.remove('loading');
      if (icon) icon.innerHTML = '<svg class="icon-svg"><use href="#i-refresh"></use></svg>';
      pbar.style.display = 'none';
      _frontCache = {};
      loadPath(currentPath || '');
    }, 240000);

  }

  async function refreshCache() {
    const btn = document.getElementById('refreshBtn');
    const icon = btn.querySelector('.icon');

    try {
      const res = await fetch('/api/refresh', { method: 'POST' });
      const body = await res.json();

      if (body.status === 'already_scanning') {
        showToast('Escaneamento já está em andamento...', 'info');
        return;
      }

      _watchScanProgress();

    } catch(e) {
      btn.classList.remove('loading');
      if (icon) icon.innerHTML = '<svg class="icon-svg"><use href="#i-refresh"></use></svg>';
      document.getElementById('scanProgressBar').style.display = 'none';
      console.error('Refresh failed:', e.message || e);
      loadPath(currentPath || '');
    }
  }

