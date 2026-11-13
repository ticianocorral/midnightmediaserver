/* Gerador de QR code minimo (modo bytes, correcao M, versoes 1-10), sem
   dependencias: o app funciona offline na rede local. Uso: qrSvg("texto")
   devolve um <svg> pronto, ou "" se o texto nao couber. */
(function () {
  'use strict';
  var ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  var NUM_BLOCKS = [0, 1, 1, 2, 2, 4, 4, 4, 4, 5, 5];

  function rawModules(v) {
    var r = (16 * v + 128) * v + 64;
    if (v >= 2) { var n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
    return r;
  }
  function dataCodewords(v) { return Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[v] * NUM_BLOCKS[v]; }
  function bit(x, i) { return ((x >>> i) & 1) !== 0; }

  function mul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
    return z;
  }
  function divisor(deg) {
    var r = []; for (var i = 0; i < deg - 1; i++) r.push(0); r.push(1);
    var root = 1;
    for (i = 0; i < deg; i++) {
      for (var j = 0; j < r.length; j++) { r[j] = mul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
      root = mul(root, 2);
    }
    return r;
  }
  function remainder(data, div) {
    var r = div.map(function () { return 0; });
    data.forEach(function (b) {
      var f = b ^ r.shift(); r.push(0);
      div.forEach(function (c, i) { r[i] ^= mul(c, f); });
    });
    return r;
  }

  function toBytes(text) {
    var s = unescape(encodeURIComponent(text)), out = [];
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  function encode(bytes) {
    var v, cap;
    for (v = 1; v <= 10; v++) {
      cap = dataCodewords(v) * 8;
      if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= cap) break;
    }
    if (v > 10) return null;
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4); put(bytes.length, v < 10 ? 8 : 16);
    bytes.forEach(function (b) { put(b, 8); });
    put(0, Math.min(4, cap - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (var pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
    var data = [];
    for (var i = 0; i < bits.length; i += 8) {
      var b = 0; for (var k = 0; k < 8; k++) b = (b << 1) | bits[i + k]; data.push(b);
    }
    // blocos + Reed-Solomon + intercalacao
    var nb = NUM_BLOCKS[v], el = ECC_PER_BLOCK[v], raw = Math.floor(rawModules(v) / 8);
    var shortN = nb - raw % nb, shortLen = Math.floor(raw / nb), blocks = [], div = divisor(el), pos = 0;
    for (i = 0; i < nb; i++) {
      var len = shortLen - el + (i < shortN ? 0 : 1);
      var d = data.slice(pos, pos + len); pos += len;
      var e = remainder(d, div);
      if (i < shortN) d.push(0);
      blocks.push(d.concat(e));
    }
    var all = [];
    for (i = 0; i < blocks[0].length; i++) {
      blocks.forEach(function (blk, j) { if (i !== shortLen - el || j >= shortN) all.push(blk[i]); });
    }
    return { v: v, codewords: all };
  }

  function build(v, codewords) {
    var size = v * 4 + 17, m = [], fn = [];
    for (var y = 0; y < size; y++) { m.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
    function set(x, y, c) { m[y][x] = c; fn[y][x] = true; }
    for (var i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    var pos = [];
    if (v > 1) {
      var n = Math.floor(v / 7) + 2, step = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2;
      pos = [6]; for (var p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    }
    pos.forEach(function (a, ia) { pos.forEach(function (b, ib) {
      if ((ia === 0 && ib === 0) || (ia === 0 && ib === pos.length - 1) || (ia === pos.length - 1 && ib === 0)) return;
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++)
        set(a + dx, b + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }); });
    function format(mask) {
      var d = mask, r = d; for (var i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      var bits = ((d << 10) | r) ^ 0x5412;
      for (i = 0; i <= 5; i++) set(8, i, bit(bits, i));
      set(8, 7, bit(bits, 6)); set(8, 8, bit(bits, 7)); set(7, 8, bit(bits, 8));
      for (i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i));
      for (i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i));
      for (i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i));
      set(8, size - 8, true);
    }
    format(0);
    if (v >= 7) {
      var rem = v; for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var vb = (v << 12) | rem;
      for (i = 0; i < 18; i++) { var a = size - 11 + i % 3, b = Math.floor(i / 3); set(a, b, bit(vb, i)); set(b, a, bit(vb, i)); }
    }
    var k = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) for (var j = 0; j < 2; j++) {
        var x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && k < codewords.length * 8) { m[y][x] = bit(codewords[k >>> 3], 7 - (k & 7)); k++; }
      }
    }
    function maskFn(mk, x, y) {
      switch (mk) {
        case 0: return (x + y) % 2 === 0;
        case 1: return y % 2 === 0;
        case 2: return x % 3 === 0;
        case 3: return (x + y) % 3 === 0;
        case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
        case 5: return x * y % 2 + x * y % 3 === 0;
        case 6: return (x * y % 2 + x * y % 3) % 2 === 0;
        default: return ((x + y) % 2 + x * y % 3) % 2 === 0;
      }
    }
    function apply(mk) {
      for (var y = 0; y < size; y++) for (var x = 0; x < size; x++)
        if (!fn[y][x] && maskFn(mk, x, y)) m[y][x] = !m[y][x];
    }
    function penalty() {
      var s = 0, x, y, run, line;
      function lines(get) {
        for (var a = 0; a < size; a++) {
          line = []; for (var b = 0; b < size; b++) line.push(get(a, b) ? 1 : 0);
          run = 1;
          for (b = 1; b < size; b++) {
            if (line[b] === line[b - 1]) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else run = 1;
          }
          var str = line.join('');
          if (str.indexOf('10111010000') >= 0) s += 40;
          if (str.indexOf('00001011101') >= 0) s += 40;
        }
      }
      lines(function (a, b) { return m[a][b]; });
      lines(function (a, b) { return m[b][a]; });
      for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++)
        if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) s += 3;
      var dark = 0; m.forEach(function (r) { r.forEach(function (c) { if (c) dark++; }); });
      s += (Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1) * 10;
      return s;
    }
    var best = 0, bestP = Infinity;
    for (var mk = 0; mk < 8; mk++) {
      apply(mk); format(mk);
      var pn = penalty(); if (pn < bestP) { bestP = pn; best = mk; }
      apply(mk);
    }
    apply(best); format(best);
    return m;
  }

  window.qrSvg = function (text, px) {
    var enc = encode(toBytes(String(text)));
    if (!enc) return '';
    var m = build(enc.v, enc.codewords), n = m.length, d = '';
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++)
      if (m[y][x]) d += 'M' + (x + 4) + ',' + (y + 4) + 'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + (n + 8) + ' ' + (n + 8)
      + '" width="' + (px || 180) + '" height="' + (px || 180) + '" shape-rendering="crispEdges" role="img" aria-label="QR code">'
      + '<rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  };
})();
