// Conventional Commits: type(scope): description
// Scopes mirror the workspace layout so history reads by area of the system.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'build', 'ci', 'chore', 'revert']],
    'scope-enum': [2, 'always', ['domain', 'api', 'web', 'e2e', 'deploy', 'deps', 'repo']],
    'header-max-length': [2, 'always', 72],
  },
};
