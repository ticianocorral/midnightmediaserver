  // ==================== INIT ====================
  loadPath("", true);
  loadSidebarGenres();
  // Sync _cachedSet with server's actual cache state (for offline section on home)
  _syncCachedFromServer().then(() => _renderOfflineGrid());

  // Fetch cache usage
  async function updateCacheUsage() {
    try {
      const r = await fetch('/api/cache-status');
      const s = await r.json();
      if (s.usage) {
        const t = s.usage.total;
        let h = '';
        if (t < 1024) h = t + 'B';
        else if (t < 1048576) h = (t / 1024).toFixed(1) + 'K';
        else if (t < 1073741824) h = (t / 1048576).toFixed(1) + 'M';
        else h = (t / 1073741824).toFixed(2) + 'G';
        if (s.usage.details.vfs > 0) h += ' (VFS)';
        document.getElementById('cacheUsageSize').textContent = h;
      }
    } catch(_) {}
  }
  updateCacheUsage();
  // Aba oculta nao precisa do contador: com o app aberto em TV, celular e
  // notebook, o /api/cache-status de 30 em 30s virava consulta constante
  // sem ninguem olhando. Ao reaparecer, atualiza na hora.
  setInterval(() => { if (!document.hidden) updateCacheUsage(); }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) updateCacheUsage();
  });

  // Quem esta logado: mostra o nome no botao Sair e revela "Contas" para admin.
  _loadMe();
