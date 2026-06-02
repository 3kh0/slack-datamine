# slack-datamine

Tracks Slack webpack bundle changes.

The miner reads Slack's authed client HTML, extracts the current build metadata and webpack chunk list, downloads the public CDN chunks, and writes the results into `build/`. Each mined build becomes a commit and tag for your convenience.

## What It Writes

`datamine.js` dumps to `build/` on each run and dumps the following:

- API methods and method args
- feature flags and experiments
- error codes, slash commands, and OAuth scopes
- analytics events
- workflow functions and events
- notification types
- AI, MCP, and Block Kit enum values
- trace spans, icon names, shortcuts, dev commands, and UI strings
- `chunks.txt` and `meta.json`

## The Setup

This is an archaic ass setup, but the intended strategy is to have a logged-in Slack desktop client exposing the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) on port 9222.

- `bin/watch-cdp.sh` continuously peeks at the client HTML into
  `queue/html/`.
- `bin/poll.sh` mines queued snapshots in capture order, commits `build/`, tags
  the build, and optionally pushes.
- `bin/snapshot-cdp.js` captures one Slack client snapshot through CDP.
- `bin/reload-cdp.js` reloads or navigates the Slack renderer and reports the
  ready build.

## Local Commands

Create local config:

```sh
cp .env.example .env
```

Mine from a saved Slack client HTML file:

```sh
node datamine.js --html page.html
```

Mine from a live Slack CDP instance:

```sh
node datamine.js --port 9222
```

Queue one snapshot and mine it through the normal poller path:

```sh
node bin/snapshot-cdp.js --port 9222 --dir queue/html --fetch-client
bash bin/poll.sh
```

For quick extractor checks:

```sh
node datamine.js --html page.html --limit 40
node datamine.js --port 9222 --loaded-only
```

## systemd

Systemd can help automate things, the checked-in units run Slack under Xvfb, keep CDP available, watch for new client snapshots, and mine the queue every 30 seconds. Adjust as needed, then install and start:

```sh
install -m 0644 systemd/slack-xvfb.service /etc/systemd/system/slack-xvfb.service
install -m 0644 systemd/slack-cdp.service /etc/systemd/system/slack-cdp.service
install -m 0644 systemd/slack-datamine-watch.service /etc/systemd/system/slack-datamine-watch.service
install -m 0644 systemd/slack-datamine.service /etc/systemd/system/slack-datamine.service
install -m 0644 systemd/slack-datamine.timer /etc/systemd/system/slack-datamine.timer

systemctl daemon-reload
systemctl enable --now slack-xvfb.service slack-cdp.service
systemctl enable --now slack-datamine-watch.service slack-datamine.timer
```

Useful commands:

```sh
systemctl status slack-datamine-watch.service --no-pager
systemctl status slack-datamine.timer --no-pager
journalctl -u slack-datamine-watch.service -u slack-datamine.service -f
```

Set `GIT_PUSH=1` in da `.env` if you want to push commits and tags.

## Notes

- Slack can skip public build numbers sometimes (because fuck logic). The miner logs the numeric gaps, but it cannot backfill a build after Slack stops serving that exact client HTML.
- If Slack serves a lower build number again, the poller commits it as an observed rollback.
- Some manifest chunks can 404 on every run. They are recorded in `meta.json` and skipped after retries.
- Don't use any of the datamines as proof a feature is coming.
