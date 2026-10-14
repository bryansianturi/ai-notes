# Fixing `/health` returning `{"detail":"Not Found"}`

_2026-10-14 · ai-notes on Kubernetes + Argo CD_

## Symptom

```
$ curl localhost:8081/health
{"detail":"Not Found"}
```

> At the time, `web` was a LoadBalancer Service on port 8081. Since PR #9 it is a ClusterIP Service behind a Traefik Ingress. See [Update: Traefik Ingress](#update-traefik-ingress-pr-9).

Expected `{"status":"ok"}`.

## Root cause

The `/health` code was fine. The Kubernetes manifest pointed at a container image built **before** that code was merged.

| Commit | What happened | Image built has `/health`? |
|---|---|---|
| `b8e7013` | PR #3 merged (Argo CD app) | ❌ No |
| `9246f09` | PR #4 merged (adds `/health`) | ✅ Yes |
| PR #5 / #7 | Set `k8s/20-web.yaml` to image `b8e7013…` and readiness probe to `/health` | ❌ Wrong tag |

- FastAPI returns `{"detail":"Not Found"}` for any route it doesn't know.
- Pods running `b8e7013` can never pass the `/health` readiness probe. The rollout hangs ("Progressing") while the old pods keep serving 404s.

**Lesson:** CI tags images with the commit SHA. A manifest has to reference an image built from a commit that **contains** the code change.

## Fix

In `k8s/20-web.yaml`:

```yaml
image: ghcr.io/bryansianturi/ai-notes:9246f0946e12c9a08e79afe7a918ded0efaf13f3
```

Shipped in PR #8 (merged as `30d0dd2`).

## Commands used

### Investigate

```sh
git fetch --all
git log --oneline --graph origin/main -12                # see what actually got merged
git merge-base --is-ancestor <commit> <other> && echo yes # is <commit> included in <other>?
git branch -a --contains <commit>                         # which branches have this commit

kubectl -n ai-notes get deploy web -o jsonpath='{.spec.template.spec.containers[0].image}'
kubectl -n argocd get app ai-notes -o jsonpath='{.status.sync.status} {.status.health.status} {.status.sync.revision}'
kubectl -n ai-notes get pods -o wide

docker manifest inspect ghcr.io/bryansianturi/ai-notes:<sha>   # does this image tag exist?
```

### Ship the fix with the GitHub CLI

```sh
brew install gh
gh auth login --web --git-protocol ssh    # one-time, interactive

git switch -c fix-health-image origin/main
# edit k8s/20-web.yaml
git commit -am "Deploy image that includes /health"
git push -u origin fix-health-image

gh pr create --base main --head fix-health-image --title "..." --body "..."
gh pr checks 8 --watch                     # wait for CI
gh pr merge 8 --merge --delete-branch
```

### Deploy and verify

```sh
# Argo CD checks Git about every 3 minutes. This makes it check now:
kubectl -n argocd annotate app ai-notes argocd.argoproj.io/refresh=normal --overwrite

kubectl -n ai-notes rollout status deploy/web
kubectl -n ai-notes get pods -l app=web \
  -o 'custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[0].ready,IMAGE:.spec.containers[0].image'
kubectl -n ai-notes get ingress web        # wait until ADDRESS is filled in
curl -H "Host: ai-notes.test" localhost/health   # {"status":"ok"}
```

> zsh tip: quote `-o 'custom-columns=...'`. Otherwise zsh treats the `[0]` as a glob pattern and fails with "no matches found".

## Checklist for future deploys

1. Merge the code PR first.
2. Get the merge commit SHA: `git fetch && git rev-parse origin/main`.
3. Wait for CI to push the image, then check it exists with `docker manifest inspect ghcr.io/bryansianturi/ai-notes:<sha>`.
4. Put that SHA in `k8s/20-web.yaml` in a separate PR and merge it.
5. Refresh Argo CD, watch the rollout, then curl the endpoint: `curl -H "Host: ai-notes.test" localhost/health`.

## Update: Traefik Ingress (PR #9)

PR #9 (`e0cec62`) changed the `web` Service from `LoadBalancer` (port 8081) to `ClusterIP` (port 80) and added `k8s/30-ingress.yaml`. That file routes host `ai-notes.test` through Traefik.

- `localhost:8081` no longer works. Go through the Ingress instead: `curl -H "Host: ai-notes.test" localhost/health`.
- `404 page not found` (plain text) comes from **Traefik**, not the app. It means no Ingress rule matched. Either the Ingress doesn't exist yet (Argo CD hasn't synced) or the `Host` header is missing or wrong.
- `{"detail":"Not Found"}` (JSON) comes from **FastAPI**. The request reached the app, but the route doesn't exist in that image.
- To drop the `-H` header, map the hostname to your machine (see below). Then `curl ai-notes.test/health` works and http://ai-notes.test/docs opens in a browser.

### Map `ai-notes.test` in `/etc/hosts`

Run this in a regular Terminal window, **not** through Claude Code's `!` prefix, because `sudo` needs to ask for your password:

```sh
sudo sh -c 'echo "127.0.0.1 ai-notes.test" >> /etc/hosts'
sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder   # clear the macOS DNS cache
```

Check it:

```sh
grep ai-notes /etc/hosts           # should print the new line
ls -la /etc/hosts                  # modified time should be now
curl http://ai-notes.test/health   # {"status":"ok"}
```

`curl: (6) Could not resolve host: ai-notes.test` means the line was never written. If the browser still fails but curl works, try a private window. Browsers cache failed lookups, and Chrome's "Use secure DNS" setting can bypass `/etc/hosts`.

```sh
kubectl get ingressclass                                       # traefik should be listed
kubectl -n ai-notes get ingress web                            # should exist and have an ADDRESS
kubectl -n argocd get app ai-notes -o jsonpath='{.status.sync.revision}'   # should match origin/main
```

## Claude Code notes

- `! <command>` in the Claude Code prompt runs the command yourself in the same session, for interactive steps like `gh auth login`.
- `! sudo ...` can fail silently because it can't prompt for a password, and nothing changes. Run `sudo` commands in a separate terminal.
- Auto mode blocked Claude from running `gh pr merge` ("Merge Without Review"). A human does the final merge, which is a good checkpoint for anything that deploys.
