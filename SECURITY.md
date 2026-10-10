# Security policy

## Secrets

Never commit real credentials, API keys, bot tokens, passwords, database URLs with credentials, private keys, or production environment files.

Use Supabase Secrets or GitHub Actions Secrets for deployment credentials. Read environment variables at runtime. Keep only clearly fake placeholders in examples, such as `YOUR_TOKEN_HERE`.

The repository's `.gitignore` excludes common environment and private-key files, but **.gitignore is not a secret detector** and does not remove files already tracked or erase Git history.

## If a secret is exposed

1. Revoke or rotate it immediately at the provider. Deleting the text from the latest commit is not enough.
2. Check provider logs and usage for unauthorized activity.
3. Remove the secret from tracked files and, if necessary, coordinate a Git history rewrite. Rewriting history does not replace rotation.
4. Review GitHub's **Security** tab and secret-scanning alerts, if available for this repository.
5. Do not paste the secret into issues, commits, chat messages, or audit reports.

## Reporting

Report suspected exposures privately to the repository maintainer. Do not open a public issue containing credentials or exploit details.

## Audit scope

Static pattern scans can miss unknown token formats, secrets encoded or split across strings, and credentials in external systems. A clean scan is not a guarantee that credentials were never exposed. Verify provider-side secret-scanning alerts and rotate any credential suspected of prior exposure.
