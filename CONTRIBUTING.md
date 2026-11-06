# Contributing

Thanks for your interest in `selfdocs`.

## License

This is an MIT project. By submitting a pull request you agree that your contribution
is offered under the same MIT terms. No CLA required: inbound equals outbound.

## Before you start

For anything beyond a small bug fix or typo, please **open an issue first**. It avoids
wasted effort if the change doesn't fit the project's direction.

## Making a change

1. Fork the repo and create a branch.
2. Make your change. Keep it focused: one fix or feature per PR.
3. Run the tests before submitting:

   ```sh
   npm test                  # the suite
   npm run test:standalone   # build --mock from the published files, with HOME, PATH and the env stripped
   ```

   Both must pass. They're offline and have no dependencies, so there's no setup: they
   never touch the `claude` CLI or the network (generation runs through `--mock`).

4. Open a pull request with a short description of what changed and why.

## What's in scope

- Bug fixes
- Small, focused improvements to existing behavior
- Corrections to documentation or README examples
- New tests that cover existing behavior

For larger features (new doc types, new CLI verbs, a different storage layout), open
an issue to discuss first. The block-anchor merge is what keeps notes alive, and
changes near it need care.

## The one rule

**Zero runtime dependencies.** If you reach for an npm package, hand-roll it instead.
The whole tool runs on Node built-ins by design.

## The viewer's look

`viewer/index.html` carries [@excellent-so/kit](https://github.com/excellent-so/kit) between the
`/* excellent-kit:begin */` and `/* excellent-kit:end */` markers. Don't edit that block by hand; refresh it
with:

```sh
npx @excellent-so/kit sync viewer/index.html --no-compat --fonts
```

The viewer's own CSS sits after the block and uses only the kit's tokens: no colours of its own, nothing keyed
on the OS colour scheme, and no text under 12px. The tests check all three.
