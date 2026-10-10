# GameSignal 📡

Bot do Telegram para pesquisa de ofertas de jogos de PC e monitoramento de preços.

> **Estado do repositório:** este repositório estava vazio quando foi conectado em 10/10/2026. O bot em produção está hospedado no Supabase. Os documentos desta primeira publicação registram uma auditoria do ambiente ativo; eles **não substituem o código-fonte completo** das Edge Functions.

## Registro da release

- Data da auditoria: 10/10/2026
- Edge Function `telegram-webhook`: versão 45, estado ACTIVE no momento da verificação.
- Edge Function `check-prices`: versão 28, estado ACTIVE no momento da verificação.
- Lojas monitoradas: Steam, Nuuvem, Green Man Gaming, Epic Games Store e Hype Games.

## Documentação

- [Relatório de auditoria e validações](docs/releases/2026-10-10/RELATORIO_AUDITORIA.md)
- [SQL arquivado da revisão de segurança e índices](docs/releases/2026-10-10/sql/20261010190000_secure_internal_rpc_and_index_foreign_keys.sql)
- [SQL arquivado da integração Hype Games](docs/releases/2026-10-10/sql/20261010204200_enable_hype_games_store.sql)

Os SQLs estão arquivados como registro das alterações já aplicadas remotamente, não como migrações prontas para reaplicação. Antes de transformá-los em migrações ativas, confira o histórico do Supabase.

## Segurança

- Nunca versione tokens do Telegram, chaves privadas, senhas ou arquivos `.env`.
- Use Supabase Secrets para credenciais de produção.
- Não exponha a chave `service_role` em aplicações cliente.
- Confirme o ambiente e o histórico de migrações antes de executar SQL.

## Próxima etapa técnica

Sincronizar para este repositório o código-fonte efetivamente implantado das Edge Functions, testes e configuração não sensível, para que o GitHub passe a ser uma fonte reproduzível de build e deploy.
