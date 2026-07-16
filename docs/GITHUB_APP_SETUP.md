# Private GitHub App setup

Use this checklist only after the VPS preflight is ready. The first release uses a private App installed on explicitly selected personal repositories; do not select all repositories.

## 1. Generate the webhook secret on the VPS

Create the secret file named by `GITHUB_WEBHOOK_SECRET_HOST_FILE` in `.env.vps`. Generate at least 32 random bytes, keep the file mode 0600, and copy the same value into GitHub's App form without storing it in shell history, source control, chat, or documentation.

The implementation validates `X-Hub-Signature-256` over the unmodified request body with HMAC-SHA256 and a timing-safe comparison, matching [GitHub's webhook validation requirements](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

## 2. Register the App

Under the personal account that owns the target repositories, open:

`Settings → Developer settings → GitHub Apps → New GitHub App`

Configure:

| Setting | Value |
| --- | --- |
| GitHub App name | A unique private name, for example `YourName Codex Reviewer` |
| Homepage URL | `https://<WEBHOOK_DOMAIN>` |
| Request user authorization during installation | Off |
| Callback URL | Blank |
| Setup URL | Blank |
| Webhook | Active |
| Webhook URL | `https://<WEBHOOK_DOMAIN>/webhooks/github` |
| Webhook secret | The exact VPS webhook-secret value |
| SSL verification | Enabled |
| Where can this GitHub App be installed? | Only on this account |

GitHub documents that an App restricted to its owning account cannot be installed elsewhere; this is the intended private first-release boundary. See [private GitHub App visibility](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private).

## 3. Set minimum repository permissions

Set every permission not named below to `No access`:

| Repository permission | Access | Used for |
| --- | --- | --- |
| Contents | Read-only | Exact Git fetch of base and PR head refs |
| Pull requests | Read and write | Read current PR state/list open PRs and create advisory reviews |
| Metadata | Read-only | GitHub's standard repository metadata access |

Subscribe only to the `Pull request` event.

GitHub recommends selecting the minimum permissions required. It also documents that HTTP Git access requires Contents permission. See [choosing GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

The App-level Pull requests permission must be read/write, but the service still mints distinct repository-scoped installation tokens: analysis receives Contents read plus Pull requests read, while publishing receives only Pull requests write.

## 4. Record the App ID and generate one private key

After creating the App:

1. Copy the numeric **App ID**, not the Client ID, into `GITHUB_APP_ID` in `.env.vps`.
2. Under the App's `Private keys` section, choose **Generate a private key**.
3. Transfer the downloaded PEM directly to `GITHUB_APP_PRIVATE_KEY_HOST_FILE` on the VPS.
4. Set its owner to the deployment administrator and mode to 0600.
5. Delete unneeded local copies after confirming the protected VPS copy and encrypted recovery procedure.

GitHub stores only the public portion of the generated key and instructs App owners to protect the downloaded PEM and rotate/revoke keys when needed. See [managing GitHub App private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps).

## 5. Install on selected repositories

From the App settings, select `Install App`, choose the owning personal account, then select **Only select repositories** and add only repositories present in `GITHUB_ALLOWED_REPOSITORIES`.

Do not select **All repositories**. GitHub's installation flow supports explicitly selecting repositories for an App with repository permissions. See [installing your own GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app).

The allowlist and the installation selection must match exactly. A repository present in only one of those controls should fail closed rather than be reviewed.

## 6. Run protected preflight

On the VPS, from the project root:

```bash
npm run preflight:vps -- .env.vps
npm run build
npm test
docker compose --env-file .env.vps build
```

The preflight checks only environment structure and filesystem metadata. It does not read or print secret-file contents. Fix every failure before starting services.

## 7. Start and verify the App webhook

Start the stack using `docs/DEPLOYMENT.md`, then return to the App's Advanced settings and inspect recent deliveries. GitHub retains recent delivery details and supports redelivery, which is useful for verifying the initial endpoint. See [viewing webhook deliveries](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries).

The initial delivery must receive a 2xx response over HTTPS. A supported pull-request event should receive `202 Accepted`; invalid signatures must receive `401`. Do not copy private payloads or headers containing signatures into public logs or issues.

Continue with the live checks in `docs/ACCEPTANCE.md` before considering the first release ready.
