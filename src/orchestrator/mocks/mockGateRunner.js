// Mock Gate Runner — docs/workflow/ADAPTER_INTERFACE.md §3:
// run(verification_commands) -> evidence (test_results, per STATE_MACHINE.md §1 VERIFYING).
//
// `pass` may be a boolean (applies to every command) or a function
// `(command) => boolean` for tests that need one command to fail.

export function createMockGateRunner({ pass = true } = {}) {
  const passFor = typeof pass === 'function' ? pass : () => pass;

  return {
    async run(verificationCommands) {
      const commands = verificationCommands ?? [];
      const results = commands.map((command) => {
        const ok = passFor(command);
        return { command, pass: ok, output: ok ? 'ok' : 'mock failure' };
      });
      return {
        pass: results.every((result) => result.pass),
        results,
      };
    },
  };
}
