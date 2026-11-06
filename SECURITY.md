# Security policy

## What OmniAtlas is, in security terms

A static site. No backend, no database, no accounts, no cookies, no analytics, no
secrets. The whole app is HTML, JavaScript and data files served from a CDN, and it runs
entirely in your browser.

That removes most of the usual attack surface, and it is worth saying plainly so that
reports land in the right place. There is no login to bypass, no API key to leak, no
server-side injection to find, and no user data to exfiltrate, because none of it exists.

## Supported versions

Only the current deployment of `main` at
[omniatlas-five.vercel.app](https://omniatlas-five.vercel.app). There are no releases and
no maintenance branches; a fix ships by merging to `main`.

## Reporting a vulnerability

Report privately through GitHub:
**[Open a security advisory](https://github.com/AbdulWasayUl/omniatlas/security/advisories/new)**.

Please do not open a public issue for a vulnerability until it is fixed.

Include what you would want to receive: what the flaw is, how to reach it (a share URL
from the address bar is usually enough), what an attacker gets out of it, and anything
you already tried that did not work. A proof of concept is welcome but not required.

You should get an acknowledgement within a few days. This is a small project maintained
by one person, so a fix is best-effort rather than on a clock — you will be told what is
happening either way, and credited in the advisory unless you would rather not be.

## In scope

- Script injection reachable from a share URL, a URL parameter, or a value in one of the
  shipped datasets — anything that gets attacker-controlled text into the DOM or into an
  evaluated context.
- A dependency vulnerability that is actually reachable from the shipped bundle. Say how
  it is reached; a scanner's advisory for a code path the build never runs is not itself
  a finding.
- A build or deployment weakness: asset integrity, the content-hashing pipeline, or
  anything in the configuration that lets a third party serve code from this origin.
- Anything that makes the page attack a visitor's browser or their other tabs.

## Out of scope

- **Wrong astronomical data.** A bad position, distance, name or source is a serious bug
  and the project wants to hear about it — as a
  [data issue](https://github.com/AbdulWasayUl/omniatlas/issues/new?template=data_issue.yml),
  not a security report.
- Missing hardening headers with no demonstrated impact, and scanner output pasted
  without a reachable path.
- Denial of service against your own browser tab: the app renders hundreds of thousands
  of objects, and it is possible to ask it for more than a given GPU can do.
- Anything requiring a compromised device, a malicious browser extension, or physical
  access.
- Vulnerabilities in the upstream catalogues, archives or data sources themselves. Those
  belong with their publishers; the attributions are in the
  [README](README.md#licence-and-attribution).
