# GameSignal 📡 | Auditoria e correções

**Data:** 10/10/2026  
**Projeto Supabase:** `hrhsjhorkpsfysuesfvq`  
**Status confirmado ao final:** `telegram-webhook` v45 ACTIVE; `check-prices` v28 ACTIVE.

## O que foi implementado

### Pesquisa e experiência do usuário
- A busca normaliza acentos, reduz falsos matches e não seleciona automaticamente um resultado único de baixa confiança.
- A inclusão de jogos agora passa pela função SQL existente de limite do plano; o bot informa quando o limite é atingido.
- O preço-alvo aceita somente formatos válidos (`50`, `49,90`, opcionalmente com `R$`) e possui um limite superior explícito.
- Mensagens comuns não reativam mais usuários que pausaram os alertas.
- Updates que falham durante o processamento são liberados para nova tentativa e retornam HTTP 500 quando possível, em vez de ficarem marcados como processados permanentemente.
- A pesquisa e `/ofertas` usam rate limit por usuário, com janelas de 60 segundos. Se a verificação do rate limit não puder ser confirmada, a ação é bloqueada e o usuário recebe uma mensagem temporária.

### Ofertas e capas
- `/ofertas` reutiliza o cache de capas/sinopses do banco e evita buscas de capa duplicadas para o mesmo jogo na mesma execução.
- A seleção de capa dá preferência a assets maiores da Steam e não recorre à miniatura `tiny_image` quando a consulta de detalhes falha.
- URLs de imagens/ofertas são validadas antes da utilização.
- O ITAD valida valores monetários, moeda, desconto e URLs HTTPS e possui timeout explícito de requisição.
- A integração da Hype Games foi adicionada às duas Edge Functions. O ITAD continua limitado às quatro lojas que realmente fornece; Hype é consultada por um adaptador independente.
- A fonte Hype tem domínio permitido, timeout e concorrência limitada. Para não deixar a varredura automática lenta, o monitor usa consulta direta/cache; a pesquisa interativa pode recorrer à busca mais ampla.
- Se uma fonte de ofertas falhar, uma fonte que respondeu com sucesso continua sendo usada, inclusive quando retornou zero ofertas.

### Monitoramento e notificações
- O motor de alertas testa a condição do usuário em todos os preços por loja e escolhe a oferta mais barata entre as que cumprem o alvo. Antes, a decisão poderia ignorar uma loja que cumprisse a condição se outra loja tivesse preço menor, mas não atingisse o desconto-alvo.
- O `check-prices` usa o lock SQL existente e registra cada ciclo em `job_runs`.
- O agendamento `pg_cron` foi inspecionado e está ativo a cada 30 minutos.

### Banco e segurança
- Seis RPCs privilegiadas tiveram `EXECUTE` removido de `PUBLIC`, `anon` e `authenticated`, permanecendo permitido para `service_role`.
- Criados quatro índices de chaves estrangeiras indicados pelo advisor de performance.
- O `search_path` da função `set_updated_at()` foi fixado.
- A loja Hype (id 101) foi registrada e passou a fazer parte do default para novos usuários. A consulta confirmou que os vetores de lojas dos usuários existentes permaneceram inalterados.

## Validações realmente executadas

- Implantação bem-sucedida e confirmação de status `ACTIVE` das versões v45 e v28.
- Verificações de fonte antes do deploy: validação de valores/URLs do ITAD, timeout de 8 segundos, regras de limite, seleção de oferta por loja, lock do cron, cache de capas, isolamento das falhas entre provedores e preservação das correções anteriores.
- Teste SQL do rate limiter: retornou `true`, `true`, `false` para duas chamadas permitidas e a terceira bloqueada; o registro específico do teste foi removido.
- Consulta de privilégios confirmou `anon=false`, `authenticated=false`, `service_role=true` para as seis RPCs protegidas.
- Consulta dos índices confirmou os quatro índices esperados.
- Uma execução real do `check-prices` na versão otimizada v27 retornou HTTP 200, `gamesChecked=11`, `gamesFailed=0`, `alertsSent=0`, `usersDeactivated=0`, `firstRun=false`; o registro em `job_runs` terminou com `status=success`. A v28 posterior ajustou isolamento de falha entre fontes de ofertas; o caminho de preços usado nessa execução permaneceu inalterado.

## O que não foi possível validar nesta rodada

- A suíte Deno completa (o README informa 61 testes) não foi executada porque `deno` não está instalado neste ambiente.
- Não foi feita uma compra/alerta real ponta a ponta enviando mensagens para um usuário do Telegram. A execução real do ciclo verificou 11 jogos e não encontrou condição que gerasse alerta.
- A leitura da Hype Games depende do HTML público da loja. Mudanças no layout podem exigir ajuste do parser; o monitor automático usa consulta direta para não ampliar excessivamente o tempo do cron e, por isso, pode não achar Hype quando o slug público do produto divergir do título.

## Alertas remanescentes no Supabase

- O advisor ainda sinaliza `pg_net` instalado no schema `public`. Não foi movido porque o agendador atual depende dele e essa migração requer análise específica.
- O advisor informa tabelas com RLS ligado e sem policies. O projeto atual acessa essas tabelas apenas por Edge Functions do lado servidor com `service_role`, e a mesma configuração está documentada no README fornecido. Não foram abertas policies públicas.
- O advisor de performance mostra alguns índices não usados ainda. Nenhum índice foi removido com base apenas nessa observação.

## Observação sobre o código-fonte

Este relatório registra o estado do Supabase verificado em 10/10/2026. O repositório estava vazio no início desta publicação, portanto esta release documental **não contém uma cópia integral das Edge Functions implantadas**. A sincronização do código ativo e dos testes é uma etapa separada.

## Arquivos SQL

Os dois scripts arquivados neste diretório representam mudanças **já aplicadas no Supabase remoto**. Estão em `docs/releases`, fora de `supabase/migrations`, para evitar que sejam interpretados automaticamente como migrações pendentes. Antes de transformá-los em migrações ativas, confira a tabela de histórico de migrações do projeto.
