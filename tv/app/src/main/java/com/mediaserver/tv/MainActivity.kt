package com.mediaserver.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.view.View
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.Button
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * A interface e a propria web do Midnight Media Server, carregada com ?tv=1 — o modo que
 * torna tudo navegavel pelo controle. Reconstruir as telas em Kotlin daria uma
 * segunda interface para manter; assim a TV herda cada novidade da web.
 *
 * A unica coisa que nao acontece na WebView e tocar o filme: para isso a pagina
 * chama MediaServerTV.play() e quem assume e o ExoPlayer.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var aviso: View
    private lateinit var botaoAtualizar: Button

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val base = Servidor.salvo(this) ?: run {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)

        web.settings.javaScriptEnabled = true
        // O app usa localStorage; sem isto ele falha calado.
        web.settings.domStorageEnabled = true

        // A WebView herda o tamanho de fonte do sistema ("textZoom"); com a
        // fonte da TV em um nivel alto a pagina inteira estufa como se tivesse
        // recebido 125%. Travar em 100 deixa a escala nas maos do viewport.
        web.settings.textZoom = 100
        // Sem isto a WebView ignora o <meta viewport width=...> do modo TV e a
        // pagina renderiza em 960px CSS (densidade 2): tudo 2x maior.
        web.settings.useWideViewPort = true
        web.settings.loadWithOverviewMode = true
        // Mesmo valor do viewport de static/tv.js, fixo: a WebView so aplica a
        // escala sozinha se a pagina carregar depois.
        aplicarEscala()

        // O cookie de sessao vale 90 dias, mas so sobrevive a fechar o app se
        // for gravado em disco. Sem o flush do onPause, cada abertura do app
        // pediria login de novo — com o teclado da TV, no controle remoto.
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)

        web.addJavascriptInterface(Ponte(), "MediaServerTV")
        // WebViewClient padrao para a navegacao ficar dentro do app em vez de
        // abrir o navegador do sistema.
        aviso = findViewById(R.id.desconectado)
        botaoAtualizar = findViewById(R.id.atualizar)
        botaoAtualizar.setOnClickListener { atualizar(base) }

        web.webViewClient = object : WebViewClient() {
            // So a pagina principal: falha de imagem ou de outro recurso nao
            // pode derrubar a interface inteira.
            override fun onReceivedError(
                view: WebView, request: WebResourceRequest, error: WebResourceError
            ) {
                if (request.isForMainFrame) mostrarAviso()
            }

            override fun onReceivedHttpError(
                view: WebView, request: WebResourceRequest, resposta: WebResourceResponse
            ) {
                if (request.isForMainFrame && resposta.statusCode >= 500) mostrarAviso()
            }

            // A WebView so navega dentro do servidor que o dono escolheu. Qualquer outra pagina
            // (link externo, redirect, location injetado por XSS) carregada aqui enxergaria a
            // ponte MediaServerTV e poderia mandar o player tocar uma URL qualquer.
            // true = bloqueia a navegacao.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val permitido = mesmaOrigemDoServidor(request.url.toString())
                if (!permitido) {
                    Log.w("Midnight Media Server", "navegacao bloqueada: ${request.url}")
                    return true
                }
                // Trocar de perfil passa por /perfis e volta para "/" sem ?tv=1: a pagina
                // perdia o modo TV e a escala, entao o ?tv=1 e reposto.
                if (!request.isForMainFrame || request.url.getQueryParameter("tv") != null) return false
                view.loadUrl(request.url.buildUpon().appendQueryParameter("tv", "1").build().toString())
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                aplicarEscala()
            }
        }
        web.loadUrl("$base/?tv=1")

        // Endereco salvo pode ter ficado velho (o roteador troca o IP do Mac) ou
        // o servidor estar desligado: em vez de tela escura, mostra o aviso com
        // o botao Atualizar, que tambem re-escaneia a rede.
        lifecycleScope.launch {
            val nome = Servidor.identificar(base)
            if (nome == null) {
                Log.w("Midnight Media Server", "servidor salvo $base nao responde")
                mostrarAviso()
            } else if (Servidor.nomeSalvo(this@MainActivity) == null && nome.isNotEmpty()) {
                // Instalacao antiga: aprende o nome agora, para reconhecer o servidor depois.
                Servidor.salvar(this@MainActivity, base, nome)
            }
        }

        // O Voltar do controle anda no historico da pagina (a navegacao e
        // pushState) e so sai do app quando nao ha mais para onde voltar.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else finish()
            }
        })
    }

    /** True se [url] tem o mesmo esquema, host e porta do servidor salvo. */
    private fun mesmaOrigemDoServidor(url: String): Boolean {
        val salvo = Servidor.salvo(this) ?: return false
        val a = android.net.Uri.parse(salvo)
        val b = android.net.Uri.parse(url)
        return a.scheme == b.scheme && a.host == b.host && a.port == b.port
    }

    private fun mostrarAviso() {
        aviso.visibility = View.VISIBLE
        botaoAtualizar.requestFocus()
    }

    /**
     * Tenta o endereco salvo; se morreu, varre a rede (o IP pode ter mudado).
     * Achando, recarrega a pagina e some com o aviso.
     */
    private fun atualizar(base: String) {
        botaoAtualizar.isEnabled = false
        botaoAtualizar.setText(R.string.atualizando)
        lifecycleScope.launch {
            var destino: String? = if (Servidor.responde(base)) base else null
            if (destino == null) {
                val achados = Servidor.procurarDetalhado()
                val nomeSalvo = Servidor.nomeSalvo(this@MainActivity)
                // So troca sozinho quando da para ter certeza de que e o mesmo
                // servidor com outro IP. Com outro computador na rede, pergunta.
                val mesmo = if (!nomeSalvo.isNullOrEmpty()) achados.firstOrNull { it.nome == nomeSalvo }
                            else achados.singleOrNull()
                if (mesmo != null) {
                    destino = mesmo.base
                    Servidor.salvar(this@MainActivity, mesmo.base, mesmo.nome.ifEmpty { nomeSalvo ?: "" })
                } else if (achados.isNotEmpty()) {
                    startActivity(Intent(this@MainActivity, SetupActivity::class.java))
                    finish()
                    return@launch
                }
            }
            botaoAtualizar.isEnabled = true
            botaoAtualizar.setText(R.string.atualizar)
            if (destino != null) {
                aviso.visibility = View.GONE
                web.loadUrl("$destino/?tv=1")
            } else {
                botaoAtualizar.requestFocus()
            }
        }
    }

    // Com o player aberto, esta Activity fica por baixo e a pagina continuaria
    // rodando (JS, timers, animacoes) disputando CPU e GPU com o video — num chip
    // simples isso tira a fluidez. Pausar a WebView enquanto o player esta na frente.
    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
        web.onPause()
        web.pauseTimers()
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        web.resumeTimers()
    }

    /** O que a pagina enxerga como window.MediaServerTV. */
    inner class Ponte {
        /**
         * Chamado por app.js no lugar de abrir o player da pagina.
         *
         * Roda numa thread do WebView, nao na de interface: por isso o
         * runOnUiThread antes de abrir a Activity.
         */
        @JavascriptInterface
        fun play(json: String) {
            val dados = try {
                JSONObject(json)
            } catch (e: Exception) {
                Log.w("Midnight Media Server", "play(): json invalido: $json")
                return
            }
            Log.i("Midnight Media Server", "play(): url=${dados.optString("url")} legenda=${dados.optString("legenda")} posicao=${dados.optLong("posicao", 0L)}")
            val i = Intent(this@MainActivity, PlayerActivity::class.java)
                .putExtra(PlayerActivity.EXTRA_URL, dados.optString("url"))
                .putExtra(PlayerActivity.EXTRA_LEGENDA, dados.optString("legenda"))
                .putExtra(PlayerActivity.EXTRA_POSICAO, dados.optLong("posicao", 0L))
                .putExtra(PlayerActivity.EXTRA_TITULO, dados.optString("titulo"))
                .putExtra(PlayerActivity.EXTRA_CONTEXTO, dados.optString("contexto"))
                .putExtra(PlayerActivity.EXTRA_CAPA, dados.optString("capa"))
                .putExtra(PlayerActivity.EXTRA_LEG_TAM, dados.optInt("legTam", 2))
                .putExtra(PlayerActivity.EXTRA_LEG_COR, dados.optInt("legCor", 0))
                .putExtra(PlayerActivity.EXTRA_PATH, dados.optString("path"))
                .putExtra(PlayerActivity.EXTRA_FILA, dados.optJSONArray("fila")?.toString() ?: "[]")
            runOnUiThread { startActivityForResult(i, COD_PLAYER) }
        }
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requisicao: Int, resultado: Int, dados: Intent?) {
        super.onActivityResult(requisicao, resultado, dados)
        if (requisicao != COD_PLAYER || resultado != Activity.RESULT_OK || dados == null) return
        val posicao = dados.getLongExtra(PlayerActivity.EXTRA_POSICAO, 0L)
        val duracao = dados.getLongExtra(PlayerActivity.EXTRA_DURACAO, 0L)
        val legTam = dados.getIntExtra(PlayerActivity.EXTRA_LEG_TAM, -1)
        val legCor = dados.getIntExtra(PlayerActivity.EXTRA_LEG_COR, -1)
        // Episodios que o player emendou antes de sair, e o que estava tocando ao sair.
        val saidas = dados.getStringExtra(PlayerActivity.EXTRA_SAIDAS) ?: "[]"
        val atual = JSONObject.quote(dados.getStringExtra(PlayerActivity.EXTRA_ATUAL).orEmpty())
        // Quem decide se vale gravar e a propria pagina: ela ja ignora os
        // primeiros segundos e limpa o progresso de um filme terminado.
        web.evaluateJavascript("window.tvPlaybackEnded($posicao, $duracao, $legTam, $legCor, $saidas, $atual)", null)
    }

    private fun aplicarEscala() {
        val dm = resources.displayMetrics
        web.setInitialScale((dm.widthPixels / LARGURA_CSS / dm.density * 100).toInt())
    }

    companion object {
        private const val LARGURA_CSS = 1670f
        private const val COD_PLAYER = 1
    }
}
