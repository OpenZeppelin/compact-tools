# Releasing

1. Go to "Release Package" in Actions.
2. Click on the "Run workflow" dropdown menu.
3. Choose the package to release and the version bump type.
   Following [SemVer](https://semver.org/):
   - **Patch** - Backward-compatible bug fixes.
   - **Minor** - New functionality in a backward compatible way.
   - **Major** - Breaking API changes.

4. A maintainer must approve the release before it proceeds.
5. Once approved, the CI will automatically:
   - Run tests.
   - Bump the version.
   - Create a git tag.
   - Publish the package to npm.
6. Once published, go to "Releases" and create a GitHub release using the generated tag.