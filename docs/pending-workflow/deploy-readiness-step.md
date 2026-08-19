# One line to wire the readiness gate into `deploy.yml`

The script `scripts/post-deploy-readiness.sh` is on `main` and runnable today.
Wiring it into the deploy is a **workflow-file change**, which the current PAT
cannot push, so it is held here.

Add as the **last step** of the `deploy` job, after `pm2 start`:

```yaml
      # The deploy currently ends at `pm2 start` and never asks whether the
      # process came back able to serve. On 2026-08-19 that let a process boot
      # without a usable DB password, stay LIVE, and return 500 on every catalog
      # read for over a day while /healthz reported 200.
      - name: Post-deploy readiness
        run: npm run deploy:verify -- "${PORT:-3000}" 90
```

It probes `127.0.0.1/readyz` — never the public origin, which may be served by a
proxy or another instance — retries for 90s while the process boots, and fails
the run with the failing dependency named.

## Until it is wired

Run it by hand on the host after a deploy:

```bash
npm run deploy:verify            # defaults: port 3000, 90s
npm run deploy:verify -- 3000 120
```

## Rollback

TAB 04 also asks for automatic rollback on smoke failure. `deploy.yml` already
snapshots `dist/`, so the step after this one restores that snapshot and
restarts. That is deliberately **not** written here: a rollback that has never
been rehearsed is a second incident, and rehearsing it needs host access.
