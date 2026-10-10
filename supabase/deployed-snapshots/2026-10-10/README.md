# Snapshot do código implantado no Supabase

Data da exportação: 2026-10-10. Arquivos recuperados diretamente das versões ativas do projeto Supabase `hrhsjhorkpsfysuesfvq`.

## Funções incluídas

| Função | Versão | Estado | verify_jwt | SHA-256 informado pelo Supabase |
|---|---:|---|---|---|
| `telegram-webhook` | 45 | ACTIVE | false | `2331e2c91bee8a36e64ba8e11949377c2d79b6265c7d8e2a4a30db424dbc0920` |
| `check-prices` | 28 | ACTIVE | false | `51930a63d9ea514e28f99ecdf51be5fae025614e2ee470f2c67efc522699471e` |
| `admin-api` | 23 | ACTIVE | false | `709c711f64fa118b7a43fe6befcbf1d7b11e829298f1df21fec47574e0a127d3` |
| `cakto-webhook` | 23 | ACTIVE | false | `6d025555961de52ae30a6f51d884b1f18b2823d66ae76dda196bd184a0bff5f1` |

## Organização e cuidados

- Cada função tem sua própria cópia de `functions/_shared/`, tal como retornada no snapshot daquela função.
- Arquivos compartilhados divergem entre versões implantadas. As cópias são separadas intencionalmente para evitar misturar implementações.
- Este diretório é um **arquivo fiel de referência**, não uma raiz pronta para `supabase functions deploy`. Antes de usá-lo como fonte de build, é necessário reconciliar dependências compartilhadas, definir a estrutura canônica e executar testes.
- A exportação não altera funções em produção e não inclui valores de secrets.
- Todas as quatro funções estavam com `verify_jwt=false` no momento da consulta. Não mude esse comportamento sem analisar autenticação e chamadores.
- Reconfirme versões antes de qualquer deploy futuro.

## Contagem

- `telegram-webhook`: 10 arquivos
- `check-prices`: 10 arquivos
- `admin-api`: 4 arquivos
- `cakto-webhook`: 6 arquivos
- Total: 30 arquivos de código arquivados.
