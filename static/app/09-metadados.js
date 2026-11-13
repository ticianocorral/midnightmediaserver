  // ==================== ORGANIZAR E METADADOS (TMDB) ====================
  // Substitui o tinyMediaManager: acha filmes fora do padrão numa fonte LOCAL,
  // sugere o filme no TMDB, mostra a prévia do destino ("movies/Título (Ano)/")
  // e só mexe nos arquivos depois de você confirmar. A nuvem é somente leitura.
  // Tudo pode ser desfeito pelo histórico. Ver mediaserver/organizador.py.
  const _org = { aba: 'organizar', source: '', itens: [], escolha: {}, busca: {}, ocupado: false };

  function openScrapeModal() {
    document.getElementById('scrapeModal').classList.add('active');
    document.body.style.overflow = 'hidden';
    _scrapeInicio();
  }
  function closeScrapeModal() {
    document.getElementById('scrapeModal').classList.remove('active');
    document.body.style.overflow = '';
  }
  document.getElementById('scrapeModal').addEventListener('click', function (e) {
    if (e.target === this) closeScrapeModal();
  });

  async function _scrapePost(url, corpo) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                     body: JSON.stringify(corpo || {}) });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok && data.status === 'ok', data: data };
    } catch (e) {
      return { ok: false, data: { error: 'Falha de conexão com o servidor.' } };
    }
  }

  async function _scrapeInicio() {
    const box = document.getElementById('scrapeBox');
    try {
      const st = await (await fetch('/api/scrape/status')).json();
      if (!st.configurado) { _scrapeFormChave(); return; }
      _scrapeAba(_org.aba);
    } catch (e) {
      box.innerHTML = '<div class="user-msg err">Falha ao carregar.</div>';
    }
  }

  function _scrapeFormChave(msg) {
    const ab = '<a target="_blank" rel="noopener noreferrer" href=';
    const cadastro = ab + '"https://www.themoviedb.org/signup">themoviedb.org/signup</a>';
    const painel = ab + '"https://www.themoviedb.org/settings/api">themoviedb.org/settings/api</a>';
    document.getElementById('scrapeBox').innerHTML =
      '<div class="rclone-help">Para mostrar pôster, sinopse, elenco e nota, o app consulta o TMDB '
      + '(a mesma base do Kodi e do Jellyfin). É grátis e leva uns 3 minutos. '
      + 'A chave fica só neste computador.</div>'
      + '<ol class="phone-steps">'
      + '<li>Crie uma conta gratuita: ' + cadastro
      + ' e confirme o e-mail.</li>'
      + '<li>Abra ' + painel
      + ' e peça uma chave (<b>Request an API Key</b>), escolhendo uso <b>pessoal</b>/<b>Developer</b>. '
      + 'O formulário pede um endereço de site: pode usar <code>http://localhost</code>; '
      + 'em descrição, algo como "catálogo pessoal de filmes".</li>'
      + '<li>Copie a <b>Chave da API</b> (<i>API Key</i>, 32 letras e números). '
      + 'Não é o "Token de Acesso de Leitura", que é bem mais comprido.</li>'
      + '<li>Cole aqui embaixo:</li></ol>'
      + '<div class="user-form" style="flex-direction:column;align-items:stretch">'
      + '<input type="password" id="scrapeKeyInput" placeholder="Cole a chave aqui" autocomplete="off">'
      + '<button class="rclone-action-btn primary" data-act="_scrapeSalvarChave">Salvar chave</button></div>'
      + (msg ? '<div class="user-msg err">' + escHtml(msg) + '</div>' : '');
  }

  async function _scrapeSalvarChave() {
    const chave = (document.getElementById('scrapeKeyInput').value || '').trim();
    if (!chave) return;
    // Erros comuns de quem nunca fez isso: colar o token longo ou texto a mais.
    if (chave.length > 40 || chave.indexOf('eyJ') === 0) {
      _scrapeFormChave('Isso parece o "Token de Acesso de Leitura". Use a "Chave da API" (API Key), '
        + 'a menor, com 32 letras e números.');
      return;
    }
    if (!/^[0-9a-fA-F]{32}$/.test(chave)) {
      _scrapeFormChave('A chave tem 32 letras e números (de 0 a 9 e de a a f). Confira se copiou inteira, sem espaços.');
      return;
    }
    const r = await _scrapePost('/api/scrape/key/set', { api_key: chave });
    if (r.ok) _scrapeAba('organizar'); else _scrapeFormChave(r.data.error || 'Não foi possível salvar.');
  }

  function _scrapeAba(aba) {
    _org.aba = aba;
    const abas = [['organizar', 'Organizar'], ['pendentes', 'Sem metadado'], ['historico', 'Histórico'], ['chave', 'Chave TMDB']];
    const barra = '<div class="user-form" style="gap:6px;margin-bottom:12px">'
      + abas.map(a => '<button class="user-btn' + (a[0] === aba ? ' active' : '')
        + '" style="' + (a[0] === aba ? 'background:var(--primary);color:#fff' : '') + '"' + attrAcao('_scrapeAba', [a[0]]) + '>' + a[1] + '</button>').join('')
      + '</div><div id="scrapeCorpo"></div>';
    document.getElementById('scrapeBox').innerHTML = barra;
    if (aba === 'organizar') _orgTela();
    else if (aba === 'pendentes') _scrapePendentes();
    else if (aba === 'historico') _orgHistorico();
    else _scrapeFormChave();
  }

  // ----- Organizar -----
  async function _orgTela() {
    const corpo = document.getElementById('scrapeCorpo');
    corpo.innerHTML = '<div class="loading" style="min-height:80px"><div class="spinner"></div></div>';
    let fontes = [];
    try { fontes = ((await (await fetch('/api/sources')).json()).sources || []).filter(s => s.kind === 'local'); } catch (e) {}
    if (!fontes.length) {
      corpo.innerHTML = '<div class="rclone-help">Nenhuma fonte local cadastrada. O organizador age só em pastas do '
        + 'computador, HD externo ou pendrive (Ajustes › Fontes). A nuvem é somente leitura: organize no disco e copie.</div>';
      return;
    }
    if (!fontes.some(s => s.id === _org.source)) _org.source = fontes[0].id;
    corpo.innerHTML = '<div class="rclone-help">Escolha uma fonte local. O app procura filmes fora do padrão '
      + '<b>movies/Título (Ano)/Título (Ano).mkv</b> e sugere o nome certo pelo TMDB. Nada muda até você '
      + 'confirmar, e dá para desfazer depois. A nuvem não é alterada.</div>'
      + '<div class="user-form"><select id="orgFonte" style="flex:1 1 auto">'
      + fontes.map(f => '<option value="' + escHtml(f.id) + '"' + (f.id === _org.source ? ' selected' : '') + '>'
        + escHtml(f.name) + '</option>').join('')
      + '</select><button class="rclone-action-btn primary" data-act="_orgProcurar">Procurar filmes</button></div>'
      + '<div id="orgLista"></div>';
  }

  async function _orgProcurar() {
    _org.source = document.getElementById('orgFonte').value;
    const lista = document.getElementById('orgLista');
    lista.innerHTML = '<div class="loading" style="min-height:80px"><div class="spinner"></div><span>Procurando...</span></div>';
    const d = await (await fetch('/api/organizar/itens?source=' + encodeURIComponent(_org.source))).json();
    if (d.erro) { lista.innerHTML = '<div class="user-msg err">' + escHtml(d.erro) + '</div>'; return; }
    _org.itens = d.itens || []; _org.escolha = {}; _org.busca = {};
    _orgDesenhar();
  }

  function _orgDesenhar() {
    const lista = document.getElementById('orgLista');
    if (!_org.itens.length) {
      lista.innerHTML = '<div class="user-msg ok" style="margin-top:12px">Tudo certo: nenhum filme fora do padrão nesta fonte.</div>';
      return;
    }
    const n = Object.keys(_org.escolha).length;
    let html = '<div class="rclone-help" style="margin-top:12px">' + _org.itens.length + ' fora do padrão. '
      + '<button class="user-btn" data-act="_orgSugerir">Sugerir para todos</button> '
      + '<span class="src-hint">A sugestão só marca quando título e ano batem; você revisa antes de aplicar.</span></div>';
    for (const it of _org.itens) {
      const esc = _org.escolha[it.origem];
      html += '<div class="user-row" style="flex-wrap:wrap;align-items:flex-start">'
        + '<div class="src-main" style="min-width:0">'
        + '<div class="user-name" style="word-break:break-all">' + escHtml(it.nome)
        + ' <span class="user-tag ' + (it.tipo === 'pasta' ? 'local' : 'cloud') + '">' + (it.tipo === 'pasta' ? 'pasta' : 'arquivo') + '</span></div>'
        + (esc ? '<div class="src-hint" style="color:#a5d6a7">→ ' + escHtml(esc.destino) + '/ · capa: '
               + (esc.sem_capa ? 'nenhuma' : (esc.poster_path ? 'escolhida' : 'padrão do TMDB')) + '</div>'
               : '<div class="src-hint">Palpite: ' + escHtml(it.titulo || '?') + (it.ano ? ' (' + it.ano + ')' : '') + '</div>')
        + '</div>'
        + '<button class="user-btn"' + attrAcao('_orgBuscar', [it.id]) + '>' + (esc ? 'Trocar filme' : 'Buscar') + '</button>'
        + (esc ? '<button class="user-btn"' + attrAcao('_orgAbrirCapas', [it.id]) + '>Capa</button>' : '')
        + (esc ? '<button class="user-btn" title="Tirar da seleção"' + attrAcao('_orgLimpar', [it.id]) + '>✕</button>' : '')
        + '<div id="orgBusca-' + it.id + '" style="flex:1 1 100%"></div>'
        + (_org.capasAberto === it.id && esc ? '<div style="flex:1 1 100%"><button class="user-btn"' + attrAcao('_orgSemCapa', [it.id]) + '>Não baixar capa</button></div>' : '')
        + '<div id="orgCapas-' + it.id + '" style="flex:1 1 100%"></div></div>';
    }
    html += '<div style="margin-top:14px;display:flex;gap:10px;align-items:center">'
      + '<button class="rclone-action-btn primary"' + (n ? '' : ' disabled') + ' data-act="_orgAplicar">Aplicar ' + n
      + (n === 1 ? ' filme' : ' filmes') + '</button><span class="src-hint">Os arquivos são movidos e renomeados na própria fonte.</span></div>'
      + '<div id="orgResultado"></div>';
    lista.innerHTML = html;
    for (const id in _org.busca) if (_org.busca[id]) _orgMostrarCandidatos(id, _org.busca[id]);
    const ab = _org.capasAberto && _orgItem(_org.capasAberto);
    if (ab && _org.escolha[ab.origem]) {
      const e = _org.escolha[ab.origem];
      _capasGrade('orgCapas-' + ab.id, e.tmdb_id, e.poster_path, c => _orgEscolherCapa(ab.id, c));
    }
  }

  function _orgItem(id) { return _org.itens.find(i => i.id === id); }
  function _orgLimpar(id) { const it = _orgItem(id); if (it) delete _org.escolha[it.origem]; _orgDesenhar(); }

  async function _orgBuscar(id, texto) {
    const it = _orgItem(id); if (!it) return;
    const area = document.getElementById('orgBusca-' + id);
    area.innerHTML = '<div class="loading" style="min-height:60px"><div class="spinner"></div><span>Buscando no TMDB...</span></div>';
    const q = (texto !== undefined) ? texto : '';
    const d = await (await fetch('/api/organizar/buscar?source=' + encodeURIComponent(_org.source)
      + '&origem=' + encodeURIComponent(it.origem) + (q ? '&q=' + encodeURIComponent(q) : ''))).json();
    _org.busca[id] = d;
    _orgMostrarCandidatos(id, d);
  }

  function _orgMostrarCandidatos(id, d) {
    const it = _orgItem(id); const area = document.getElementById('orgBusca-' + id);
    if (!it || !area) return;
    const campo = '<div class="user-form" style="margin:8px 0"><input type="text" id="orgQ-' + id + '" value="'
      + escHtml((d && d.consulta) || (it.titulo + (it.ano ? ' ' + it.ano : ''))) + '" style="flex:1 1 auto" '
      + attrAcao('_orgBuscarTecla', [id, {$: 'this'}, {$: 'event'}], false, 'data-act-keydown') + '>'
      + '<button class="user-btn"' + attrAcao('_orgBuscarDoCampo', [id]) + '>Buscar</button>'
      + '<button class="user-btn"' + attrAcao('_orgFecharBusca', [id]) + '>Fechar</button></div>';
    if (!d || d.erro) { area.innerHTML = campo + '<div class="user-msg err">' + escHtml((d && d.erro) || 'Erro.') + '</div>'; return; }
    const c = d.candidatos || [];
    area.innerHTML = campo + (c.length ? c.map((x, i) =>
      '<div class="user-row" style="align-items:flex-start">'
      + (x.poster ? '<img src="' + x.poster + '" alt="" style="width:44px;height:64px;object-fit:cover;border-radius:4px;flex:0 0 auto"' + attrAcao('imgRemover', null, false, 'data-act-error') + '>' : '')
      + '<div class="src-main"><div class="user-name">' + escHtml(x.titulo) + (x.ano ? ' <span style="color:var(--text3);font-weight:400">(' + x.ano + ')</span>' : '') + '</div>'
      + '<div class="src-hint" style="margin:2px 0 0">' + escHtml((x.sinopse || '').slice(0, 130)) + ((x.sinopse || '').length > 130 ? '…' : '') + '</div>'
      + '<div class="src-hint" style="color:#a5d6a7">→ ' + escHtml(x.destino) + '/</div></div>'
      + '<button class="user-btn" style="flex:0 0 auto"' + attrAcao('_orgEscolher', [id, i]) + '>Usar este</button></div>').join('')
      : '<div class="user-msg">Nenhum resultado. Ajuste o texto da busca.</div>');
  }

  function _orgEscolher(id, i) {
    const it = _orgItem(id); const d = _org.busca[id];
    if (!it || !d || !d.candidatos[i]) return;
    const c = d.candidatos[i];
    _org.escolha[it.origem] = { tmdb_id: c.id, destino: c.destino, titulo: c.titulo, poster_path: null, sem_capa: false };
    _org.busca[id] = null;
    _org.capasAberto = id;
    _orgDesenhar();
  }

  // Grade de capas do TMDB: a pessoa escolhe, em vez de ficar com a primeira.
  async function _capasGrade(elId, tmdbId, selecionado, aoEscolher) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.innerHTML = '<div class="loading" style="min-height:60px"><div class="spinner"></div><span>Buscando capas...</span></div>';
    let d;
    try { d = await (await fetch('/api/scrape/capas?tmdb_id=' + encodeURIComponent(tmdbId))).json(); }
    catch (e) { el.innerHTML = '<div class="user-msg err">Falha de conexão.</div>'; return; }
    if (d.erro) { el.innerHTML = '<div class="user-msg err">' + escHtml(d.erro) + '</div>'; return; }
    const capas = d.capas || [];
    if (!capas.length) { el.innerHTML = '<div class="user-msg">O TMDB não tem capas para este filme.</div>'; return; }
    window._capasLista = window._capasLista || {};
    window._capasLista[elId] = { capas: capas, aoEscolher: aoEscolher };
    el.innerHTML = '<div class="src-hint" style="margin:6px 0">Escolha a capa (português primeiro):</div>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:8px">'
      + capas.map((c, i) => '<button type="button" title="' + escHtml((c.idioma || 'sem idioma') + ' · ' + (c.largura || '?') + '×' + (c.altura || '?')) + '" '
        + attrAcao('_capaClicada', [elId, i]) + ' style="padding:0;border:2px solid '
        + (c.path === selecionado ? 'var(--cream)' : 'transparent') + ';border-radius:4px;background:none;cursor:pointer;overflow:hidden;position:relative">'
        + '<img src="' + c.thumb + '" alt="" loading="lazy" style="width:100%;display:block;aspect-ratio:2/3;object-fit:cover">'
        + (c.idioma ? '<span style="position:absolute;left:4px;bottom:4px;font-size:10px;background:rgba(0,0,0,.7);color:#fff;padding:1px 4px;border-radius:3px">' + escHtml(c.idioma) + '</span>' : '')
        + '</button>').join('') + '</div>';
  }

  function _capaClicada(elId, i) {
    const reg = (window._capasLista || {})[elId];
    if (reg && reg.capas[i]) reg.aoEscolher(reg.capas[i].path);
  }

  function _orgEscolherCapa(id, caminho) {
    const it = _orgItem(id); const e = it && _org.escolha[it.origem];
    if (!e) return;
    e.poster_path = caminho; e.sem_capa = false; _org.capasAberto = null;
    _orgDesenhar();
  }

  function _orgSemCapa(id) {
    const it = _orgItem(id); const e = it && _org.escolha[it.origem];
    if (!e) return;
    e.sem_capa = true; e.poster_path = null; _org.capasAberto = null;
    _orgDesenhar();
  }

  function _orgAbrirCapas(id) { _org.capasAberto = (_org.capasAberto === id) ? null : id; _orgDesenhar(); }

  function _orgNorm(t) {
    return (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // Marca sozinho só quando o 1º resultado tem o mesmo título e ano do palpite.
  async function _orgSugerir() {
    if (_org.ocupado) return;
    _org.ocupado = true;
    for (const it of _org.itens) {
      if (_org.escolha[it.origem] || !it.titulo) continue;
      try {
        const d = await (await fetch('/api/organizar/buscar?source=' + encodeURIComponent(_org.source)
          + '&origem=' + encodeURIComponent(it.origem))).json();
        const c = (d.candidatos || [])[0];
        if (c && it.ano && c.ano === it.ano &&
            (_orgNorm(c.titulo) === _orgNorm(it.titulo) || _orgNorm(c.titulo).startsWith(_orgNorm(it.titulo)))) {
          _org.escolha[it.origem] = { tmdb_id: c.id, destino: c.destino, titulo: c.titulo };
        }
      } catch (e) { break; }
      _orgDesenhar();
      await new Promise(r => setTimeout(r, 120));
    }
    _org.ocupado = false;
    _orgDesenhar();
    showToast('Sugestões prontas. Revise e aplique.', 'info');
  }

  async function _orgAplicar() {
    const itens = Object.keys(_org.escolha).map(o => ({ origem: o, tmdb_id: _org.escolha[o].tmdb_id,
      poster_path: _org.escolha[o].poster_path, sem_capa: !!_org.escolha[o].sem_capa }));
    if (!itens.length) return;
    if (!window.confirm('Mover e renomear ' + itens.length + ' filme(s) na fonte? Você pode desfazer depois pelo Histórico.')) return;
    const area = document.getElementById('orgResultado');
    area.innerHTML = '<div class="loading" style="min-height:60px"><div class="spinner"></div><span>Organizando...</span></div>';
    const r = await _scrapePost('/api/organizar/aplicar', { source: _org.source, itens: itens });
    if (!r.ok) { area.innerHTML = '<div class="user-msg err">' + escHtml(r.data.error || 'Erro.') + '</div>'; return; }
    const res = r.data.resultados || [];
    const feitos = res.filter(x => x.ok), falhas = res.filter(x => !x.ok);
    area.innerHTML = '<div class="user-msg ' + (falhas.length ? 'err' : 'ok') + '">' + feitos.length + ' organizado(s)'
      + (falhas.length ? ', ' + falhas.length + ' com problema:<br>' + falhas.map(f => escHtml((f.origem || '') + ': ' + f.erro)).join('<br>') : '.')
      + ' O catálogo está sendo atualizado.</div>';
    feitos.forEach(f => { _org.itens = _org.itens.filter(i => i.origem !== f.origem); delete _org.escolha[f.origem]; });
    showToast(feitos.length + ' filme(s) organizados.', 'success');
  }

  // ----- Histórico -----
  async function _orgHistorico() {
    const corpo = document.getElementById('scrapeCorpo');
    const d = await (await fetch('/api/organizar/historico')).json();
    const ops = d.operacoes || [];
    if (!ops.length) { corpo.innerHTML = '<div class="rclone-help">Nenhuma organização feita ainda.</div>'; return; }
    corpo.innerHTML = ops.map(o => '<div class="user-row" style="align-items:flex-start"><div class="src-main">'
      + '<div class="user-name">' + new Date(o.ts * 1000).toLocaleString('pt-BR') + '</div>'
      + '<div class="src-hint">' + escHtml((o.filmes || []).join(', ')) + '</div></div>'
      + (o.desfeita ? '<span class="user-tag cloud">desfeita</span>'
                    : '<button class="user-btn danger"' + attrAcao('_orgDesfazer', [o.id]) + '>Desfazer</button>')
      + '</div>').join('');
  }

  async function _orgDesfazer(op) {
    if (!window.confirm('Desfazer esta organização? Os arquivos voltam para onde estavam.')) return;
    const r = await _scrapePost('/api/organizar/desfazer', { op: op });
    showToast(r.ok ? 'Desfeito. O catálogo está sendo atualizado.' : (r.data.error || 'Não foi possível desfazer.'), r.ok ? 'success' : 'error');
    _orgHistorico();
  }

  // ----- Trocar a capa de UM filme (ficha do filme; só fonte local) -----
  async function openCapaModal(path, titulo) {
    document.getElementById('scrapeModal').classList.add('active');
    document.body.style.overflow = 'hidden';
    const st = await (await fetch('/api/scrape/status')).json().catch(() => ({}));
    if (!st.configurado) { _scrapeFormChave(); return; }
    const box = document.getElementById('scrapeBox');
    box.innerHTML = '<div class="rclone-help">Escolha o filme certo no TMDB e depois a capa. A capa atual '
      + 'não é apagada: vira <b>poster.anterior.jpg</b> na pasta. Só a capa é baixada, sem fanart.</div>'
      + '<div class="user-form"><input type="text" id="capaQuery" value="' + escHtml((titulo || '').replace(/\s*\(\d{4}\)\s*$/, '').trim()) + '" style="flex:1 1 auto" '
      + attrAcao('_capaBuscarTecla', [{$: 'event'}], false, 'data-act-keydown') + '><button class="rclone-action-btn primary" data-act="_capaBuscar">Buscar filme</button></div>'
      + '<div id="capaCands" style="margin-top:10px"></div><div id="capaGrade" style="margin-top:10px"></div><div id="capaMsg"></div>';
    window._capaAlvo = path;
    _capaBuscar();
  }

  async function _capaBuscar() {
    const q = (document.getElementById('capaQuery').value || '').trim();
    const area = document.getElementById('capaCands');
    area.innerHTML = '<div class="loading" style="min-height:60px"><div class="spinner"></div><span>Buscando no TMDB...</span></div>';
    const d = await (await fetch('/api/scrape/search?path=' + encodeURIComponent(window._capaAlvo) + '&q=' + encodeURIComponent(q))).json();
    if (d.erro) { area.innerHTML = '<div class="user-msg err">' + escHtml(d.erro) + '</div>'; return; }
    const c = d.candidatos || [];
    area.innerHTML = c.length ? c.map(x => '<div class="user-row" style="align-items:center">'
      + (x.poster ? '<img src="' + x.poster + '" alt="" style="width:36px;height:52px;object-fit:cover;border-radius:4px;flex:0 0 auto"' + attrAcao('imgRemover', null, false, 'data-act-error') + '>' : '')
      + '<div class="src-main"><div class="user-name">' + escHtml(x.titulo) + (x.ano ? ' (' + x.ano + ')' : '') + '</div></div>'
      + '<button class="user-btn"' + attrAcao('_capaEscolherFilme', [x.id]) + '>Ver capas</button></div>').join('')
      : '<div class="user-msg">Nenhum resultado. Ajuste o texto da busca.</div>';
  }

  function _capaEscolherFilme(tmdbId) {
    window._capaTmdb = tmdbId;
    _capasGrade('capaGrade', tmdbId, null, caminho => _capaAplicar(caminho));
  }

  async function _capaAplicar(caminho) {
    if (!window.confirm('Usar esta capa? A atual vira poster.anterior.jpg na pasta.')) return;
    const msg = document.getElementById('capaMsg');
    msg.innerHTML = '<div class="loading" style="min-height:40px"><div class="spinner"></div><span>Baixando a capa...</span></div>';
    const r = await _scrapePost('/api/scrape/capa', { path: window._capaAlvo, tmdb_id: window._capaTmdb, poster_path: caminho });
    if (r.ok) {
      msg.innerHTML = '<div class="user-msg ok">Capa trocada. O catálogo está sendo atualizado.</div>';
      showToast('Capa trocada.', 'success');
    } else {
      msg.innerHTML = '<div class="user-msg err">' + escHtml(r.data.error || 'Não foi possível trocar a capa.') + '</div>';
    }
  }

  // ----- Sem metadado (preenche só o banco, e NFO/poster se a pasta for local) -----
  async function _scrapePendentes() {
    const corpo = document.getElementById('scrapeCorpo');
    corpo.innerHTML = '<div class="loading" style="min-height:80px"><div class="spinner"></div></div>';
    const d = await (await fetch('/api/scrape/pendentes')).json();
    const lista = d.pendentes || [];
    if (!lista.length) { corpo.innerHTML = '<div class="rclone-help">Todos os filmes e séries já têm metadado.</div>'; return; }
    corpo.innerHTML = '<div class="rclone-help">' + d.total + ' filme(s)/série(s) sem metadado. Em séries, os episódios também são preenchidos. Em itens da nuvem os dados ficam só no '
      + 'catálogo do app (a nuvem não é alterada); em pastas locais também é gravado o .nfo e o pôster.</div>'
      + lista.map(it => '<div class="user-row"><span class="user-name">' + escHtml(it.name)
        + (it.tipo === 'serie' ? ' <span class="src-hint">(série)</span>' : '') + '</span>'
        + '<button class="user-btn"' + attrAcao('_scrapeAbrirBusca', [enc(it.path), enc(it.name)]) + '>Buscar</button></div>').join('');
  }

  function _scrapeAbrirBusca(pathEnc, nomeEnc) {
    const nome = decodeURIComponent(nomeEnc);
    document.getElementById('scrapeCorpo').innerHTML =
      '<button class="user-btn" data-act="_scrapePendentes">← Voltar</button>'
      + '<div class="user-form" style="margin-top:10px"><input type="text" id="scrapeQuery" value="'
      + escHtml(nome.replace(/\s*\(\d{4}\)\s*$/, '').trim()) + '" style="flex:1 1 auto">'
      + '<button class="rclone-action-btn primary"' + attrAcao('_scrapeBuscar', [pathEnc]) + '>Buscar</button></div>'
      + '<div id="scrapeResultados" style="margin-top:12px"></div>';
    _scrapeBuscar(pathEnc);
  }

  async function _scrapeBuscar(pathEnc) {
    const path = decodeURIComponent(pathEnc);
    const q = (document.getElementById('scrapeQuery').value || '').trim();
    const area = document.getElementById('scrapeResultados');
    area.innerHTML = '<div class="loading" style="min-height:80px"><div class="spinner"></div><span>Buscando no TMDB...</span></div>';
    const d = await (await fetch('/api/scrape/search?path=' + encodeURIComponent(path) + (q ? '&q=' + encodeURIComponent(q) : ''))).json();
    if (d.erro) { area.innerHTML = '<div class="user-msg err">' + escHtml(d.erro) + '</div>'; return; }
    const c = d.candidatos || [];
    area.innerHTML = c.length ? c.map(x => '<div class="user-row" style="align-items:flex-start">'
      + (x.poster ? '<img src="' + x.poster + '" alt="" style="width:44px;height:64px;object-fit:cover;border-radius:4px;flex:0 0 auto"' + attrAcao('imgRemover', null, false, 'data-act-error') + '>' : '')
      + '<div class="src-main"><div class="user-name">' + escHtml(x.titulo) + (x.ano ? ' (' + x.ano + ')' : '') + '</div>'
      + '<div class="src-hint">' + escHtml((x.sinopse || '').slice(0, 140)) + '</div></div>'
      + '<button class="user-btn"' + attrAcao('_scrapeAplicar', [pathEnc, x.id]) + '>Usar este</button></div>').join('')
      : '<div class="user-msg">Nenhum resultado. Ajuste o texto da busca.</div>';
  }

  async function _scrapeAplicar(pathEnc, tmdbId) {
    const r = await _scrapePost('/api/scrape/apply', { path: decodeURIComponent(pathEnc), tmdb_id: tmdbId });
    showToast(r.ok ? 'Metadados aplicados.' : (r.data.error || 'Não foi possível aplicar.'), r.ok ? 'success' : 'error');
    if (r.ok) _scrapePendentes();
  }

  // ==================== CHANGELOG MODAL ====================
  // Só a última entrada é exibida no modal (versões anteriores ficam no README)
  const _CHANGELOG = [
    {
      version: '1.29.0',
      title: 'Primeiro uso guiado, filtro por gênero e vários servidores na rede',
      changes: [
        'Home vazia com o próximo passo e checklist de primeiros passos',
        'Pasta sem a subpasta Media Server pode ser usada como acervo, com seletor de pastas',
        'Guia passo a passo da chave do TMDB, QR code para o celular e dicas de primeira vez',
        'Filtro por gênero do NFO (1º e 2º gênero de cada filme), separado das tags',
        'Dois servidores na mesma rede: backup com o nome da máquina, Bonjour com nome e TV que não troca de servidor sozinha',
      ],
    },
    {
      version: '1.28.2',
      title: 'Correções de segurança (HTTPS, força bruta e senha)',
      changes: [
        'O HTTPS não trava mais com uma conexão parada na rede (afetava também o Chromecast)',
        'Conexões HTTP ociosas passam a ter prazo (slowloris) e o TLS mínimo é 1.2',
        'Limite global de tentativas para o código de instalação e a senha, além do limite por IP',
        'Senhas novas no Python do macOS usam PBKDF2 com 600 mil iterações; as antigas são reprocessadas no login',
        'Content-Length inválido responde 400',
      ],
    },
    {
      version: '1.28.1',
      title: 'Correções de segurança',
      changes: [
        'O perfil infantil não vira mais admin sem a senha da conta',
        'Corrigido XSS no gerenciador de cache e na nota/votos da ficha',
        'Leitura de arquivos de fora do acervo (NFO por symlink) e do ffmpeg com playlists disfarçadas bloqueadas',
        'rclone local passa a exigir senha aleatória por execução',
        'Sair invalida a sessão no servidor e o limite de tentativas de login sobrevive a reinício',
        'Ícone 12:00 AM em todas as versões; instaladores de shell instalam a última release',
      ],
    },
    {
      version: '1.28.0',
      title: 'Segurança, performance e refatoração',
      changes: [
        'Corrige leitura de arquivos da máquina via rclone quando não há nuvem configurada (crítico), XSS do catálogo e fuga da pasta de cache no Windows',
        'Rotas do rclone e do cache só para admin; perfil infantil não burla mais com \'..\'; limite de PIN por perfil; cabeçalhos anti-iframe; Origin estrito em POST',
        'Scanner linear (scan incremental 5x mais rápido), consultas por índice, gzip (catálogo de 348 KB para 26 KB), cache HTTP longo e rclone com menos memória',
        'Miniaturas de pôster também no Linux e Windows (via ffmpeg) e gerenciador de cache bem mais rápido',
        'Landing page nova (GitHub Pages) e frontend dividido em módulos sem JS inline',
        'Erros antes engolidos em silêncio agora aparecem no log; 108 testes automatizados com CI',
      ],
    },
    {
      version: '1.27.4',
      title: 'séries reconhecem episódios soltos e agrupam temporadas',
      changes: [
        'séries reconhecem episódios soltos e agrupam temporadas',
      ],
    },
    {
      version: '1.27.3',
      title: 'Séries reconhecem episódios soltos e agrupam temporadas pelo nome',
      changes: [
        'Episódios soltos na pasta da série ou em subpastas agora aparecem, agrupados por S01E02 no nome',
        'Buscador de metadados (Ajustes > Metadados) agora busca séries no TMDB',
        'Ao aplicar uma série, título, sinopse e miniatura de todos os episódios são gravados',
        'Séries sem metadado de episódio aparecem em “Sem metadado”',
      ],
    },
    {
      version: '1.27.2',
      title: 'v1.27.1 — servidor volta a subir com conta existente; remove Aparência',
      changes: [
        'v1.27.1 — servidor volta a subir com conta existente; remove Aparência',
      ],
    },
    {
      version: '1.27.1',
      title: 'Hotfix: servidor volta a subir com conta existente',
      changes: [
        'Corrige falha na inicialização do app instalado quando já havia conta',
        'Remove a opção Aparência dos Ajustes',
        'Perfil fica abaixo de Ajustes no menu lateral',
      ],
    },
    {
      version: '1.27.0',
      title: 'Instaladores nativos, organizador com capas e próximo episódio',
      changes: [
        'Instaladores nativos (Windows .exe, macOS .dmg, Linux .deb) com Python e rclone embutidos',
        'Fonte Jost embutida: interface igual sem internet',
        'Organizador local e metadados via TMDB: renomeia filmes, escolhe a capa, desfaz; nuvem somente leitura',
        'Próximo episódio com contagem no navegador, no AirPlay e na TV',
      ],
    },
    {
      version: '1.26.0',
      title: 'Player da TV com legenda, capa e nome',
      changes: [
        'Botão Legenda no player da TV: liga/desliga, tamanho e cor',
        'Capa e nome do filme ou série no topo do player',
        'App da TV na versão 1.1',
      ],
    },
    {
      version: '1.25.0',
      title: 'Login único com perfis, avatares e PIN',
      changes: [
        'Um login da casa e tela Quem está assistindo?',
        'Perfis com avatar, perfil infantil e PIN de 4 números',
        'Progresso de exibição separado por perfil',
      ],
    },
    {
      version: '1.24.0',
      title: 'Renomeia para 12:00 Media Server e visual retrô discreto',
      changes: [
        'Novo nome: 12:00 Media Server',
        'Fonte Jost, cantos menores e calço nos cards',
        'Sem breadcrumb; Sair abaixo do videocassete',
        'Remove compatibilidade com instalações do nome antigo',
      ],
    },
    {
      version: '1.23.0',
      title: 'ficha do filme: \'já assisti\' que desmarca, Gêneros viram Tags e o AirPlay emendando episódios',
      changes: [
        'Botão \'Já assisti\' na ficha vira interruptor: marca e desmarca, e o filme sai na hora de Continuar Assistindo',
        '\'Gêneros\' viram \'Tags\' em todo o app (barra lateral, A-Z, modais e mensagens) — a ficha do filme mostra quantas tags ele tem',
        'Chips de gênero da ficha ganham ícone, e as tags do metadado aparecem rotuladas como \'Palavras-chave\'',
        'Assistidos aparecem nos cards: selo verde no A-Z, home, coleções, TAGs e arquivos da ficha — e na linha do episódio, com clique para retirar a marcação',
        'Fim no Chromecast agora marca o episódio/filme como assistido (antes ficava em \'continuar\' para sempre)',
        'Fim do episódio emenda o próximo também fora do Chromecast: no AirPlay e assistindo no navegador a reprodução não para mais na tela final',
        'AirPlay: a TV anuncia o nome do filme/episódio (antes mostrava o nome do app) — vale também para a tela de bloqueio e a central de mídia',
        'AirPlay: a legenda do filme entra no MP4 preparado (mov_text, o formato que o receptor lê embutido) — aparece na TV, ativada pelo controle remoto do Apple TV; o botão CC do app continua mandando na legenda do Chromecast e do player local',
        'Nuvem ensina a converter para a TV: o MKV/HEVC da B2 agora passa pelo mesmo preparo do disco local (e leva a legenda no AirPlay) — o servidor baixa por trás, converte uma vez e serve do cache; custa tráfego da nuvem na primeira vez de cada filete',
      ],
    },
    {
      version: '1.22.0',
      title: 'transmissão sem sustos: capa da série, próximo episódio e vídeo em toda TV',
      changes: [
        'Transmissão: a capa da série aparece no painel e na TV ao transmitir um episódio (o arquivo não tem pôster próprio)',
        'Transmissão: quando o episódio termina, o próximo da série entra sozinho — a TV não fica mais parada na tela final',
        'Transmissão: vídeo HEVC é convertido para H.264 no preparo — era o HEVC 10-bit que deixava a TV com o som rolando e a proteção de tela ligada',
        'AirPlay: a URL enviada à TV é reconstruída do zero — o token velho do player podia duplicar e derrubar a reprodução',
        'Android: o painel não chama mais o aparelho de \'media receiver\' — mostra o nome do Chromecast, ou nada quando o SDK não informa',
        'Coleções e séries: a capa não duplica mais o caminho do arquivo (adeus, pôster 404)',
      ],
    },
    {
      version: '1.21.0',
      title: 'coleções criadas e editadas no próprio app',
      changes: [
        'Botão "Nova coleção": nome, descrição, escolha dos filmes e da capa — sem NFO nem tinyMediaManager',
        'Editar coleção: adicionar/remover filmes, trocar capa, nome e descrição',
        'Coleções vindas de NFO (<set>) são importadas uma única vez, com os mesmos filmes',
        'Gêneros criados na interface, independentes de pastas: atribua pela ficha do filme ou pelo A-Z',
        'Séries: organize em tv shows/Série/Temporada (S01, S02...)/episódios — listagem própria em A-Z, página da série com temporadas e episódios em lista (com legenda)',
        'Continuar assistindo: episódios de série aparecem como lista na home, com retomada no ponto exato',
        'Perfil infantil vira interruptor claro na ficha e na série (marcar a série vale para todos os episódios)',
        'Pasta movies/ na raiz do acervo organiza os filmes (a regra de filme continua valendo fora dela também)',
        'Perfil infantil: conta com modo criança que só vê (e só pode tocar) os filmes marcados — o resto bloqueia até por URL',
        'Marcar/desmarcar filmes para o perfil infantil pela ficha do filme (admin)',
        'Chromecast: tamanho e cor da legenda regulam na TV ao vivo (a escolha fica salva), e o painel de transmissão virou um controle remoto — play, ±10s, Aa e CC',
        'Instalador visual nas 3 plataformas: assistente gráfico no Windows, diálogos nativos no macOS e zenity/kdialog no Linux',
        'Nuvem vira wizard: use qualquer remote do rclone (da lista) ou crie um novo com formulário guiado — B2, Drive, S3, SFTP...',
        'Gênero por pasta sai de vez: filme é qualquer pasta com vídeo direto, na profundidade que for',
        'Filmes soltos (arquivo avulso na pasta) viram filme no A-Z — clique toca direto',
        'Um filme pode estar em várias coleções; quem sai do acervo sai das coleções e dos gêneros no scan',
      ],
    },
    {
      version: '1.20.0',
      title: 'nuvem passa a ser Backblaze B2, configurada pelo próprio app',
      changes: [
        'Google Drive sai do código: a nuvem agora é um bucket Backblaze B2',
        'Cadastro pela interface: keyID, applicationKey e bucket em Ajustes > Nuvem — sem script externo nem OAuth',
        'Backup/restauração vão para o mesmo bucket (com suporte a uma key de escrita separada)',
        'Streaming, cache e fontes locais continuam iguais',
      ],
    },
    {
      version: '1.19.2',
      title: 'migração do prefixo de marca esquecia folders.parent',
      changes: [
        'migração do prefixo de marca esquecia folders.parent',
      ],
    },
    {
      version: '1.19.1',
      title: 'rclone em modo raiz volta a usar o nome real da pasta no Drive',
      changes: [
        'rclone em modo raiz volta a usar o nome real da pasta no Drive',
      ],
    },
    {
      version: '1.19.0',
      title: 'pasta do acervo deixa de exigir o nome TicianoFlix',
      changes: [
        '`LOGICAL_ROOT`: `/TicianoFlix` → `/Mediaflix` — a pasta exigida no Google Drive',
        '`CATALOG_DIR_NAME`: `ticianoflix` → `mediaflix` — a pasta exigida no HD/pendrive, com **compatibilidade retroativa**: quem já tinha criado `TicianoFlix` continua funcionando',
        'Migração de banco automática, uma única vez, na próxima subida do servidor',
        'Textos ajustados para bater com a pasta de verdade (modal de Fontes, painel de rclone, `setup-rclone-seguro.sh`, README)',
      ],
    },
    {
      version: '1.18.0',
      title: 'metadados via TMDB — editor que substitui o tinyMediaManager',
      changes: [
        '`ticianoflix/scraper.py` — cliente TMDB mínimo (`urllib`, sem dependência nova)',
        'Chave gratuita da própria pessoa (**Ajustes › Metadados**), nunca embutida no projeto',
        'Rotas `/api/scrape/status`, `/pendentes`, `/search`, `/apply`, `/key/set` — todas admin',
        '**Ajustes › Metadados**: formulário de chave, lista de filmes sem metadado, busca com resultados, "Usar este" aplica',
      ],
    },
    {
      version: '1.17.0',
      title: 'marca configurável (nome, cor e ícone por instalação)',
      changes: [
        '`ticianoflix/branding.py` — `get()`/`set()` com validação, persistido em `CACHE_DIR/branding.json`',
        'Rotas públicas `/manifest.webmanifest`, `/branding.css`, `/icone-*.png` — geradas em runtime',
        '`/api/branding` (GET) e `/api/branding/set` (POST) — admin, com `Origin` exigido no POST',
        '`<title>`, topbar, sidebar e a tela de login passam a refletir o nome e a cor escolhidos',
        '**Ajustes › Aparência**: nome + seletor de cor, seguindo o padrão visual de Contas/Fontes',
      ],
    },
    {
      version: '1.16.0',
      title: 'instalar o TicianoFlix como app na tela inicial do celular',
      changes: [
        '`static/manifest.webmanifest` — `display: standalone`, `start_url: /`, cor do tema',
        '`static/icons/` — 192, 512, maskable 512 e apple-touch 180',
        '`tools/gerar-icones.py` — gera os ícones a partir do `favicon.svg`',
        'Metatags `apple-*` e `mobile-web-app-capable` no `index.html`',
        'Manifest e ícones passam a responder sem sessão',
        '`mimetypes.add_type` para `.webmanifest`',
      ],
    },
    {
      version: '1.15.0',
      title: 'instalador único (curl | bash), sem exigir git nem log',
      changes: [
        '`install.sh` único, cobrindo Linux e macOS — substitui `install.sh` (Linux) e `install-macos.sh`, que sai do repositório',
        'Serve por `curl -fsSL <url>',
        'bash`, sem clonar nada antes',
        'Não instala nem exige rclone — Drive é 100% opcional',
        'Ao final, espera o servidor responder, lê o código de instalação do log e mostra na tela — ninguém precisa mais abrir arquivo de log — e abre o navegador sozinho',
      ],
    },
    {
      version: '1.14.0',
      title: 'Google Drive deixa de ser pré-requisito (boot de 31s para 0,3s)',
      changes: [
        '`paths.remote_configurado()` — o servidor só tenta subir o `rclone serve` se houver remote',
        '`_porta_responde()` separa "o processo subiu?" de "o Drive respondeu?"',
        'README: Drive sai dos pré-requisitos e vira seção opcional',
        'Exigência cai de Python 3.10+ para **3.9+**',
      ],
    },
    {
      version: '1.13.0',
      title: 'app de Android TV, com a interface da web navegável por controle',
      changes: [
        'Modo TV na web com `?tv=1`: navegação por setas, foco visível e overscan — nada carrega sem a query',
        'Ponte `TicianoFlixTV` no `playMovie()`, desviando o filme para o player nativo quando o app de TV está presente',
        'App de Android TV em Kotlin em `tv/`: WebView + ExoPlayer + descoberta do servidor na rede',
        'Login e `pushState` deixam de descartar a query string da URL',
        '`tv.js` e `tv.css` entram no cache-busting por mtime',
      ],
    },
    {
      version: '1.12.0',
      title: 'coleções de filmes (Star Wars 1-6 e afins)',
      changes: [
        'Item **Coleções** na barra lateral, listando as coleções do acervo',
        'Tela da coleção com os filmes ordenados por ano',
        'Chip na ficha do filme levando para a saga inteira',
        'Rotas `/api/collections` e `/api/collection?name=`',
        'Tabelas `collections` e `movie_collections` — nada alterado nas existentes',
      ],
    },
    {
      version: '1.11.0',
      title: 'AirPlay como alternativa ao Chromecast no iPhone',
      changes: [
        'Botão de AirPlay ao lado do de Chromecast, visível só quando o próprio `<video>` confirma suporte (feature detection via `webkitShowPlaybackTargetPicker`, não user-agent sniffing)',
        'Ao clicar, vídeo e legenda trocam para uma URL assinada (mesmo mecanismo de token do Chromecast) antes de abrir o seletor nativo do iOS',
        '`_fetchMediaToken()` extraído como helper compartilhado entre Cast e AirPlay, no lugar da lógica duplicada',
      ],
    },
    {
      version: '1.10.3',
      title: 'modais e menu lateral cortados no Safari/Chrome do iPhone',
      changes: [
        'modais e menu lateral cortados no Safari/Chrome do iPhone',
      ],
    },
    {
      version: '1.10.2',
      title: 'icone de play do logo quebrava pra linha de baixo no desktop',
      changes: [
        '`.logo-text` ganha `white-space: nowrap` + `flex-shrink: 0`: ícone e nome nunca mais quebram entre si',
        '`.sidebar-header` ganha `flex-wrap: wrap`: quando o selo de versão não cabe do lado, ele desce para uma segunda linha em vez de espremer o logo',
      ],
    },
    {
      version: '1.10.1',
      title: 'wrapper nativo do macOS para de depender de $HOME/TicianoFlix fixo',
      changes: [
        '`ticianoflix-server.c` resolve `server.py` como caminho relativo ao `cwd`, em vez de montar `$HOME/TicianoFlix/server.py`',
      ],
    },
    {
      version: '1.10.0',
      title: 'responsividade real no celular',
      changes: [
        'Barra lateral vira gaveta abaixo de 768px, com barra superior fixa (menu, logo, busca)',
        'Ordem de empilhamento (z-index) organizada numa escala única e documentada',
        'Controles do player reorganizados em duas faixas, com os secundários (volume, velocidade, legenda) num menu "⋯"',
        'Barra de progresso e controle de volume utilizáveis com o dedo',
        'Título do filme sempre visível nos cartazes (antes só aparecia no hover)',
        'Cabeçalho do gênero compacto (de 200px fixos para altura pelo conteúdo)',
        'Toque revela os controles do player (antes dependia de hover/mousemove)',
      ],
    },
    {
      version: '1.9.0',
      title: 'fontes locais — HD externo, pendrive e pastas do computador',
      changes: [
        'Fontes locais: HD externo, pendrive e pastas do computador no mesmo catálogo do Drive',
        'Cadastro por detecção de volumes conectados ou caminho digitado, restrito a administradores',
        'A fonte precisa conter uma pasta `TicianoFlix` (na raiz escolhida ou até dois níveis abaixo), com os gêneros dentro dela',
        'Streaming direto do disco com suporte a Range, para o player conseguir pular no meio do filme',
        'HD desconectado no scan preserva o catálogo daquela fonte em vez de apagá-lo',
        'Menu lateral enxuto: os painéis de manutenção passam a viver num item "Ajustes"',
        'Home com três seções (Últimos Adicionados, Continuar Assistindo, Baixados do Drive) e estatísticas de acervo, fontes conectadas e último scan',
        'Chromecast: legenda corrigida, ficha do filme na TV (pôster, ano, sinopse) e controles do app comandando a transmissão',
      ],
    },
    {
      version: '1.8.0',
      title: 'feat(ui): troca os emojis por ícones SVG em contorno',
      changes: [
        'feat(ui): troca os emojis por ícones SVG em contorno',
      ],
    },
    {
      version: '1.7.0',
      title: 'feat(segurança): reduz o acesso ao Drive ao mínimo necessário',
      changes: [
        'feat(segurança): reduz o acesso ao Drive ao mínimo necessário',
      ],
    },
    {
      version: '1.6.0',
      title: 'Login com contas e hardening de segurança',
      changes: [
        'Login obrigatório: contas com usuário e senha, sessão de 90 dias por aparelho',
        'Primeiro acesso protegido por código de instalação impresso no log do servidor',
        'Painel 👥 Contas para administradores: adicionar, remover, promover e redefinir senha',
        'Chromecast preservado por URL assinada, válida só para aquele arquivo',
        'Fim do CORS aberto e do acesso sem autenticação: Host e Origin validados em toda requisição',
        'Correções: path traversal em /static/, XSS em metadados NFO e rotas destrutivas via GET',
        'rclone serve e configurador passam a escutar apenas em 127.0.0.1',
      ],
    },
    {
      version: '1.5.3',
      title: 'Botão fechar do player',
      changes: [
        'Corrigido modal de confirmação ao fechar o player — abria atrás do vídeo e o botão ✕ parecia não funcionar',
      ],
    },
    {
      version: '1.5.2',
      title: 'Bloqueio do menu durante reprodução',
      changes: [
        'Menu lateral e navegação ao fundo ficam bloqueados enquanto o filme toca (camada do player acima de tudo)',
      ],
    },
    {
      version: '1.5.1',
      title: 'Controles, header e legenda do player',
      changes: [
        'Controles e header somem no fullscreen com o mouse parado (cursor também) — estilo Netflix',
        'Legenda proporcional ao tamanho do player — deixa de ficar gigante ao sair do fullscreen',
        'Cursor de clicável (mãozinha) no breadcrumb do overlay de detalhes',
      ],
    },
    {
      version: '1.5',
      title: 'Busca na sidebar, scan incremental, home reorganizada',
      changes: [
        'Busca movida para a sidebar (acima de Início), com resultados ao vivo enquanto digita e botão limpar (✕)',
        'Resultados de busca em grade única, sem mostrar as pastas dos filmes',
        'Atualização (scan) incremental: só busca filmes novos/alterados e remove os apagados — ~2s em vez de ~40s',
        'Barra de progresso do scan mais compacta',
        'Home reorganizada: Últimos Adicionados (máx. 7) → Continuar Assistindo → Offline',
        'Acesso rápido ao rclone via ☁️ ao lado do uso de cache; menu: Atualizar, Backup, Gerenciar Cache, Limpar Cache',
      ],
    },
  ];

  function openChangelogModal() {
    document.getElementById('changelogModal').classList.add('active');
    document.body.style.overflow = 'hidden';
    const latest = _CHANGELOG[0];
    let html = '<div style="font-size:18px;font-weight:800;color:var(--text);margin-bottom:2px">'
      + 'v' + escHtml(latest.version) + ' — ' + escHtml(latest.title) + '</div>';
    html += '<ul style="margin:10px 0 0;padding-left:20px;font-size:13px;color:var(--text2);line-height:1.8">';
    latest.changes.forEach(c => { html += '<li>' + escHtml(c) + '</li>'; });
    html += '</ul>';
    document.getElementById('changelogContent').innerHTML = html;
  }
  function closeChangelogModal() {
    document.getElementById('changelogModal').classList.remove('active');
    document.body.style.overflow = '';
  }
  document.getElementById('changelogModal').addEventListener('click', function(e) {
    if (e.target === this) closeChangelogModal();
  });

  async function _loadRcloneStatus() {
    const box = document.getElementById('rcloneStatus');
    box.innerHTML = '<div class="loading" style="min-height:100px"><div class="spinner"></div><span>Verificando status do rclone...</span></div>';
    try {
      // Os dois painéis juntos: o status do rclone e o cadastro da nuvem.
      const [resR, resB] = await Promise.all([
        fetch('/api/rclone/status'),
        fetch('/api/nuvem/status').catch(() => null),
      ]);
      const s = await resR.json();
      let nuvem = null;
      if (resB) { try { nuvem = await resB.json(); } catch (e) { nuvem = null; } }
      _renderRcloneStatus(box, s, nuvem);
    } catch(e) {
      box.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg class="icon-svg"><use href="#i-error"></use></svg></div><h3>Erro ao verificar status</h3></div>';
    }
  }

  function _rcloneBadge(ok, textOk, textBad) {
    return ok
      ? '<span class="rclone-badge ok"><svg class="icon-svg"><use href="#i-check"></use></svg> ' + textOk + '</span>'
      : '<span class="rclone-badge bad"><svg class="icon-svg"><use href="#i-close"></use></svg> ' + textBad + '</span>';
  }

