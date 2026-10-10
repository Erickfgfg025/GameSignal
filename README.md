# GameSignal 📡

Bot do Telegram para pesquisa de ofertas de jogos de PC e monitoramento de preços.

## Estado técnico

O bot em produção está hospedado no Supabase. O GitHub agora contém documentação de auditoria, scripts SQL arquivados e snapshots do código retornado pelo Supabase em 10/10/2026.

- `telegram-webhook`: versão 45, ACTIVE no momento da verificação.
- `check-prices`: versão 28, ACTIVE no momento da verificação.
- `admin-api`: versão 23, ACTIVE no momento da verificação.
- `cakto-webhook`: versão 23, ACTIVE no momento da verificação.
- Lojas de jogos documentadas: Steam, Nuuvem, Green Man Gaming, Epic Games Store e Hype Games.

**Importante:** os snapshots são uma cópia de referência e ainda não são uma estrutura pronta para build/deploy. Um arquivo compartilhado de `cakto-webhook` não pôde ser escrito no GitHub porque a ferramenta bloqueou o conteúdo. Consulte o manifesto do snapshot para os detalhes. Não declare este repositório como reprodução completa da produção até resolver essa pendência e reconciliar os arquivos compartilhados divergentes.

## Documentação

- [Relatório de auditoria e validações](docs/releases/2026-10-10/RELATORIO_AUDITORIA.md)
- [Snapshot do código implantado e manifesto](supabase/deployed-snapshots/2026-10-10/README.md)
- [SQL arquivado da revisão de segurança e índices](docs/releases/2026-10-10/sql/20261010190000_secure_internal_rpc_and_index_foreign_keys.sql)
- [SQL arquivado da integração Hype Games](docs/releases/2026-10-10/sql/20261010204200_enable_hype_games_store.sql)

Os SQLs estão arquivados como registro das alterações já aplicadas remotamente, não como migrações prontas para reaplicação. Antes de transformá-los em migrações ativas, confira o histórico do Supabase.

## Segurança

- Nunca versione tokens do Telegram, chaves privadas, senhas ou arquivos `.env`.
- Use Supabase Secrets para credenciais de produção.
- Não exponha a chave `service_role` em aplicações cliente.
- Confirme o ambiente e o histórico de migrações antes de executar SQL.
- Não faça deploy de snapshots sem reconciliar dependências e executar os testes pertinentes.

## Próximas etapas

1. Recuperar com segurança o arquivo de snapshot que ficou pendente.
2. Comparar e reconciliar versões dos módulos compartilhados.
3. Reconstituir a estrutura canônica `supabase/functions/` sem alterar o comportamento implantado.
4. Recuperar/criar testes reproduzíveis e validar a compilação.
5. Preparar configuração de deploy sem secrets e só então avaliar CI/CD.
