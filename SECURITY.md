# Security Policy

## Reporting

Please do not open public issues for security vulnerabilities or leaked credentials.

Report security concerns privately to:

contact@rockstarsunlimited.co

Include:

- A short description of the issue.
- Steps to reproduce, if applicable.
- Affected files, commands, or deployment settings.
- Whether you believe credentials or private data may be exposed.

## Scope

Relevant reports include:

- Authentication or upload-token bypasses.
- Accidental secret exposure.
- Unsafe handling of local screenshots or queued uploads.
- R2 object access issues caused by Starshot code.
- CI or release workflow issues that could expose credentials.

Cloudflare account, bucket lifecycle, and public-access rules are controlled by each user. If a report depends on Cloudflare configuration, include the relevant rule or setting.

## Expectations

Starshot is a free open tool maintained on a best-effort basis. Credit is appreciated for responsible reports, and fixes are welcome as private patches or pull requests after disclosure is coordinated.
