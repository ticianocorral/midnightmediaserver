// Modo TV: so com ?tv=1 carrega o css, o polyfill de navegacao espacial e o tv.js.
// Era um <script> inline no index.html; virou arquivo para a CSP poder barrar JS inline.
// O servidor carimba este arquivo com ?v=<maior mtime de tv-boot, tv.js, tv.css e do polyfill>
// (_bust_asset_cache); repassamos o mesmo ?v aos arquivos que ele carrega, para um tv.js novo
// nunca ser servido do cache do navegador (max-age de 1 h) depois de uma atualizacao.
var _tvV = (document.currentScript && document.currentScript.src.split('?')[1]) || '';
function _tvUrl(p) { return _tvV ? p + '?' + _tvV : p; }
if (new URLSearchParams(location.search).get('tv') === '1') {
  var _tvCss = document.createElement('link');
  _tvCss.rel = 'stylesheet';
  _tvCss.href = _tvUrl("/static/tv.css");
  document.head.appendChild(_tvCss);
  // async=false mantem a ordem entre scripts inseridos: o polyfill precisa
  // estar de pe antes do tv.js.
  ["/static/vendor/spatial-navigation-polyfill.js", "/static/tv.js"]
    .forEach(function (src) {
      var s = document.createElement('script');
      s.src = _tvUrl(src);
      s.async = false;
      document.head.appendChild(s);
    });
}
