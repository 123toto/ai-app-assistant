# NPM release checklist

This checklist is for maintainers publishing the public packages.

## One-time setup

The first `0.1.0` release was published interactively because NPM requires a
package to exist before it can trust a CI publisher. Configure the same GitHub
Actions publisher on each NPM package:

- GitHub owner: `123toto`
- repository: `ai-app-assistant`
- workflow: `publish.yml`
- environment: none
- allowed action: `npm publish`

The workflow uses NPM Trusted Publishing through OIDC. It requires no
`NPM_TOKEN` secret. Do not add an authenticated `.npmrc` to the repository.

## Validate

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm --filter @123toto/ai-app-assistant-contracts pack --dry-run
pnpm --filter @123toto/ai-app-assistant-server pack --dry-run
pnpm --filter @123toto/ai-app-assistant-client pack --dry-run
```

Check that each archive contains only its compiled output, `package.json`, package README and `LICENSE`. The server archive must include the `express`, `nest` and `ai-sdk` entry points without bundling optional Nest dependencies.

## Publish a release

1. Set the same version in `contracts`, `server` and `client`.
2. Commit and push the release-ready source.
3. Create a GitHub Release whose tag is the package version prefixed with `v`,
   for example `v0.2.0`.
4. The `Publish NPM packages` workflow validates, tests, packs and publishes the
   packages in dependency order.

The workflow publishes dependencies before their consumers:

1. `@123toto/ai-app-assistant-contracts`
2. `@123toto/ai-app-assistant-server`
3. `@123toto/ai-app-assistant-client`

The release stops before publishing if the tag and package versions differ or
if any check fails. A rerun skips versions that already exist, allowing recovery
after a partial publication without attempting to overwrite an NPM version.

Trusted Publishing works with public and private GitHub repositories. NPM
generates public provenance automatically only when the repository and packages
are public.

## Interactive fallback

Use interactive publishing only to recover from an unavailable CI workflow:

```bash
pnpm --filter @123toto/ai-app-assistant-contracts pack --pack-destination artifacts/local
pnpm --filter @123toto/ai-app-assistant-server pack --pack-destination artifacts/local
pnpm --filter @123toto/ai-app-assistant-client pack --pack-destination artifacts/local

npm publish artifacts/local/123toto-ai-app-assistant-contracts-<version>.tgz --access public
npm publish artifacts/local/123toto-ai-app-assistant-server-<version>.tgz --access public
npm publish artifacts/local/123toto-ai-app-assistant-client-<version>.tgz --access public
```

Verify the registry after publication:

```bash
npm view @123toto/ai-app-assistant-contracts version
npm view @123toto/ai-app-assistant-server version
npm view @123toto/ai-app-assistant-client version
```

## Validate from the real consumer

1. Replace local `file:` or linked dependencies with the published versions.
2. Regenerate every affected lockfile.
3. Install with the same command and registry configuration used by CI.
4. Build and test both backend and frontend.
5. Run one authenticated assistant request and one administration access check.

When a corporate registry mirrors public NPM with a delay, publish before updating the consumer branch. Confirm that the exact versions are visible through the corporate registry before triggering deployment.
