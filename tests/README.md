# Testes

```bash
python3 -m pip install pytest
python3 -m pytest tests -q
```

- Nada toca nos seus dados: o `conftest.py` aponta o `HOME` para uma pasta temporária antes de importar o app.
- Nenhum teste sobe o servidor na porta 9187 (o app mata quem estiver nela): o servidor dos testes usa uma porta livre, numa thread.
- `test_frontend.py` precisa do `node`; sem ele esses testes são pulados.

| Arquivo | O que protege |
|---|---|
| `test_paths.py` | leitura de arquivos fora do acervo via rclone, chave de cache |
| `test_netsec.py` | Host e Origin (inclusive outra porta na mesma máquina) |
| `test_scanner.py` | detecção de filmes/séries, rescan idempotente, scan sem nuvem, uso do índice |
| `test_http.py` | permissões por perfil, cabeçalhos, gzip, cache, legendas, token no log |
| `test_pin.py` | limite de tentativas de PIN por perfil, mesmo trocando de IP |
| `test_erros.py` | falhas contornadas pelo app: o valor devolvido nao muda, mas agora avisa no log |
| `test_frontend.py` | `escHtml` (XSS) e sintaxe de cada parte de `static/app/` |
| `test_app_partes.py` | partes do frontend: ordem no `index.html`, funções dos handlers inline e marcador do changelog |

Ao corrigir um bug, escreva primeiro o teste que falha.
