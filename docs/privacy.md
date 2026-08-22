---
title: Privacy Policy
description: How the Keryx documentation site and the public demo API handle data — analytics, the sandbox environment, and what we do and do not collect.
---

# Privacy Policy

_Last updated: 2026._

Keryx is an open-source software framework. This policy explains how the **Keryx documentation website** (`keryxjs.com`) and the **public demo API** (`api.demo.keryxjs.com` / `www.demo.keryxjs.com`) handle data. The Keryx framework itself, when you install and run it on your own infrastructure, does not send any data to us — you control your own deployment, database, and logs.

## The documentation website

`keryxjs.com` is a static site. It uses **Google Analytics** to understand aggregate traffic (pages viewed, approximate location, device and browser type). This data is processed by Google under its own privacy terms and is used only in aggregate to improve the documentation. We do not sell it or use it to identify individuals. You can block analytics with any standard content blocker or by enabling "Do Not Track" in your browser.

The site sets no advertising cookies and requires no account to read any page.

## The demo API and sandbox

The public demo server exists so you can evaluate the framework without deploying it. If you register a user or post a message there:

- The data you submit (name, email, messages) is stored in the demo database purely to make the demo work.
- **The demo database is periodically reset**, deleting all accounts and messages. Do not store real, sensitive, or personal data in the sandbox.
- Passwords are stored only as salted hashes, never in plaintext.
- Standard server logs (IP address, request metadata) may be retained transiently for abuse prevention and operations.

Because the sandbox is wiped regularly, the simplest way to remove your demo data is to wait for the next reset. For anything urgent, contact us (below).

## Data we do not collect

- We do not sell personal data.
- We do not run third-party advertising networks.
- The framework you download and self-host does not phone home.

## Your choices

- Use a disposable email and a throwaway password in the sandbox.
- Block analytics via your browser or an extension.
- Self-host Keryx to keep all data entirely under your control.

## Contact

Questions about privacy or a data request? Reach the maintainer at [evan@evantahler.com](mailto:evan@evantahler.com), or see the [Contact page](/contact) for more options. Changes to this policy will be published on this page.
